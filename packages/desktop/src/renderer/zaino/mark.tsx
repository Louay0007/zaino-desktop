import zainoMark from "../assets/zaino-mark.png"

/**
 * The Zaino app mark for desktop-owned surfaces (splash, sign-in).
 *
 * The shared @opencode/ui logo components stay untouched: they are the
 * upstream brand system used by web and TUI surfaces outside this shell.
 * Where the DESKTOP app speaks for itself — its own splash, its own
 * sign-in — it shows its own mark.
 */
export function ZainoMark(props: { class?: string; alt?: string }) {
  return <img src={zainoMark} alt={props.alt ?? "Zaino"} class={props.class} draggable={false} />
}
