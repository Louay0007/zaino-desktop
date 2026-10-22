import halloweenBg from "../assets/zaino-halloween-bg.jpg"

export function HalloweenBackground(props: { class?: string }) {
  return (
    <img
      src={halloweenBg}
      alt=""
      aria-hidden="true"
      draggable={false}
      class={props.class}
      style={{ "object-fit": "cover", "object-position": "center" }}
    />
  )
}
