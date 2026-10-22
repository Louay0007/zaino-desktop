import zainoLogo from "@/providers/zaino-logo.png"

/**
 * The Zaino gateway mark for provider and model surfaces.
 *
 * The upstream `@opencode/ui` provider sprite stays untouched: it is the
 * shared brand system. Where the picker, settings, and composer render the
 * desktop's own `zaino` provider, they show its own tile — a white curved-Z
 * on a dark rounded square that stays legible at icon size on light and
 * dark UI.
 */
export function ZainoLogo(props: { class?: string }) {
  return <img data-component="zaino-logo" src={zainoLogo} alt="" class={props.class} />
}
