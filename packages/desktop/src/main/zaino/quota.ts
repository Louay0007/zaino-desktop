/**
 * Quota — prompt-limit accounting for the Zaino gateway.
 *
 * The gateway enforces DOLLAR budgets upstream, but the customer-facing
 * limit is PROMPTS per alias per billing period (portal migration 0013).
 * The portal serves that state at `GET {portal}/api/device/usage`, which
 * authenticates with the same `zn-` key the app already holds — no browser
 * session, no PII, no spend figures.
 *
 * The pure decision logic lives here so it can be unit-tested without a
 * network: `deriveQuota` takes the snapshot and returns one render state.
 * This mirrors portal/lib/jobs/collect-usage.ts, which counts a row's
 * `prompt_count` (the number of user messages in the request).
 */

export interface UsageSnapshot {
  planCode: string | null
  models: string[]
  promptLimits: Record<string, number>
  promptsByModel: Record<string, number>
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

  const limits = snapshot.promptLimits ?? {}
  const used = snapshot.promptsByModel ?? {}

  const exhausted = Object.entries(limits)
    .filter(([, limit]) => Number.isFinite(limit) && limit > 0)
    .filter(([alias, limit]) => (used[alias] ?? 0) >= limit)
    .map(([alias]) => alias)

  if (exhausted.length > 0) return { _tag: "Exhausted", models: exhausted }

  const remaining: Record<string, number> = {}
  for (const [alias, limit] of Object.entries(limits)) {
    remaining[alias] = Math.max(0, limit - (used[alias] ?? 0))
  }

  return { _tag: "Ok", models: snapshot.models ?? [], remaining, limits }
}

/** True when the alias has prompts left. An alias with no limit is unlimited. */
export function canUse(snapshot: UsageSnapshot | null, alias: string): boolean {
  if (!snapshot) return true
  const limit = snapshot.promptLimits?.[alias]
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return true
  return (snapshot.promptsByModel?.[alias] ?? 0) < limit
}

export async function fetchUsage(portalUrl: string, key: string): Promise<UsageSnapshot> {
  const res = await fetch(`${portalUrl}/api/device/usage`, {
    headers: { Authorization: `Bearer ${key}` },
  })
  if (res.status === 401) throw new Error("unauthorized")
  if (!res.ok) throw new Error(`usage request failed: ${res.status}`)
  return (await res.json()) as UsageSnapshot
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
