import { describe, expect, test } from "bun:test"

import { sidecarEnv, ZAINO_ENV_KEY } from "./provider"

/**
 * How the gateway credential reaches the sidecar.
 *
 * The provider config references the credential as `{env:ZAINO_API_KEY}`, and
 * the config loader that resolves that reference runs INSIDE the sidecar
 * process. The sidecar inherits its environment at spawn time and keeps it
 * for its whole life, so the credential is delivered through the spawn
 * environment — and a changed credential requires a new sidecar.
 *
 * The bug this file exists to prevent: delivering the credential through the
 * desktop's own `process.env`. The sidecar inherits the desktop's
 * environment at spawn, so that path works for the FIRST launch and silently
 * fails for every launch after a sign-in — the running sidecar keeps the
 * environment it was started with, and resolves the reference to an empty
 * string. Every request then fails with a 401 that looks like a bad key.
 */
describe("sidecarEnv", () => {
  const userData = "/tmp/fake-userdata"

  test("names the variable the provider config references", () => {
    expect(ZAINO_ENV_KEY).toBe("ZAINO_API_KEY")
  })

  test("carries the credential under that exact name", () => {
    const env = sidecarEnv("zn-example-body", userData)

    expect(env["ZAINO_API_KEY"]).toBe("zn-example-body")
  })

  test("passes no credential when the user has not signed in, but keeps isolation", () => {
    const env = sidecarEnv(undefined, userData)

    expect(env["ZAINO_API_KEY"]).toBeUndefined()
    expect(env["OPENCODE_CONFIG"]).toBe(`${userData}/zaino/zaino.json`)
    expect(env["OPENCODE_CONFIG_DIR"]).toBe(`${userData}/zaino/config`)
    expect(env["OPENCODE_DB"]).toBe(`${userData}/zaino/zaino.db`)
    expect(env["XDG_STATE_HOME"]).toBe(userData)
    expect(env["OPENCODE_CONFIG_CONTENT"]).toBeUndefined()
  })

  test("an empty credential is not passed on as an empty header", () => {
    const env = sidecarEnv("", userData)

    expect(env["ZAINO_API_KEY"]).toBeUndefined()
  })

  test("always disables free models and marks the desktop-only sidecar", () => {
    const env = sidecarEnv("zn-example-body", userData)

    expect(env["OPENCODE_DISABLE_FREE_MODELS"]).toBe("1")
    expect(env["ZAINO_ONLY"]).toBe("1")
  })
})
