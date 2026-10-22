import { app, shell } from "electron"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { writeProvider, type ModelLimits } from "./config"
import { fetchCatalog, fetchUsage } from "./quota"
import { clearKey, readKey, writeKey } from "./credential"
import { DEFAULT_GATEWAY_URL } from "./provider"

/**
 * Device-code sign-in against the Zaino portal.
 *
 * The `zn-…` credential exists in exactly three places, all with bounded
 * lifetimes: the portal's one-time `device_codes.key_plaintext` column, the
 * OS keychain, and the sidecar's process environment. It is never written to
 * a config file, never returned to the renderer, and never logged.
 *
 * The renderer receives display data only — the user code, the verification
 * URL, the phase, and the alias list after approval.
 */

export type Phase =
  | { _tag: "Idle" }
  | { _tag: "AwaitingBrowser"; userCode: string; verificationUrl: string; expiresAt: number }
  | { _tag: "Approved"; models: string[] }
  | { _tag: "Expired" }
  | { _tag: "Cancelled" }
  | { _tag: "Error"; message: string }

export type Emit = (phase: Phase) => void | Promise<void>

let current: { deviceCode: string; abort: AbortController } | null = null

export function readState(): { models: string[]; user: unknown; organization: unknown } | null {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8"))
  } catch {
    return null
  }
}

function statePath() {
  return join(app.getPath("userData"), "zaino-state.json")
}

function writeState(state: unknown) {
  mkdirSync(app.getPath("userData"), { recursive: true })
  writeFileSync(statePath(), JSON.stringify(state))
}

/** The gateway's aliases. An upstream model name is never a valid value here. */
const ALIASES = new Set(["fast", "smart", "frontier"])

function aliasesFromModels(models: string[]) {
  return models.filter((model) => ALIASES.has(model))
}

/**
 * The context and output limits the gateway advertises for each alias.
 *
 * A catalog fetch that fails is not fatal: the provider falls back to
 * conservative limits, and the gateway is what actually enforces the real
 * ones. Shared with the usage-refresh path, which keeps the provider's
 * limits in step with the gateway without another fetch.
 */
export async function modelLimits(key: string): Promise<Record<string, ModelLimits> | undefined> {
  try {
    const catalog = await fetchCatalog(DEFAULT_GATEWAY_URL, key)
    const limits: Record<string, ModelLimits> = {}
    for (const entry of catalog) {
      if (!ALIASES.has(entry.id)) continue
      if (entry.context <= 0 || entry.output <= 0) continue
      limits[entry.id] = { context: entry.context, output: entry.output }
    }
    return Object.keys(limits).length > 0 ? limits : undefined
  } catch {
    return undefined
  }
}

/**
 * Start a device-code authorization.
 *
 * The verification URL is absolute and comes from the portal — it is opened
 * in the SYSTEM browser, never in a webview, so the person's session and
 * the app's process stay separate.
 */
export async function begin(portalUrl: string, emit: Emit, onApproved?: () => Promise<void>) {
  if (current) {
    current.abort.abort()
    current = null
  }
  const abort = new AbortController()
  current = { deviceCode: "", abort }

  try {
    const res = await fetch(`${portalUrl}/api/auth/device`, { method: "POST", signal: abort.signal })
    if (!res.ok) throw new Error(`device begin failed: ${res.status}`)

    const data = (await res.json()) as {
      device_code: string
      user_code: string
      verification_url: string
      expires_in: number
      interval: number
    }
    current.deviceCode = data.device_code
    emit({
      _tag: "AwaitingBrowser",
      userCode: data.user_code,
      verificationUrl: data.verification_url,
      expiresAt: Date.now() + data.expires_in * 1000,
    })
    await shell.openExternal(data.verification_url)

    let interval = Math.max(1, data.interval || 5)
    while (!abort.signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, interval * 1000))
      if (abort.signal.aborted) break
      try {
        const poll = await fetch(`${portalUrl}/api/auth/device/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_code: data.device_code }),
          signal: abort.signal,
        })
        const body = (await poll.json().catch(() => ({}))) as any
        if (poll.status === 200 && body.token) {
          const key = String(body.token)
          if (!/^zn-[A-Za-z0-9_-]{16,}$/.test(key)) throw new Error("invalid key shape")
          const models = aliasesFromModels(Array.isArray(body.models) ? body.models : [])
          writeKey(key)
          writeState({ models, user: body.user, organization: body.organization })
          // Register the provider with ONLY the entitled aliases, and with
          // the limits the gateway advertises. A Starter plan's granted list
          // has no `frontier`, so it never appears in the model picker.
          try {
            writeProvider(models, undefined, await modelLimits(key), app.getPath("userData"))
          } catch (error) {
            // A config write failure must not discard a valid key; the app
            // can still talk to the gateway with the keychain credential.
            console.error("[zaino] failed to write provider config", error)
          }
          // The sidecar keeps the environment it was started with, so the
          // new credential only reaches the gateway through a new sidecar.
          // Restart it BEFORE announcing approval, so the app is usable the
          // moment the renderer proceeds.
          await onApproved?.()
          emit({ _tag: "Approved", models })
          current = null
          return
        }
        const code = body?.error?.code
        if (code === "slow_down") {
          interval = Math.min(interval + 5, 30)
          continue
        }
        if (code === "authorization_pending") continue
        if (code === "expired_token") {
          emit({ _tag: "Expired" })
          current = null
          return
        }
        if (code === "invalid_grant" || code === "access_denied") {
          emit({ _tag: "Error", message: code })
          current = null
          return
        }
        emit({ _tag: "Error", message: code || `http ${poll.status}` })
        current = null
        return
      } catch (error) {
        if (abort.signal.aborted) break
        // A dropped network is not a refused sign-in. Back off and keep
        // polling — the code lives for 15 minutes, so a transient outage
        // must not kill the flow the user is watching in the browser.
        // Anything the portal itself answered with is terminal and handled
        // above; only a fetch that never got an answer retries here.
        if (error instanceof TypeError || (error instanceof Error && error.name === "AbortError")) {
          interval = Math.min(interval * 2, 30)
          continue
        }
        emit({ _tag: "Error", message: error instanceof Error ? error.message : String(error) })
        current = null
        return
      }
    }
  } catch (error) {
    if (!abort.signal.aborted) {
      emit({ _tag: "Error", message: error instanceof Error ? error.message : String(error) })
    }
    current = null
  }
}

export function cancel(emit: Emit) {
  // A superseded run already cleared `current` when the new `begin()`
  // aborted it. Emitting here anyway would paint "cancelled" over a run
  // the user is still watching, so a no-op is the correct answer: there
  // is nothing to cancel.
  if (!current) return
  current.abort.abort()
  current = null
  emit({ _tag: "Cancelled" })
}

/**
 * Store a pasted key — the fallback when the browser flow is unavailable.
 *
 * The key is validated for SHAPE here, and then by the GATEWAY: we ask
 * `/v1/models` with the credential and accept it only if the gateway
 * answers. A shape-valid key for a revoked org would otherwise look signed
 * in until the first real request failed.
 */
export async function setPastedKey(key: string, gatewayUrl: string, portalUrl: string): Promise<string[]> {
  const trimmed = key.trim()
  if (!/^zn-[A-Za-z0-9_-]{16,}$/.test(trimmed)) throw new Error("invalid-key-format")

  const res = await fetch(`${gatewayUrl}/v1/models`, { headers: { Authorization: `Bearer ${trimmed}` } })
  if (res.status === 401 || res.status === 403) throw new Error("key-rejected")
  if (!res.ok) throw new Error(`gateway-error-${res.status}`)

  const body = (await res.json()) as { data?: { id: string }[] }
  const models = aliasesFromModels((body.data ?? []).map((m) => m.id))
  if (models.length === 0) throw new Error("no-models")

  writeKey(trimmed)

  // The catalog says which aliases EXIST; the portal's usage snapshot says
  // which the plan ALLOWS. The models list has to be the intersection: a
  // Starter key against a three-alias catalog must still not show frontier.
  // Best effort — a failure here must not invalidate a key the gateway
  // already accepted, so it falls back to the catalog list.
  let entitled = models
  try {
    const usage = await fetchUsage(portalUrl, trimmed)
    entitled = aliasesFromModels(usage.models ?? models)
    writeState({ models: entitled, user: null, organization: null })
  } catch {
    writeState({ models, user: null, organization: null })
  }

  writeProvider(entitled, undefined, await modelLimits(trimmed), app.getPath("userData"))

  return entitled
}

export { clearKey, readKey }
