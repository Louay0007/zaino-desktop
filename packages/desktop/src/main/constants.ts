import { app } from "electron"

type Channel = "local" | "dev" | "beta" | "prod"

const raw = import.meta.env.OPENCODE_CHANNEL

export const CHANNEL: Channel = raw === "local" || raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export const VERSION = app.isPackaged ? app.getVersion() : (process.env.OPENCODE_VERSION ?? app.getVersion())

const appNames: Record<string, string> = {
  dev: "Zaino AI Agent Dev",
  beta: "Zaino AI Agent Beta",
  prod: "Zaino AI Agent",
}

const appIDs: Record<string, string> = {
  dev: "ai.zaino.desktop.dev",
  beta: "ai.zaino.desktop.beta",
  prod: "ai.zaino.desktop",
}

// Local renderer/server mode keeps the dev application identity.
export const APP_NAME = app.isPackaged ? appNames[CHANNEL] : "Zaino AI Agent Dev"

export const APP_ID = app.isPackaged ? appIDs[CHANNEL] : "ai.zaino.desktop.dev"
