/**
 * electron-builder names the Windows feed `latest.yml` and the macOS feed `latest-mac.yml` on every
 * architecture (only Linux gets an arch suffix, see app-builder-lib updateInfoBuilder.js). Each
 * matrix job therefore writes the same two filenames, so flattening the artifacts loses all but one
 * architecture: Windows x64 users were handed the arm64 installer and Intel Macs got a feed whose
 * every entry was filtered out, which reads as "no update".
 *
 * This merges the per-job fragments into one feed per platform, listing every architecture.
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"

const [inputDir, outputDir] = process.argv.slice(2)
if (!inputDir || !outputDir) {
  console.error("usage: merge-update-feeds.mjs <artifacts-dir> <dist-dir>")
  process.exit(2)
}

const FEED = /^latest(-[a-z0-9-]+)?\.yml$/
const PREFERRED = /x64|x86_64|amd64/

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

function parse(text) {
  const take = (key) => (text.match(new RegExp(`^${key}: (.+)$`, "m")) || [])[1]?.trim() ?? null
  const lines = text.split("\n")
  const start = lines.indexOf("files:")
  const files = []
  for (let i = start + 1; start >= 0 && i < lines.length; i++) {
    const line = lines[i]
    const url = line.match(/^  - url: (.+)$/)
    if (url) {
      files.push({ url: url[1].trim(), block: [line] })
      continue
    }
    if (!line.startsWith("    ")) break
    files.at(-1)?.block.push(line)
  }
  return { version: take("version"), releaseDate: take("releaseDate"), files }
}

function blockSha512(block) {
  return (block.join("\n").match(/^\s+sha512: (.+)$/m) || [])[1]?.trim() ?? null
}

mkdirSync(outputDir, { recursive: true })

const fragments = new Map()
for (const path of walk(inputDir)) {
  const name = basename(path)
  if (FEED.test(name)) {
    fragments.set(name, [...(fragments.get(name) ?? []), path])
    continue
  }
  copyFileSync(path, join(outputDir, name))
}

for (const [name, paths] of fragments) {
  const parsed = paths.map((path) => parse(readFileSync(path, "utf8")))

  const versions = [...new Set(parsed.map((feed) => feed.version))]
  if (versions.length !== 1) {
    console.error(`${name}: fragments disagree on version (${versions.join(", ")}); refusing to merge`)
    process.exit(1)
  }

  const seen = new Set()
  const files = parsed
    .flatMap((feed) => feed.files)
    .filter((file) => !seen.has(file.url) && seen.add(file.url))
  if (files.length === 0) {
    console.error(`${name}: no files to publish`)
    process.exit(1)
  }

  const primary = files.find((file) => PREFERRED.test(file.url)) ?? files[0]
  const releaseDate = parsed.map((feed) => feed.releaseDate).filter(Boolean).sort().at(-1)

  writeFileSync(
    join(outputDir, name),
    [
      `version: ${versions[0]}`,
      "files:",
      ...files.flatMap((file) => file.block),
      `path: ${primary.url}`,
      `sha512: ${blockSha512(primary.block)}`,
      ...(releaseDate ? [`releaseDate: ${releaseDate}`] : []),
      "",
    ].join("\n"),
  )
  console.log(`${name}: ${files.map((file) => file.url).join(", ")}`)
}
