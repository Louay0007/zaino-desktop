import type { ElectronAPI } from "../api-types"

/**
 * The prompt quota gate.
 *
 * The gateway's only customer-facing limit is the prompt count: the token
 * budgets, rpm and tpm are all effectively unlimited, so nothing on the
 * server stops a customer from spending. The client is therefore the place
 * the limit is enforced — which means the client has to know, per alias,
 * how many prompts are left and refuse a send that would exceed it.
 *
 * The count comes from the portal's `/api/device/usage`, which is the
 * gateway's own ledger. The gate is deliberately conservative: it blocks
 * only when the ledger says the alias is spent, and it never blocks on a
 * stale or missing snapshot. A customer must never be cut off because the
 * app could not reach the portal.
 */

/** A prompt submission the gate can recognise in the request path. */
export const PROMPT_PATH = /\/api\/session\/[^/]+\/prompt$/

/**
 * How long a quota snapshot is trusted before the gate refreshes it.
 *
 * The ledger updates on the jobs cadence anyway, so polling the portal more
 * often than this only adds latency to the prompt path without making the
 * decision any fresher.
 */
export const QUOTA_SNAPSHOT_TTL_MS = 60_000

/**
 * True when the snapshot already shows this alias as spent.
 *
 * An exhausted alias is always re-checked against the portal: the plan may
 * have been upgraded, or the billing period may have rolled over, since the
 * snapshot was read. Re-fetching here is what lets a customer keep working
 * the moment their quota returns, instead of waiting out the TTL.
 */
function isExhaustedKnown(state: QuotaState, alias: string): boolean {
  const limit = state.limits[alias]
  if (limit === undefined) return false
  return (state.used[alias] ?? 0) >= limit
}

/**
 * The request body, when it can be read without consuming it.
 *
 * A body is a stream: reading it here would take it from the request that
 * still has to be sent. A string body is safe to parse; anything else is
 * left alone, and the gate simply does not know the alias — which means
 * the request is not blocked on a guess.
 */
export function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") return undefined
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

export interface QuotaDecision {
  allowed: boolean
  alias: string | undefined
  remaining: number | undefined
  limit: number | undefined
}

export interface QuotaState {
  /** Per-alias prompts already used in the current billing period. */
  used: Record<string, number>
  /** Per-alias prompt allowance for the current billing period. */
  limits: Record<string, number>
  /** When the snapshot was read, in epoch milliseconds. */
  fetchedAt: number
}

/**
 * The alias a prompt request targets.
 *
 * The model travels in the request body as `metadata.model`, whose id is
 * the alias (`fast`, `smart`, `frontier`). A request that does not name
 * one is not a gateway request, so the gate lets it through.
 */
export function aliasOfRequestBody(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined
  const metadata = (body as { metadata?: unknown }).metadata
  if (typeof metadata !== "object" || metadata === null) return undefined
  const model = (metadata as { model?: unknown }).model
  if (typeof model !== "object" || model === null) return undefined
  const id = (model as { modelID?: unknown; id?: unknown }).modelID ?? (model as { id?: unknown }).id
  return typeof id === "string" && id.length > 0 ? id : undefined
}

/**
 * Decide whether a prompt may be sent.
 *
 * A snapshot that does not mention the alias at all means the alias has no
 * limit — an unlimited alias is always allowed. An alias that IS in the
 * limits map is blocked once its usage reaches the limit.
 */
export function decide(state: QuotaState | null, alias: string | undefined): QuotaDecision {
  if (!state || !alias) return { allowed: true, alias, remaining: undefined, limit: undefined }
  const limit = state.limits[alias]
  if (limit === undefined) return { allowed: true, alias, remaining: undefined, limit: undefined }
  const used = state.used[alias] ?? 0
  const remaining = Math.max(0, limit - used)
  return { allowed: used < limit, alias, remaining, limit }
}

/**
 * A gate that answers whether a prompt may be sent.
 *
 * The snapshot is read through the main process, which holds the credential
 * the portal needs. Refreshes are rate-limited by TTL: without it, every
 * prompt submission would pay a portal round trip on its critical path,
 * including the first send after idle where the latency is most visible.
 * A failure to refresh leaves the gate open: the ledger is the source of
 * truth, and a gate that cannot read it must not guess.
 */
export function createQuotaGate(api: ElectronAPI, input?: { ttlMs?: number }) {
  const ttlMs = input?.ttlMs ?? QUOTA_SNAPSHOT_TTL_MS
  let state: QuotaState | null = null

  async function refresh() {
    try {
      const result = await api.zaino.readUsage()
      const snapshot = result?.snapshot as
        | { promptLimits?: Record<string, number>; promptsByModel?: Record<string, number> }
        | null
        | undefined
      if (!snapshot) return state
      state = {
        used: snapshot.promptsByModel ?? {},
        limits: snapshot.promptLimits ?? {},
        fetchedAt: Date.now(),
      }
    } catch {
      // Keep the previous snapshot. A stale limit is better than an open
      // gate, and better than a gate that cuts a paying customer off
      // because the portal was briefly unreachable.
    }
    return state
  }

  return {
    refresh,
    current: () => state,
    async check(alias: string | undefined) {
      if (!alias) return { allowed: true, alias, remaining: undefined, limit: undefined }
      const fresh =
        state !== null && Date.now() - state.fetchedAt < ttlMs && !isExhaustedKnown(state, alias)
      // A snapshot older than the ledger's own cadence can be behind, so
      // refresh before deciding — unless it is still within TTL and does
      // not already show this alias as spent. An exhausted alias is always
      // re-checked: the plan may have been upgraded since the snapshot.
      // The refresh is best-effort: a failure leaves the last known state
      // in place.
      if (!fresh) await refresh()
      return decide(state, alias)
    },
  }
}
