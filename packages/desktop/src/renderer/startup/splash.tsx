import type { Platform } from "@opencode/app/desktop"
import { ZainoMark } from "../zaino/mark"
import { HalloweenBackground } from "../zaino/halloween-bg"
import { Show } from "solid-js"

export function LoadingSplash(props: {
  deep: boolean
  firstLaunch: boolean
  platform: Platform
  preview: boolean
  onDrawEnd: () => void
}) {
  // The splash resolves immediately: the Zaino mark is a static image, not
  // a draw-on animation, so there is nothing to wait for.
  queueMicrotask(() => props.onDrawEnd())
  const titlebarHeight = () => {
    const zoom = props.platform.webviewZoom?.() ?? 1

    if (props.platform.os === "macos") return `max(36px, ${36 / zoom}px)`

    if (props.platform.os === "windows")
      return `max(36px, env(titlebar-area-height, ${44 / Math.min(Math.max(zoom, 0.25), 1)}px))`

    return "36px"
  }

  return (
    <Show
      when={props.firstLaunch}
      fallback={
        <div
          data-component="startup-splash"
          class="h-dvh w-screen flex flex-col items-center justify-center relative"
        >
          <HalloweenBackground class="absolute inset-0 w-full h-full object-cover object-center" />
          <ZainoMark class="relative z-10 w-16 h-16 opacity-90 animate-pulse" />
        </div>
      }
    >
      <div
        data-component="first-launch-splash"
        aria-hidden="true"
        class="h-dvh w-screen relative"
        style={{
          // Match the default session's titlebar, panel insets, and wordmark position.
          "padding-block-start": `calc(${titlebarHeight()} + ${props.platform.os === "windows" ? 1 : 8}px)`,
          "padding-block-end": "8px",
          "padding-inline": "32px",
        }}
      >
        <HalloweenBackground class="absolute inset-0 w-full h-full object-cover object-center" />
        <div class="relative size-full">
          <div class="absolute inset-x-0 top-[25.375%]">
            <div class="mx-auto w-full max-w-[720px] flex flex-col items-center gap-6">
              <ZainoMark class="block h-28 w-28 opacity-90" />
              <p class="text-center text-2xl font-semibold tracking-tight text-foreground-base">
                Zaino AI Agent
              </p>
            </div>
          </div>
        </div>
      </div>
    </Show>
  )
}
