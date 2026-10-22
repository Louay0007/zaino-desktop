import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import electron from "electron"

export const ZAINO_PROVIDER_ID = "zaino"
export const ZAINO_GATEWAY_URL = "https://api.zaino.soon.it"

/**
 * The provider config the desktop writes for the Zaino gateway.
 *
 * Two rules, both from the client contract:
 *   1. The credential NEVER lands here. `apiKey` stays `{env:ZAINO_API_KEY}`;
 *      the value is injected into the sidecar's environment at launch.
 *   2. Only ENTITLED aliases are written. The granted model list comes from
 *      the device token (or the portal's usage endpoint). A Starter plan must
 *      not see `frontier` in the picker, and writing a full static list
 *      would show it.
 *
 * The shape is the CURRENT (V2) `providers` map, not the legacy `provider`
 * map: the legacy one silently drops `reasoning`, and the gateway's models
 * are reasoning models. `packages/core/test/config/zaino-provider.test.ts`
 * pins the migration and the substitution.
 */

export interface ModelSpec {
  name: string
  limit: { context: number; output: number }
  capabilities: {
    tools: boolean
    input: string[]
    output: string[]
    reasoning: { supported: boolean }
  }
}

/**
 * The limits the gateway advertises for a model.
 *
 * The gateway is the authority on what it will serve, so these come from its
 * `/v1/models` response rather than from a table here. A hardcoded number
 * would drift the moment the gateway's own defaults change, and a wrong
 * context limit makes the client compact too late or too early.
 */
export interface ModelLimits {
  context: number
  output: number
}

/** Fallback limits for a model the gateway did not describe. */
const FALLBACK_LIMITS: ModelLimits = { context: 262144, output: 32768 }

const MODEL_NAMES: Record<string, string> = {
  fast: "Zaino Fast",
  smart: "Zaino Smart",
  frontier: "Zaino Frontier",
}

/** The modalities each tier accepts. `frontier` is the only one with images. */
const MODEL_INPUTS: Record<string, string[]> = {
  fast: ["text"],
  smart: ["text"],
  frontier: ["text", "image"],
}

function modelSpec(alias: string, limits: ModelLimits | undefined): ModelSpec {
  return {
    name: MODEL_NAMES[alias] ?? alias,
    limit: limits ?? FALLBACK_LIMITS,
    capabilities: {
      tools: true,
      input: MODEL_INPUTS[alias] ?? ["text"],
      output: ["text"],
      reasoning: { supported: true },
    },
  }
}

/**
 * The desktop's own provider config file.
 *
 * This lives under Electron's `userData` (`.../ai.zaino.desktop/zaino/zaino.json`),
 * never in the shared `~/.config/opencode/opencode.json` a generic CLI install
 * reads. The sidecar is pointed at it with `OPENCODE_CONFIG`.
 */
export function globalConfigPath(userData?: string): string {
  return join(userData ?? electron.app.getPath("userData"), "zaino", "zaino.json")
}

/**
 * The pre-independence shared config. Read-only legacy source, never written.
 *
 * Builds before independence wrote `providers.zaino` into the shared
 * `~/.config/opencode/opencode.json`. New installs never touch this file.
 */
export function legacyGlobalConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config")

  return join(base, "opencode", "opencode.json")
}

/**
 * Build the provider block for the entitled aliases.
 *
 * `entitled` is the source of truth — an empty list yields no models, which
 * makes the provider unusable rather than granting access to an alias the
 * plan does not cover. `limits` carries the context and output limits the
 * gateway advertised for each alias.
 */
export function buildProvider(
  entitled: string[],
  gatewayUrl = ZAINO_GATEWAY_URL,
  limits?: Record<string, ModelLimits>,
) {
  const models: Record<string, unknown> = {}
  for (const alias of entitled) {
    models[alias] = { ...modelSpec(alias, limits?.[alias]), family: ZAINO_PROVIDER_ID }
  }

  return {
    package: "aisdk:@ai-sdk/openai-compatible",
    name: "Zaino Gateway",
    settings: {
      baseURL: `${gatewayUrl}/v1`,
      apiKey: "{env:ZAINO_API_KEY}",
    },
    models,
  }
}

/**
 * Merge the zaino provider into the desktop's own config file.
 *
 * The isolated file is seeded once from the pre-independence shared config:
 * when it is absent but the legacy shared file carries a `providers.zaino`
 * block, that block alone is copied over. Third-party providers stay behind
 * in the shared file, which is never read or written again.
 */
export function writeProvider(
  entitled: string[],
  gatewayUrl = ZAINO_GATEWAY_URL,
  limits?: Record<string, ModelLimits>,
  userData?: string,
): string {
  const path = globalConfigPath(userData)
  let current: Record<string, unknown> = {}
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"))
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed
    } catch {
      // A malformed config is the user's to fix; we do not overwrite it
      // blindly. Start from empty and write a valid file.
      current = {}
    }
  } else {
    // One-time migration: pre-independence builds kept `providers.zaino`
    // in the shared config alongside the user's own providers. The
    // top-level keys move over (so an explicit `model` choice survives),
    // but only the zaino provider block does — third-party providers stay
    // behind in the shared file, which is left untouched and never read again.
    try {
      const parsed: unknown = JSON.parse(readFileSync(legacyGlobalConfigPath(), "utf8"))
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const { providers: _dropped, ...rest } = parsed as Record<string, unknown>
        current = { ...rest }
      }
    } catch {
      // No usable legacy file; start empty.
    }
  }

  const providers = (current.providers && typeof current.providers === "object" ? current.providers : {}) as Record<
    string,
    unknown
  >
  providers[ZAINO_PROVIDER_ID] = buildProvider(entitled, gatewayUrl, limits)

  // The default model is the first entitled alias in the gateway's
  // canonical tier order, so a key the gateway later widens (or narrows)
  // keeps a stable default instead of flipping with array order.
  const tier = ["fast", "smart", "frontier"]
  const fallback = [...entitled].sort((a, b) => tier.indexOf(a) - tier.indexOf(b))[0] ?? "fast"

  // A pre-independence shared config can seed a `model` that references a
  // provider this file no longer contains (e.g. a legacy `9router/...` id).
  // Keep the seeded choice only when it points at the isolated provider;
  // otherwise fall back to the first entitled alias.

  // The picker offers Zaino and nothing else. The policy engine takes the
  // LAST matching statement (`findLast` in `config/plugin/policy.ts`), so the
  // deny must stay ordered before the explicit allow: `*` matches `zaino`
  // too, and without the allow the deny would disable the gateway itself.
  const policies = Array.isArray((current as { policies?: unknown }).policies)
    ? (current as { policies: unknown[] }).policies.filter(
        (policy) =>
          !(
            typeof policy === "object" &&
            policy !== null &&
            (policy as { action?: unknown }).action === "provider.use" &&
            ((policy as { resource?: unknown }).resource === "*" ||
              (policy as { resource?: unknown }).resource === ZAINO_PROVIDER_ID)
          ),
      )
    : []

  const seededModel = typeof current.model === "string" ? current.model : undefined
  const next = {
    ...current,
    providers,
    policies: [
      ...policies,
      { action: "provider.use", resource: "*", effect: "deny" },
      { action: "provider.use", resource: ZAINO_PROVIDER_ID, effect: "allow" },
    ],
    model: seededModel?.startsWith(`${ZAINO_PROVIDER_ID}/`) ? seededModel : `${ZAINO_PROVIDER_ID}/${fallback}`,
  }

  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`)
  return path
}
