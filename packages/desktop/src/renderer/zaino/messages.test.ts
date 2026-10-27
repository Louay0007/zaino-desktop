import { describe, expect, test } from "bun:test"

import { ZAINO_MESSAGES, zainoT } from "./messages"

/**
 * The templates use single-brace placeholders (`{limit}`), and the sign-in
 * surface passes numbers through them — a substitution regression shows
 * the raw template instead of the user's quota.
 */
describe("zainoT", () => {
  test("substitutes a single-brace placeholder", () => {
    expect(zainoT("usageRemaining", { remaining: 39_500_000, limit: 40_000_000 })).toBe(
      "39500000 of 40000000 tokens left",
    )
  })

  test("substitutes several placeholders", () => {
    expect(zainoT("usageLine", { remaining: 1, limit: 2, model: "fast" })).toBe("1 of 2 fast")
  })

  test("leaves an unknown placeholder alone", () => {
    expect(zainoT("usageLine", { remaining: 1 })).toBe("1 of {limit} {model}")
  })

  test("every template has no leftover double-brace syntax", () => {
    for (const [key, template] of Object.entries(ZAINO_MESSAGES)) {
      expect(template).not.toMatch(/\{\{/)
      expect(template.length).toBeGreaterThan(0)
      expect(key.length).toBeGreaterThan(0)
    }
  })
})
