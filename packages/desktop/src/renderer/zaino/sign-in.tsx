import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { zainoT } from "./messages"
import { ZainoMark } from "./mark"
import { HalloweenBackground } from "./halloween-bg"
import type { ElectronAPI } from "../api-types"
import type { ZainoDevicePhase, ZainoQuota } from "../../shared/ipc-rpc/zaino"

type Phase = ZainoDevicePhase
type Quota = ZainoQuota

/**
 * Zaino sign-in surface.
 *
 * Owns only DISPLAY state. The `zn-…` key never reaches this component: the
 * main process holds it in memory, writes it to the OS keychain, and pushes
 * the environment variable into the sidecar. What crosses the bridge is the
 * user code, the verification URL, the phase, and (after approval) the
 * alias list and quota snapshot.
 *
 * Phases mirror the device flow: Idle → AwaitingBrowser → Approved |
 * Expired | Cancelled | Error.
 */
export function ZainoSignIn(props: { api: ElectronAPI; onDone?: () => void }) {
  const [phase, setPhase] = createSignal<Phase>({ _tag: "Idle" })
  const [pasted, setPasted] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [quota, setQuota] = createSignal<Quota | null>(null)

  // The phase and the quota are discriminated unions, and Solid's `Show`
  // does not narrow its children. Each branch therefore resolves through a
  // memo, which keeps the narrowing at the single place that knows it.
  const awaiting = createMemo(() => {
    const current = phase()
    return current._tag === "AwaitingBrowser" ? current : undefined
  })
  const approved = createMemo(() => {
    const current = phase()
    return current._tag === "Approved" ? current : undefined
  })
  const failure = createMemo(() => {
    const current = phase()
    if (current._tag === "Expired") return zainoT("expired")
    if (current._tag === "Cancelled") return zainoT("cancelled")
    if (current._tag === "Error")
      return current.message
        ? `${zainoT("error")} ${zainoT("errorDetail", { detail: current.message })}`
        : zainoT("error")
    return undefined
  })
  const okQuota = createMemo(() => {
    const current = quota()
    return current?._tag === "Ok" ? current : undefined
  })
  const exhausted = createMemo(() => {
    const current = quota()
    return current?._tag === "Exhausted" ? current : undefined
  })

  const off = props.api.zaino.onPhase((next) => {
    setPhase(next)
    if (next._tag === "Approved") void refreshUsage()
  })
  onCleanup(off)

  async function refreshUsage() {
    try {
      const result = await props.api.zaino.readUsage()
      setQuota(result?.quota ?? null)
    } catch {
      setQuota(null)
    }
  }

  async function begin() {
    setBusy(true)
    try {
      await props.api.zaino.deviceBegin()
    } finally {
      setBusy(false)
    }
  }

  async function cancel() {
    await props.api.zaino.deviceCancel()
    setPhase({ _tag: "Idle" })
  }

  async function submitPasted() {
    setBusy(true)
    try {
      const result = await props.api.zaino.setKey(pasted().trim())
      setPhase({ _tag: "Approved", models: result.models })
      await refreshUsage()
      props.onDone?.()
    } catch (error) {
      setPhase({ _tag: "Error", message: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  async function signOut() {
    setBusy(true)
    try {
      await props.api.zaino.clearKey()
      setPhase({ _tag: "Idle" })
      setQuota(null)
      setPasted("")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="flex h-full w-full items-center justify-center p-6 relative">
      <HalloweenBackground class="absolute inset-0 w-full h-full object-cover object-center" />
      <div class="relative z-10 w-full max-w-md rounded-2xl border border-border-base/60 bg-background-base/80 backdrop-blur-md p-6 shadow-sm text-foreground-base">
        <ZainoMark class="h-14 w-14" />
        <h1 class="mt-4 text-lg font-semibold">{zainoT("title")}</h1>
        <p class="mt-1 text-sm text-foreground-muted">{zainoT("subtitle")}</p>

        <Show when={awaiting()} keyed>
          {(current) => (
            <div class="mt-5 rounded-xl border border-border-base p-4">
              <p class="text-xs uppercase tracking-wide text-foreground-muted">{zainoT("codeLabel")}</p>
              <p class="mt-1 font-mono text-2xl tracking-widest">{current.userCode}</p>
              <p class="mt-3 text-sm text-foreground-muted">{zainoT("waitingHint")}</p>
              <a class="mt-2 inline-block text-sm underline" href={current.verificationUrl} target="_blank" rel="noreferrer">
                {current.verificationUrl}
              </a>
              <button class="mt-4 text-sm underline" onClick={() => void cancel()}>
                {zainoT("cancel")}
              </button>
            </div>
          )}
        </Show>

        <Show when={approved()} keyed>
          {(current) => (
            <div class="mt-5 rounded-xl border border-border-base p-4">
              <p class="text-sm font-medium">{zainoT("approved")}</p>
              <Show when={current.models.length > 0}>
                <p class="mt-1 text-sm text-foreground-muted">
                  {zainoT("signedInAs", { models: current.models.join(", ") })}
                </p>
              </Show>
              <Show when={okQuota()} keyed>
                {(currentQuota) => (
                  <>
                    <p class="mt-2 text-xs uppercase tracking-wide text-foreground-muted">{zainoT("usageTitle")}</p>
                    <ul class="mt-1 grid gap-1 text-sm text-foreground-muted">
                      {Object.entries(currentQuota.limits).map(([alias, limit]) => (
                        <li>
                          {zainoT("usageLine", {
                            remaining: currentQuota.remaining[alias] ?? 0,
                            limit,
                            model: alias,
                          })}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </Show>
              <Show when={exhausted()} keyed>
                {(currentQuota) => (
                  <p class="mt-2 text-sm text-danger">
                    {zainoT("usageExhausted", { models: currentQuota.models.join(", ") })}
                  </p>
                )}
              </Show>
              <Show when={quota() && quota()?._tag !== "Ok" && quota()?._tag !== "Exhausted"}>
                <p class="mt-2 text-sm text-foreground-muted">{zainoT("usageUnknown")}</p>
              </Show>
              <div class="mt-4 flex gap-4">
                <button class="text-sm underline" onClick={() => props.onDone?.()}>
                  {zainoT("retry")}
                </button>
                <button class="text-sm underline" disabled={busy()} onClick={() => void signOut()}>
                  {zainoT("signOut")}
                </button>
              </div>
            </div>
          )}
        </Show>

        <Show when={failure()} keyed>
          {(message) => (
            <div class="mt-5 rounded-xl border border-border-base p-4 text-sm">
              <p>{message}</p>
              <button class="mt-3 text-sm underline" onClick={() => void begin()}>
                {zainoT("retry")}
              </button>
            </div>
          )}
        </Show>

        <Show when={phase()._tag === "Idle"}>
          <div class="mt-5 flex flex-col gap-3">
            <button
              class="rounded-lg bg-foreground-base px-4 py-2 text-sm font-medium text-background-base disabled:opacity-50"
              disabled={busy()}
              onClick={() => void begin()}
            >
              {zainoT("signIn")}
            </button>

            <div class="flex items-center gap-2">
              <input
                class="flex-1 rounded-lg border border-border-base bg-transparent px-3 py-2 text-sm outline-none"
                placeholder={zainoT("pasteKeyPlaceholder")}
                value={pasted()}
                onInput={(e) => setPasted(e.currentTarget.value)}
              />
              <button
                class="rounded-lg border border-border-base px-3 py-2 text-sm disabled:opacity-50"
                disabled={!pasted().startsWith("zn-") || busy()}
                onClick={() => void submitPasted()}
              >
                {zainoT("pasteKeySubmit")}
              </button>
            </div>
          </div>
        </Show>
      </div>
    </div>
  )
}
