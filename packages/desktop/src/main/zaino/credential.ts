import { app, safeStorage } from "electron"
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The gateway credential, at rest in the OS keychain.
 *
 * The `zn-…` body exists in exactly two places: this keychain entry, and the
 * sidecar's process memory. It is never written to a config file, never
 * returned to the renderer, and never logged.
 *
 * The keychain is the desktop's own copy. The sidecar gets the value
 * through its process environment (see `provider.ts`), which is why the
 * sidecar has to be restarted when the credential changes.
 */

const KEY_FILE = "zaino-key.enc"

function keyPath() {
  return join(app.getPath("userData"), KEY_FILE)
}

/** The stored credential, or undefined when the user has not signed in. */
export function readKey(): string | undefined {
  try {
    if (!safeStorage.isEncryptionAvailable()) return undefined
    const value = safeStorage.decryptString(readFileSync(keyPath()))
    return value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

export function writeKey(key: string) {
  mkdirSync(app.getPath("userData"), { recursive: true })
  writeFileSync(keyPath(), safeStorage.encryptString(key))
}

export function clearKey() {
  try {
    unlinkSync(keyPath())
  } catch {
    // Already gone.
  }
}
