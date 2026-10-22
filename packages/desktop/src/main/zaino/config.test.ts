import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigProvider } from "@opencode/schema/config/provider"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { buildProvider, globalConfigPath, legacyGlobalConfigPath, writeProvider } from "./config"

/**
 * The generated provider config, checked against the REAL config schema.
 *
 * The unit test next door proves the builder emits the fields it thinks it
 * emits. This one proves the CLI accepts them: the provider block decodes as
 * a `Config.Provider`, with the base URL, the credential reference, and the
 * model limits all landing where the loader expects them.
 *
 * A silent break here is the difference between "the app shows a model
 * picker" and "the app shows a model picker that 401s on every request".
 */
describe("zaino provider config", () => {
  const decode = Schema.decodeUnknownSync(ConfigProvider.Info, {
    errors: "all",
    onExcessProperty: "ignore",
  })

  test("decodes as a config provider the loader accepts", () => {
    const provider = buildProvider(["fast", "smart"])
    const decoded = decode(provider)

    expect(decoded.name).toBe("Zaino Gateway")
    expect(decoded.package).toBe("aisdk:@ai-sdk/openai-compatible")
    expect(decoded.settings?.["baseURL"]).toBe("https://api.zaino.soon.it/v1")
    expect(decoded.settings?.["apiKey"]).toBe("{env:ZAINO_API_KEY}")
  })

  test("carries the context and output limits the gateway advertises", () => {
    const provider = buildProvider(["fast"])
    const decoded = decode(provider)

    expect(decoded.models?.["fast"]?.limit).toEqual({ context: 262144, output: 32768 })
  })

  test("declares reasoning and tool support, which the gateway models have", () => {
    const provider = buildProvider(["fast"])
    const decoded = decode(provider)

    expect(decoded.models?.["fast"]?.capabilities?.tools).toBe(true)
    expect(decoded.models?.["fast"]?.capabilities?.reasoning).toEqual({ supported: true })
  })

  test("writes only the entitled aliases", () => {
    const provider = buildProvider(["fast", "smart"])
    const decoded = decode(provider)

    expect(Object.keys(decoded.models ?? {})).toEqual(["fast", "smart"])
    expect(decoded.models).not.toHaveProperty("frontier")
  })

  test("takes the limits from the gateway rather than a local table", () => {
    const provider = buildProvider(["fast"], undefined, { fast: { context: 256000, output: 128000 } })
    const decoded = decode(provider)

    expect(decoded.models?.["fast"]?.limit).toEqual({ context: 256000, output: 128000 })
  })

  test("falls back to conservative limits for an alias the gateway did not describe", () => {
    const provider = buildProvider(["fast"], undefined, { smart: { context: 1, output: 1 } })
    const decoded = decode(provider)

    expect(decoded.models?.["fast"]?.limit).toEqual({ context: 262144, output: 32768 })
  })

  test("an empty entitlement yields no models, so the provider grants nothing", () => {
    const provider = buildProvider([])
    const decoded = decode(provider)

    expect(Object.keys(decoded.models ?? {})).toHaveLength(0)
  })

  test("keeps the credential out of the file the app writes", () => {
    const provider = buildProvider(["fast"])
    const serialized = JSON.stringify(provider)

    expect(serialized).not.toContain("zn-")
    expect(provider.settings.apiKey).toBe("{env:ZAINO_API_KEY}")
  })

  test("the credential reference survives a config-text substitution untouched", () => {
    // The substitution itself lives in the core config loader; what the
    // desktop guarantees is that the placeholder it writes is the shape the
    // loader looks for, and that no literal key is ever written.
    const provider = buildProvider(["fast"])
    const text = JSON.stringify(provider)

    expect(text).toContain("{env:ZAINO_API_KEY}")
    expect(text).not.toMatch(/zn-[A-Za-z0-9_-]{16,}/)
  })
})

describe("provider isolation", () => {
  // `writeProvider` never touches the machine's real shared config. Every
  // test below redirects `XDG_CONFIG_HOME` at the same throwaway root so a
  // missing-file case cannot observe another test's artifact.
  const xdgRoot = mkdtempSync(join(tmpdir(), "zaino-xdg-"))
  const previousXdg = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = xdgRoot

  test("writes the desktop-owned file under userData, never the shared config", () => {
    const userData = mkdtempSync(join(tmpdir(), "zaino-config-"))
    const path = writeProvider(["fast"], undefined, { fast: { context: 1048576, output: 65536 } }, userData)

    expect(path).toBe(join(userData, "zaino", "zaino.json"))
    expect(existsSync(path)).toBe(true)
  })

  test("denies every provider then explicitly allows zaino, in that order", () => {
    const userData = mkdtempSync(join(tmpdir(), "zaino-config-"))
    const path = writeProvider(["fast"], undefined, { fast: { context: 1048576, output: 65536 } }, userData)
    const written = JSON.parse(readFileSync(path, "utf8"))
    const policies = written.policies as { action: string; resource: string; effect: string }[]

    // `*` matches zaino too and the engine takes the LAST match, so the
    // allow must come after the deny or the gateway disables itself.
    expect(policies).toEqual([
      { action: "provider.use", resource: "*", effect: "deny" },
      { action: "provider.use", resource: "zaino", effect: "allow" },
    ])
  })

  test("does not stack duplicate policy statements on repeated writes", () => {
    const userData = mkdtempSync(join(tmpdir(), "zaino-config-"))
    writeProvider(["fast"], undefined, undefined, userData)
    const path = writeProvider(["fast"], undefined, undefined, userData)
    const written = JSON.parse(readFileSync(path, "utf8"))
    const providerPolicies = (written.policies as unknown[]).filter(
      (p) => typeof p === "object" && p !== null && (p as { action?: unknown }).action === "provider.use",
    )

    expect(providerPolicies).toHaveLength(2)
  })

  test("seeds top-level keys from the legacy shared file and leaves that file alone", () => {
    const userData = mkdtempSync(join(tmpdir(), "zaino-config-"))
    const legacy = legacyGlobalConfigPath()
    mkdirSync(dirname(legacy), { recursive: true })
    writeFileSync(
      legacy,
      JSON.stringify({
        providers: { anthropic: { name: "user provider" }, zaino: { name: "legacy zaino block" } },
        model: "anthropic/claude",
      }),
    )

    const path = writeProvider(["fast"], undefined, undefined, userData)
    const written = JSON.parse(readFileSync(path, "utf8"))

    // The user's explicit model choice survives the move only when it points
    // at the zaino provider; a legacy choice for another provider is rejected
    // and falls back to the first entitled tier. Third-party provider blocks
    // stay behind — the isolated file carries zaino only.
    expect(written.providers).toEqual({ zaino: expect.objectContaining({ name: "Zaino Gateway" }) })
    expect(written.model).toBe("zaino/fast")
    const untouched = JSON.parse(readFileSync(legacy, "utf8"))
    expect(Object.keys(untouched.providers)).toEqual(["anthropic", "zaino"])
  })

  test("a malformed isolated file is replaced, not merged", () => {
    const userData = mkdtempSync(join(tmpdir(), "zaino-config-"))
    const path = globalConfigPath(userData)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, "not json{")

    const written = writeProvider(["smart"], undefined, undefined, userData)
    const parsed = JSON.parse(readFileSync(written, "utf8"))

    expect(Object.keys(parsed.providers)).toEqual(["zaino"])
    expect(parsed.model).toBe("zaino/smart")
  })
})
