/**
 * The gateway credential, and the environment the sidecar needs to use it.
 *
 * The provider config references the credential as `{env:ZAINO_API_KEY}`, and
 * the CONFIG LOADER runs inside the sidecar process — so the substitution
 * reads the SIDECAR's environment, not the desktop's.
 *
 * That is why the credential is delivered through the sidecar's spawn
 * environment (`ensure({ env })`) rather than through the desktop's
 * `process.env`: the sidecar inherits the desktop's environment at spawn
 * time only, and a sidecar that is already running keeps the environment it
 * was started with. Changing the credential therefore REQUIRES a new
 * sidecar process, which is what `restart` in the service layer does.
 */

export const ZAINO_ENV_KEY = "ZAINO_API_KEY"

/** The public gateway. OpenAI-compatible clients use the `/v1` base. */
export const DEFAULT_GATEWAY_URL = "https://api.zaino.soon.it"

/** The portal. The device-code endpoints live here. */
export const DEFAULT_PORTAL_URL = "https://zaino.soon.it"

/**
 * The environment the sidecar is spawned with.
 *
 * Beyond the credential this carries the independence isolation: the sidecar
 * resolves its config, database, and channel files under the desktop's
 * `userData`, never under the shared `~/.config|share|state/opencode`
 * roots a generic CLI install uses. `OPENCODE_DISABLE_FREE_MODELS`
 * backstops the provider gate below: even if the gate regresses, the
 * free-tier fallback can never activate.
 */
export function sidecarEnv(key: string | undefined, userData: string): Record<string, string> {
  return {
    ...(key ? { [ZAINO_ENV_KEY]: key } : {}),
    // The desktop owns the provider config; the sidecar must never fall back
    // to the shared ~/.config/opencode/opencode.json.
    OPENCODE_CONFIG: `${userData}/zaino/zaino.json`,
    OPENCODE_CONFIG_DIR: `${userData}/zaino/config`,
    OPENCODE_DB: `${userData}/zaino/zaino.db`,
    // The registration file lives under Global.state = XDG_STATE_HOME/app.
    // Pinning XDG_STATE_HOME to userData (with ZAINO_ONLY=1 making the app
    // segment `zaino`) forces the sidecar to write
    // userData/zaino/service(-local).json — the exact file the desktop
    // watches in background-service. Without this the sidecar falls back to
    // ~/.local/state/zaino and ensure() times out after 120s.
    XDG_STATE_HOME: userData,
    OPENCODE_DISABLE_FREE_MODELS: "1",
    ZAINO_ONLY: "1",
  }
}
