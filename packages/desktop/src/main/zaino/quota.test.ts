import { describe, expect, test } from "bun:test"

import { buildProvider, ZAINO_PROVIDER_ID } from "./config"
import { canUse, deriveQuota, tightest, type UsageSnapshot } from "./quota"

function snapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    planCode: "starter",
    models: ["fast", "smart"],
    tokenLimits: { fast: 800_000_000, smart: 40_000_000 },
    tokensByModel: { fast: 1_000_000, smart: 500_000 },
    remainingTokensByModel: { fast: 799_000_000, smart: 39_500_000 },
    tokenExhausted: [],
    exhaustedByModel: {},
    periodStart: "2026-10-01T00:00:00.000Z",
    periodEnd: "2026-11-01T00:00:00.000Z",
    ...overrides,
  }
}

describe("deriveQuota", () => {
  test("reports remaining tokens per alias when under the limit", () => {
    const quota = deriveQuota(snapshot())
    expect(quota).toEqual({
      _tag: "Ok",
      models: ["fast", "smart"],
      limits: { fast: 800_000_000, smart: 40_000_000 },
      remaining: { fast: 799_000_000, smart: 39_500_000 },
    })
  })

  test("an alias the portal lists as exhausted is exhausted", () => {
    const quota = deriveQuota(
      snapshot({
        remainingTokensByModel: { fast: 0, smart: 39_500_000 },
        tokenExhausted: ["fast"],
        exhaustedByModel: { fast: "tokens", smart: null },
      }),
    )
    expect(quota).toEqual({ _tag: "Exhausted", models: ["fast"] })
  })

  test("an alias whose numbers show it spent is exhausted even when the list omits it", () => {
    const quota = deriveQuota(snapshot({ tokensByModel: { fast: 800_000_000, smart: 5_000_000 } }))
    expect(quota).toEqual({ _tag: "Exhausted", models: ["fast"] })
  })

  test("an alias with no limit is unlimited, not denied", () => {
    const quota = deriveQuota(snapshot({ tokenLimits: { fast: 800_000_000 } }))
    expect(quota._tag).toBe("Ok")
  })

  test("missing token fields fail open — an older portal never signs the user out", () => {
    const quota = deriveQuota({
      planCode: null,
      models: ["fast", "smart"],
      periodStart: "",
      periodEnd: "",
    })
    expect(quota._tag).toBe("Ok")
    expect(quota.limits).toEqual({})
  })

  test("a revoked key fails closed rather than falling back", () => {
    expect(deriveQuota(null, "unauthorized")).toEqual({ _tag: "Unauthorized" })
  })

  test("a portal failure is an error, not a sign-out", () => {
    expect(deriveQuota(null, "quota_exhausted")).toEqual({ _tag: "Error", message: "quota_exhausted" })
  })

  test("no snapshot is unknown, not ok", () => {
    expect(deriveQuota(null)).toEqual({ _tag: "Unknown" })
  })
})

describe("canUse", () => {
  test("blocks an alias that exhausted its token limit", () => {
    expect(canUse(snapshot({ tokensByModel: { fast: 800_000_000, smart: 5 } }), "fast")).toBe(false)
  })

  test("allows an alias under its limit", () => {
    expect(canUse(snapshot(), "fast")).toBe(true)
  })

  test("allows an alias with no configured limit", () => {
    expect(canUse(snapshot({ tokenLimits: {} }), "frontier")).toBe(true)
  })
})

describe("tightest", () => {
  test("picks the alias closest to its limit", () => {
    expect(tightest({ fast: 800, smart: 400 }, { fast: 100, smart: 300 })).toBe("smart")
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
