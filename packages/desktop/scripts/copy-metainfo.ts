import { resolveChannel } from "./utils"

const arg = process.argv[2]

const channel = arg === "dev" || arg === "beta" || arg === "prod" ? arg : resolveChannel()

const appId = channel === "prod" ? "ai.zaino.desktop" : `ai.zaino.desktop.${channel}`

const productName = channel === "prod" ? "Zaino AI Agent" : `Zaino AI Agent ${channel.charAt(0).toUpperCase() + channel.slice(1)}`

const summary = `Zaino AI Agent — desktop client for the Zaino Gateway${channel !== "prod" ? ` (${channel})` : ""}`

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${appId}</id>

  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MIT</project_license>

  <name>${productName}</name>
  <summary>${summary}</summary>

  <developer id="ly.anoma">
    <name>Anomaly Innovations Inc.</name>
  </developer>

  <description>
    <p>
      Zaino AI Agent is the desktop client for the Zaino Gateway — Fast, Smart and Frontier models, signed in with your gateway account.
    </p>
  </description>

  <launchable type="desktop-id">${appId}.desktop</launchable>

  <content_rating type="oars-1.1" />

  <url type="bugtracker">https://github.com/Louay0007/zaino-desktop/issues</url>
  <url type="homepage">https://zaino.soon.it</url>
  <url type="vcs-browser">https://github.com/Louay0007/zaino-desktop</url>

  <screenshots>
    <screenshot type="default">
      <image>https://raw.githubusercontent.com/Louay0007/zaino-desktop/main/packages/web/src/assets/lander/screenshot.png</image>
    </screenshot>
  </screenshots>
</component>
`

await Bun.write(`resources/${appId}.metainfo.xml`, xml)

console.log(`Generated metainfo for ${channel} at resources/${appId}.metainfo.xml`)
