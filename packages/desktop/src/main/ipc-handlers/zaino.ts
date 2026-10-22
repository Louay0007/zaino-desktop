import { Effect } from "effect"
import { app } from "electron"
import { ZainoRpcs } from "../../shared/ipc-rpc"
import { IpcPortHandoff } from "../ipc-transport"
import { emitIpcEvent } from "../ipc-events"
import { ZainoDevicePhaseChanged } from "../../shared/ipc-rpc/events"
import { begin, cancel, clearKey, modelLimits, readKey, setPastedKey } from "../zaino/device"
import { DEFAULT_GATEWAY_URL, DEFAULT_PORTAL_URL } from "../zaino/provider"
import { deriveQuota, fetchUsage } from "../zaino/quota"
import { writeProvider } from "../zaino/config"
import { BackgroundService } from "../service/background-service"
import { sender } from "./context"

/**
 * Zaino gateway handlers.
 *
 * The credential stays on this side of the boundary: the renderer asks for
 * a sign-in to start, receives display data and quota numbers, and never
 * sees the `zn-…` body. The key lives in the OS keychain and in the
 * sidecar's environment.
 */
export const zainoHandlers = ZainoRpcs.toLayer(
  Effect.gen(function* () {
    const handoff = yield* IpcPortHandoff
    const background = yield* BackgroundService.Service
    // `restart` is already fully provided by the service layer, so it runs
    // without needing the surrounding context.
    const restart = () => Effect.runPromise(background.restart)

    return ZainoRpcs.of({
      ZainoDeviceBegin: ({ portalUrl }, context) =>
        Effect.sync(() => {
          const contents = sender(handoff, context)
          void begin(
            portalUrl || DEFAULT_PORTAL_URL,
            (phase) => {
              emitIpcEvent(contents, new ZainoDevicePhaseChanged({ phase }))
            },
            // The sidecar keeps the environment it was started with, so a new
            // credential only reaches the gateway through a new sidecar.
            async () => {
              await restart()
            },
          )

          return { ok: true }
        }),
      ZainoDeviceCancel: (_request, context) =>
        Effect.sync(() => {
          cancel(() => undefined)

          return { ok: true }
        }),
      ZainoKeySet: ({ key }) =>
        Effect.promise(() =>
          setPastedKey(key, DEFAULT_GATEWAY_URL, DEFAULT_PORTAL_URL).then(async (models) => {
            // The running sidecar keeps the environment it was started with,
            // so a new credential only reaches the gateway through a new
            // sidecar. Restart it with the keychain credential.
            await restart()

            return { ok: true, models }
          }),
        ),
      ZainoKeyState: () => Effect.sync(() => ({ hasKey: !!readKey() })),
      ZainoKeyClear: () =>
        Effect.promise(async () => {
          clearKey()
          // The sidecar keeps the environment it was started with, so the
          // old credential stays reachable until the process is replaced.
          // Restart it with no credential so a signed-out app cannot keep
          // talking to the gateway on a revoked key.
          await restart()

          return { ok: true }
        }),
      ZainoUsageRead: ({ portalUrl }) =>
        Effect.promise(async () => {
          const key = readKey()
          if (!key) return { snapshot: null, quota: { _tag: "Unknown" as const } }
          try {
            const snapshot = await fetchUsage(portalUrl || DEFAULT_PORTAL_URL, key)
            // Keep the provider config in step with the current entitlement:
            // a plan upgrade or downgrade changes the allowed alias set, and
            // the limits the gateway advertises ride along with it.
            try {
              writeProvider(snapshot.models ?? [], undefined, await modelLimits(key), app.getPath("userData"))
            } catch (error) {
              console.error("[zaino] failed to refresh provider config", error)
            }
            return { snapshot, quota: deriveQuota(snapshot) }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (message === "unauthorized") {
              // A revoked or expired key fails closed: clear the local copy
              // and let the app prompt for sign-in again. Never fall back
              // silently.
              clearKey()
              return { snapshot: null, quota: { _tag: "Unauthorized" as const } }
            }
            return { snapshot: null, quota: deriveQuota(null, message) }
          }
        }),
    })
  }),
)
