import { describe, expect, test } from "bun:test"

import { aliasOfRequestBody, decide, parseBody, type QuotaState } from "./gate"

/**
 * The token quota gate.
 *
 * The gateway's customer-facing limit is token usage per alias per billing
 * period, with the 429 sync guard and the gateway wall enforcing it
 * server-side. This gate is where the client refuses a prompt before
 * spending tokens it does not have, so it has to be right in both
 * directions: it must not cut off a customer with budget left, and it must
 * not keep sending past the limit.
 */
describe("decide", () => {
  const state = (used: number, limit: number): QuotaState => ({
    used: { fast: used },
    limits: { fast: limit },
    fetchedAt: 0,
  })

  test("allows a prompt while the alias has budget left", () => {
    expect(decide(state(10, 500), "fast")).toEqual({
      allowed: true,
      alias: "fast",
      remaining: 490,
      limit: 500,
    })
  })

  test("blocks a prompt once the alias is spent", () => {
    expect(decide(state(500, 500), "fast")).toEqual({
      allowed: false,
      alias: "fast",
      remaining: 0,
      limit: 500,
    })
  })

  test("blocks a prompt that would cross the limit", () => {
    expect(decide(state(499, 500), "fast").allowed).toBe(true)
    expect(decide(state(500, 500), "fast").allowed).toBe(false)
  })

  test("an alias with no limit is unlimited", () => {
    expect(decide(state(9999, 500), "frontier")).toEqual({
      allowed: true,
      alias: "frontier",
      remaining: undefined,
      limit: undefined,
    })
  })

  test("a missing snapshot never blocks — the app cannot know the limit", () => {
    expect(decide(null, "fast").allowed).toBe(true)
  })

  test("a prompt with no alias is never blocked", () => {
    expect(decide(state(500, 500), undefined).allowed).toBe(true)
  })

  test("each alias is judged against its own limit", () => {
    const both: QuotaState = {
      used: { fast: 500, smart: 10 },
      limits: { fast: 500, smart: 250 },
      fetchedAt: 0,
    }
    expect(decide(both, "fast").allowed).toBe(false)
    expect(decide(both, "smart").allowed).toBe(true)
  })
})

describe("aliasOfRequestBody", () => {
  test("reads the alias from the prompt metadata", () => {
    const body = { metadata: { model: { providerID: "zaino", modelID: "smart" } } }
    expect(aliasOfRequestBody(body)).toBe("smart")
  })

  test("ignores a body with no model", () => {
    expect(aliasOfRequestBody({ metadata: {} })).toBeUndefined()
    expect(aliasOfRequestBody({})).toBeUndefined()
    expect(aliasOfRequestBody(undefined)).toBeUndefined()
  })

  test("ignores a body that is not an object", () => {
    expect(aliasOfRequestBody("not json")).toBeUndefined()
    expect(aliasOfRequestBody(null)).toBeUndefined()
  })
})

describe("parseBody", () => {
  test("parses a JSON string body", () => {
    expect(parseBody('{"metadata":{"model":{"modelID":"fast"}}}')).toEqual({
      metadata: { model: { modelID: "fast" } },
    })
  })

  test("leaves a non-string body alone — reading it would consume the request", () => {
    const stream = new ReadableStream()
    expect(parseBody(stream)).toBeUndefined()
  })

  test("leaves an unparseable body alone", () => {
    expect(parseBody("not json")).toBeUndefined()
    expect(parseBody(undefined)).toBeUndefined()
  })
})

describe("createQuotaGate", () => {
  const snapshot = {
    snapshot: { tokenLimits: { fast: 800_000_000 }, tokensByModel: { fast: 10_000_000 } },
    quota: { _tag: "Ok" },
  }

  function api(calls: { count: number }) {
    return {
      zaino: {
        readUsage: async () => {
          calls.count++
          return snapshot
        },
      },
    } as any
  }

  test("reuses a fresh snapshot instead of hitting the portal on every prompt", async () => {
    const { createQuotaGate } = await import("./gate")
    const calls = { count: 0 }
    const gate = createQuotaGate(api(calls), { ttlMs: 60_000 })

    await gate.check("fast")
    await gate.check("fast")
    await gate.check("fast")

    expect(calls.count).toBe(1)
  })

  test("refreshes once the snapshot is older than the TTL", async () => {
    const { createQuotaGate } = await import("./gate")
    const calls = { count: 0 }
    const gate = createQuotaGate(api(calls), { ttlMs: 0 })

    await gate.check("fast")
    await gate.check("fast")

    expect(calls.count).toBe(2)
  })

  test("always re-checks an alias the snapshot shows as spent", async () => {
    const { createQuotaGate } = await import("./gate")
    const calls = { count: 0 }
    const spent = {
      snapshot: { tokenLimits: { fast: 800_000_000 }, tokensByModel: { fast: 800_000_000 } },
      quota: { _tag: "Exhausted" },
    }
    const spentApi = {
      zaino: {
        readUsage: async () => {
          calls.count++
          return spent
        },
      },
    } as any
    const gate = createQuotaGate(spentApi, { ttlMs: 60_000 })

    const first = await gate.check("fast")
    const second = await gate.check("fast")

    // A plan upgrade or a new billing period is the only way out of
    // exhausted, so the gate must ask the portal again rather than
    // serving the spent verdict from cache.
    expect(calls.count).toBe(2)
    expect(first.allowed).toBe(false)
    expect(second.allowed).toBe(false)
  })

  test("an older portal that still speaks prompts is read through the same gate", async () => {
    const { createQuotaGate } = await import("./gate")
    const calls = { count: 0 }
    const legacy = {
      snapshot: { promptLimits: { fast: 500 }, promptsByModel: { fast: 500 } },
      quota: { _tag: "Exhausted" },
    }
    const legacyApi = {
      zaino: {
        readUsage: async () => {
          calls.count++
          return legacy
        },
      },
    } as any
    const gate = createQuotaGate(legacyApi, { ttlMs: 60_000 })

    const decision = await gate.check("fast")

    expect(calls.count).toBe(1)
    expect(decision.allowed).toBe(false)
  })

  test("a failed refresh leaves the last known snapshot in place", async () => {
    const { createQuotaGate } = await import("./gate")
    const failing = {
      zaino: {
        readUsage: async () => {
          throw new Error("portal unreachable")
        },
      },
    } as any
    const gate = createQuotaGate(failing, { ttlMs: 0 })
    const decision = await gate.check("fast")

    expect(decision.allowed).toBe(true)
  })
})
