import { describe, expect, test } from "bun:test"

import { buildProvider, ZAINO_PROVIDER_ID } from "./config"
import { canUse, deriveQuota, tightest, type UsageSnapshot } from "./quota"

function snapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    planCode: "starter",
    models: ["fast", "smart"],
    promptLimits: { fast: 500, smart: 250 },
    promptsByModel: { fast: 10, smart: 5 },
    periodStart: "2026-10-01T00:00:00.000Z",
    periodEnd: "2026-11-01T00:00:00.000Z",
    ...overrides,
  }
}

describe("deriveQuota", () => {
  test("reports remaining prompts per alias when under the limit", () => {
    const quota = deriveQuota(snapshot())
    expect(quota).toEqual({
      _tag: "Ok",
      models: ["fast", "smart"],
      limits: { fast: 500, smart: 250 },
      remaining: { fast: 490, smart: 245 },
    })
  })

  test("exhausted alias wins over the others", () => {
    const quota = deriveQuota(snapshot({ promptsByModel: { fast: 500, smart: 5 } }))
    expect(quota).toEqual({ _tag: "Exhausted", models: ["fast"] })
  })

  test("an alias with no limit is unlimited, not denied", () => {
    const quota = deriveQuota(snapshot({ promptLimits: { fast: 500 } }))
    expect(quota._tag).toBe("Ok")
  })

  test("a revoked key fails closed rather than falling back", () => {
    expect(deriveQuota(null, "unauthorized")).toEqual({ _tag: "Unauthorized" })
  })

  test("no snapshot is unknown, not ok", () => {
    expect(deriveQuota(null)).toEqual({ _tag: "Unknown" })
  })
})

describe("canUse", () => {
  test("blocks an alias that exhausted its prompt limit", () => {
    expect(canUse(snapshot({ promptsByModel: { fast: 500 } }), "fast")).toBe(false)
  })

  test("allows an alias under its limit", () => {
    expect(canUse(snapshot(), "fast")).toBe(true)
  })

  test("allows an alias with no configured limit", () => {
    expect(canUse(snapshot({ promptLimits: {} }), "frontier")).toBe(true)
  })
})

describe("tightest", () => {
  test("picks the alias closest to its limit", () => {
    expect(tightest({ fast: 500, smart: 250 }, { fast: 100, smart: 200 })).toBe("smart")
  })

  test("ignores aliases without a usable limit", () => {
    expect(tightest({ fast: 0 }, { fast: 100 })).toBe(null)
  })
})

describe("buildProvider", () => {
  test("writes only the entitled aliases", () => {
    const provider = buildProvider(["fast", "smart"])
    expect(Object.keys(provider.models)).toEqual(["fast", "smart"])
    expect(provider.models).not.toHaveProperty("frontier")
  })

  test("never embeds the credential in the config", () => {
    const provider = buildProvider(["fast"])
    expect(provider.settings.apiKey).toBe("{env:ZAINO_API_KEY}")
    expect(JSON.stringify(provider)).not.toContain("zn-")
  })

  test("points at the gateway /v1 base URL", () => {
    const provider = buildProvider(["fast"], "https://api.zaino.soon.it")
    expect(provider.settings.baseURL).toBe("https://api.zaino.soon.it/v1")
  })

  test("an empty entitlement yields no models, so the provider grants nothing", () => {
    expect(Object.keys(buildProvider([]).models)).toHaveLength(0)
  })

  test("exposes the provider under the zaino id", () => {
    expect(ZAINO_PROVIDER_ID).toBe("zaino")
  })
})
