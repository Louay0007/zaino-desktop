# Zaino AI Agent — Desktop

Standalone desktop client for the **Zaino Gateway** — Fast, Smart and Frontier models, signed in with your gateway account.

- **Product:** Zaino AI Agent Beta
- **Version:** 1.1.5
- **Auto-updates:** via GitHub Releases on this repo (electron-updater)
- **Gateway:** https://zaino.soon.it

## Download

Grab the latest Beta from the [Releases page](../../releases):

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `zaino-desktop-mac-arm64.dmg` |
| macOS (Intel) | `zaino-desktop-mac-x64.dmg` |
| Windows (x64 / ARM64) | `zaino-desktop-win-*.exe` |
| Linux | `*.AppImage`, `*.deb`, `*.rpm` |

The app checks for updates automatically and offers in-app install + restart.

## Build from source

Requirements: [Bun](https://bun.sh) 1.4.x, Node 24.

```bash
bun install
cd packages/desktop
OPENCODE_CHANNEL=beta OPENCODE_VERSION=1.1.5 ZAINO_UNSIGNED=1 \
  OPENCODE_CLI_TARGET=aarch64-apple-darwin \
  bun ./scripts/prepare.ts
bun run build
npx electron-builder --mac --publish never --config electron-builder.config.ts
```

## Release a new version

1. Bump `version` in `packages/desktop/package.json`.
2. Push tag `v<version>` (or run the **release** workflow manually with the version input).
3. The workflow builds the sidecar CLI + desktop for mac (arm64/x64), Windows (x64/arm64) and Linux (x64/arm64), then publishes a prerelease on GitHub — the app picks it up automatically.

## Sign-in

The desktop signs in against the Zaino Gateway. Your `zn-...` key is stored only in the OS keychain and the sidecar environment — never in files, the renderer, or logs.

## License

MIT — see [LICENSE](LICENSE).
