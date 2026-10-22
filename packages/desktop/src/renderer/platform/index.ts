import type { Platform } from "@opencode/app/desktop"
import type { ElectronAPI } from "../api-types"
import { setPinchZoomEnabled, webviewZoom } from "../window/zoom"
import { windowFullscreen } from "../window/fullscreen"
import { DragCancelEvent } from "../../shared/ipc-transport"
import { createExtensionBridge } from "../extensions"
import { createDesktopFiles } from "./files"
import { createDesktopMenuAction } from "./menu"
import { createDesktopNotify } from "./notifications"
import { createDesktopStorage } from "./storage"
import { aliasOfRequestBody, createQuotaGate, parseBody, PROMPT_PATH } from "../zaino/gate"

export type DesktopWindowState = {
  id: string
  version: string
}

export function createDesktopPlatform(api: ElectronAPI, windowState: DesktopWindowState): Platform {
  const os = desktopOS()
  const quota = createQuotaGate(api)

  return {
    platform: "desktop",
    os,
    version: windowState.version,
    windowID: windowState.id,
    ...createDesktopFiles(api, os),
    ...createDesktopStorage(api),
    exportDebugLogs: () => api.exportDebugLogs(),
    setForceFocus: (enabled) => api.setForceFocus(enabled),
    recordFatalRendererError: (error) => api.recordFatalRendererError(error),
    restart: async () => api.relaunch(),
    notify: createDesktopNotify(api),
    fetch: (input, init) => {
      if (input instanceof Request) return fetch(input)

      return guardPromptQuota(input, init, quota)
    },
    webviewZoom,
    windowFullscreen,
    getPinchZoomEnabled: () => api.getPinchZoomEnabled(),
    setPinchZoomEnabled,
    onDragCancel: (callback) => {
      window.addEventListener(DragCancelEvent, callback)

      return () => window.removeEventListener(DragCancelEvent, callback)
    },
    runDesktopMenuAction: createDesktopMenuAction(api),
    checkAppExists: async (appName) => {
      return api.checkAppExists(appName)
    },
    extensions: createExtensionBridge(),
  }
}

/**
 * Refuse a prompt the gateway would not serve anyway.
 *
 * The gateway's only customer-facing limit is the prompt count, and it
 * enforces nothing server-side — the token budgets are all effectively
 * unlimited. Without a gate here, the app would happily keep sending after
 * the customer is out of prompts, and the requests would fail upstream
 * instead of the customer being told why.
 *
 * The gate reads the portal's own ledger, so it says exactly what the
 * gateway would say. A snapshot it cannot read leaves the request alone:
 * the gate must never cut off a paying customer because the portal was
 * briefly unreachable.
 */
async function guardPromptQuota(
  input: string | URL | Request,
  init: RequestInit | undefined,
  quota: ReturnType<typeof createQuotaGate>,
) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const method = init?.method ?? (input instanceof Request ? input.method : "GET")

  if (method !== "POST" || !PROMPT_PATH.test(new URL(url, "http://localhost").pathname)) {
    return fetch(input, init)
  }

  const alias = aliasOfRequestBody(parseBody(init?.body))
  const decision = await quota.check(alias)

  if (decision.allowed) return fetch(input, init)

  throw new Error(
    `Your Zaino plan has no ${decision.alias} prompts left this period. Upgrade the plan to keep going.`,
  )
}


function desktopOS() {
  if (navigator.userAgent.includes("Mac")) return "macos"

  if (navigator.userAgent.includes("Windows")) return "windows"

  if (navigator.userAgent.includes("Linux")) return "linux"

  return undefined
}
