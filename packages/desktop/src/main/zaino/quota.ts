/**
 * Quota — token-limit accounting for the Zaino gateway.
 *
 * The gateway's only customer-facing limit is TOKENS per alias per billing
 * period (portal migration 0023). The portal serves that state at
 * `GET {portal}/api/device/usage`, which authenticates with the same `zn-`
 * key the app already holds — no browser session, no PII, no spend figures.
 *
 * The pure decision logic lives here so it can be unit-tested without a
 * network: `deriveQuota` takes the snapshot and returns one render state.
 * This mirrors portal/lib/entitlements/quota.ts, which sums a row's
 * input + output + cache tokens into one blended number per alias.
 *
 * Units: RAW TOKENS as the ledger stores them (integers, NOT millions).
 */

export interface UsageSnapshot {
  planCode: string | null
  models: string[]
  /** Per-alias blended-token budgets (raw tokens). Missing = unlimited. */
  tokenLimits: Record<string, number>
  /** Blended tokens used per alias in the current window. */
  tokensByModel: Record<string, number>
  /** Tokens left per alias, clamped at 0. */
  remainingTokensByModel: Record<string, number>
  /** Aliases with no tokens left. */
  tokenExhausted: string[]
  /** Why each entitled alias is unavailable, or null when usable. */
  exhaustedByModel: Record<string, "tokens" | null>
  periodStart: string
  periodEnd: string
}

export type QuotaState =
  | { _tag: "Unknown" }
  | {
      _tag: "Ok"
      models: string[]
      remaining: Record<string, number>
      limits: Record<string, number>
    }
  | { _tag: "Exhausted"; models: string[] }
  | { _tag: "Unauthorized" }
  | { _tag: "Error"; message: string }

/** The alias that will run out first — the one to warn about. */
export function tightest(limits: Record<string, number>, used: Record<string, number>): string | null {
  let tightestAlias: string | null = null
  let highest = -1

  for (const [alias, limit] of Object.entries(limits)) {
    if (!Number.isFinite(limit) || limit <= 0) continue
    const consumed = used[alias] ?? 0
    const ratio = consumed / limit
    if (ratio > highest) {
      highest = ratio
      tightestAlias = alias
    }
  }

  return tightestAlias
}

export function deriveQuota(snapshot: UsageSnapshot | null, error?: string): QuotaState {
  if (error === "unauthorized") return { _tag: "Unauthorized" }
  if (error) return { _tag: "Error", message: error }
  if (!snapshot) return { _tag: "Unknown" }

  const limits = snapshot.tokenLimits ?? {}
  const used = snapshot.tokensByModel ?? {}

  // Trust the portal's exhausted list, and verify it: an alias the numbers
  // show as spent is exhausted even if the list omitted it.
  const listed = new Set(snapshot.tokenExhausted ?? [])
  const exhausted = Object.entries(limits)
    .filter(([, limit]) => Number.isFinite(limit) && limit > 0)
    .filter(([alias, limit]) => listed.has(alias) || (used[alias] ?? 0) >= limit)
    .map(([alias]) => alias)

  if (exhausted.length > 0) return { _tag: "Exhausted", models: exhausted }

  const remaining: Record<string, number> = {}
  for (const [alias, limit] of Object.entries(limits)) {
    remaining[alias] = Math.max(0, limit - (used[alias] ?? 0))
  }

  return { _tag: "Ok", models: snapshot.models ?? [], remaining, limits }
}

/** True when the alias has tokens left. An alias with no limit is unlimited. */
export function canUse(snapshot: UsageSnapshot | null, alias: string): boolean {
  if (!snapshot) return true
  const limit = snapshot.tokenLimits?.[alias]
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return true
  return (snapshot.tokensByModel?.[alias] ?? 0) < limit
}

function recordOf(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const out: Record<string, number> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "number" && Number.isFinite(entry)) out[key] = entry
  }
  return out
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

/**
 * Read the portal's usage ledger for this key.
 *
 * Parses tolerantly: the portal may add fields, and an older portal may
 * omit the token fields. Missing numbers mean unlimited, never zero — a
 * parse gap must fail OPEN (the app stays usable) rather than fail closed
 * (the app signs the user out). Only a 401 fails closed: the key is dead
 * and the app must prompt for sign-in again.
 *
 * A tolerant parse is what keeps a signed-in user signed in. The sign-in
 * gate treats any throw other than "unauthorized" as signed-out, so this
 * function must throw ONLY on a dead key or an unreachable portal — never
 * on a shape it does not recognise.
 */
export async function fetchUsage(portalUrl: string, key: string): Promise<UsageSnapshot> {
  const res = await fetch(`${portalUrl}/api/device/usage`, {
    headers: { Authorization: `Bearer ${key}` },
  })
  if (res.status === 401) throw new Error("unauthorized")
  if (res.status === 429) throw new Error("quota_exhausted")
  if (!res.ok) throw new Error(`usage request failed: ${res.status}`)
  const body = (await res.json()) as Record<string, unknown>
  return {
    planCode: typeof body["planCode"] === "string" ? body["planCode"] : null,
    models: stringsOf(body["models"]),
    tokenLimits: recordOf(body["tokenLimits"]),
    tokensByModel: recordOf(body["tokensByModel"]),
    remainingTokensByModel: recordOf(body["remainingTokensByModel"]),
    tokenExhausted: stringsOf(body["tokenExhausted"]),
    exhaustedByModel: (() => {
      const raw = body["exhaustedByModel"]
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
      const out: Record<string, "tokens" | null> = {}
      for (const [alias, reason] of Object.entries(raw as Record<string, unknown>)) {
        out[alias] = reason === "tokens" ? "tokens" : null
      }
      return out
    })(),
    periodStart: typeof body["periodStart"] === "string" ? body["periodStart"] : "",
    periodEnd: typeof body["periodEnd"] === "string" ? body["periodEnd"] : "",
  }
}

/**
 * The gateway's model catalog: which aliases exist and what limits they run
 * under.
 *
 * The limits come from the gateway rather than from a table in the client,
 * because the gateway is what enforces them — a client that guesses wrong
 * compacts too late and gets cut off mid-generation.
 */
export interface CatalogEntry {
  id: string
  context: number
  output: number
}

// How long the catalog fetch may take before the sign-in path gives up
// on live limits and falls back to the conservative defaults. Without a
// deadline, a slow network would hold an approved device flow in "waiting"
// after the user already approved in the browser.
export const CATALOG_TIMEOUT_MS = 15_000

export async function fetchCatalog(
  gatewayUrl: string,
  key: string,
  input?: { timeoutMs?: number },
): Promise<CatalogEntry[]> {
  const res = await fetch(`${gatewayUrl}/v1/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(input?.timeoutMs ?? CATALOG_TIMEOUT_MS),
  })
  if (res.status === 401 || res.status === 403) throw new Error("key-rejected")
  if (!res.ok) throw new Error(`catalog request failed: ${res.status}`)

  const body = (await res.json()) as {
    data?: { id: string; max_input_tokens?: number; max_output_tokens?: number }[]
  }

  return (body.data ?? []).map((model) => ({
    id: model.id,
    context: model.max_input_tokens ?? 0,
    output: model.max_output_tokens ?? 0,
  }))
}
