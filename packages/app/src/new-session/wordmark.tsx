import { ZainoLogo } from "@/providers/zaino-logo"
import "./wordmark.css"

export function NewSessionWordmark() {
  return (
    <div
      data-component="new-session-wordmark"
      aria-hidden="true"
      class="pointer-events-none mx-auto w-full max-w-[720px] text-v2-background-bg-inverse"
    >
      <div data-slot="wordmark-reveal" class="relative mx-auto flex justify-center">
        <ZainoLogo class="block h-28 w-28 opacity-90" />
      </div>
    </div>
  )
}
