import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const roots: string[] = []
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "zaino-feeds-"))
  roots.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

const fragment = (version: string, url: string, sha: string) =>
  `version: ${version}
files:
  - url: ${url}
    sha512: ${sha}
    size: 100
path: ${url}
sha512: ${sha}
releaseDate: '2026-11-07T10:00:00.000Z'
`

function run(fragments: Record<string, string>) {
  const input = scratch()
  const output = scratch()
  for (const [path, body] of Object.entries(fragments)) {
    mkdirSync(join(input, path, ".."), { recursive: true })
    writeFileSync(join(input, path), body)
  }
  const result = Bun.spawnSync(["node", join(import.meta.dir, "merge-update-feeds.mjs"), input, output])
  return { status: result.exitCode, stderr: result.stderr.toString(), read: (name: string) => readFileSync(join(output, name), "utf8") }
}

describe("merge-update-feeds", () => {
  // electron-builder writes `latest.yml` for every Windows arch and `latest-mac.yml` for every mac
  // arch, so a flattened artifact upload keeps only the last job's feed. Windows x64 then got the
  // arm64 installer (`findFile` falls back to the first entry) and Intel Macs got an empty list.
  test("merges every architecture into one Windows feed", () => {
    const { status, read } = run({
      "win-arm64/latest.yml": fragment("1.1.7", "zaino-desktop-win-arm64.exe", "ARM"),
      "win-x64/latest.yml": fragment("1.1.7", "zaino-desktop-win-x64.exe", "X64"),
    })
    expect(status).toBe(0)
    const merged = read("latest.yml")
    expect(merged).toContain("zaino-desktop-win-arm64.exe")
    expect(merged).toContain("zaino-desktop-win-x64.exe")
    // `path:` is the legacy single-file field; it must agree with a merged entry, not shadow it.
    expect(merged).toContain("path: zaino-desktop-win-x64.exe")
  })

  test("keeps the x64 and arm64 mac entries apart under one latest-mac.yml", () => {
    const { status, read } = run({
      "mac-arm64/latest-mac.yml": fragment("1.1.7", "zaino-desktop-mac-arm64.zip", "ARM"),
      "mac-x64/latest-mac.yml": fragment("1.1.7", "zaino-desktop-mac-x64.zip", "X64"),
    })
    expect(status).toBe(0)
    const merged = read("latest-mac.yml")
    expect(merged).toContain("zaino-desktop-mac-arm64.zip")
    expect(merged).toContain("zaino-desktop-mac-x64.zip")
  })

  test("refuses fragments that disagree on the version", () => {
    const { status, stderr } = run({
      "win-arm64/latest.yml": fragment("1.1.7", "a-arm64.exe", "A"),
      "win-x64/latest.yml": fragment("1.1.6", "a-x64.exe", "B"),
    })
    expect(status).not.toBe(0)
    expect(stderr).toContain("disagree on version")
  })

  test("copies non-feed artifacts through", () => {
    const { status, read } = run({
      "win-x64/latest.yml": fragment("1.1.7", "a.exe", "A"),
      "win-x64/zaino-desktop-win-x64.exe": "binary",
    })
    expect(status).toBe(0)
    expect(read("zaino-desktop-win-x64.exe")).toBe("binary")
  })
})
