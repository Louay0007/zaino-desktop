/// <reference path="./env.d.ts" />

// Load the complete preload contract before App's optional browser bridge declaration.
import {
  AppBaseProviders,
  AppInterface,
  currentRoute,
  PlatformProvider,
  preloadRoute,
  ServerConnection,
  useCommand,
  useCurrentRoute,
  useLanguage,
  useExtensionServers,
  useTabs,
  type LayoutRoute,
} from "@opencode/app/desktop"
import { useTheme } from "@opencode/ui/theme/context"
import type { BaseRouterProps } from "@solidjs/router"
import { createEffect, createMemo, createResource, lazy, Show, Suspense } from "solid-js"
import { createStore } from "solid-js/store"
import type { ElectronAPI } from "./api-types"
import { DesktopFirstLaunchOnboarding } from "./onboarding"
import { createDesktopPlatform } from "./platform"
import { bindDesktopMenu } from "./platform/menu"
import { createSidecarResolver, initializationData, sidecarHttp } from "./startup/initialization"
import { preloadStoredLocale } from "./startup/locale"
import { LoadingSplash } from "./startup/splash"
import { getLastActiveUrl } from "./window/route-storage"
import { DesktopMemoryRouter } from "./window/router"
import { ZainoSignIn } from "./zaino/sign-in"

const MigrationStatus = lazy(() => import("./migration-status").then((module) => ({ default: module.MigrationStatus })))

export function DesktopApp(props: { api: ElectronAPI; version: string }) {
  const windowState = { id: props.api.getWindowID(), version: props.version }
  const initialUrl = getLastActiveUrl(windowState.id)
  const url = new URL(initialUrl, "http://localhost")
  const route = currentRoute(url.pathname, url.search)

  const [startup, setStartup] = createStore({
    ready: false,
    visible: true,
    themeReady: false,
    onboardingReady: false,
    drawingReady: false,
    route,
  })

  // The window was created with the answers the shell gate needs; only a fresh install, which has no
  // onboarding decision yet, asks over IPC and waits for the port.
  const bootstrap = props.api.getWindowBootstrap()

  const [firstLaunch] = createResource(() =>
    bootstrap.firstLaunchPending !== undefined
      ? Promise.resolve(bootstrap.firstLaunchPending)
      : props.api.isFirstLaunchOnboardingPending().catch((error) => {
          console.error("[desktop-onboarding] first launch check failed", error)

          return false
        }),
  )

  const platform = createDesktopPlatform(props.api, windowState)

  // Sign-in gate. A Zaino client with no key cannot talk to the gateway, so
  // the surface is shown until a device key is stored — and until that key
  // proves valid. A restart-within-30-days with a key the server revoked
  // must land on the gate, not boot into a chat whose first prompt fails.
  // The resource is refetched after a sign-in or sign-out because the
  // keychain changes under it.
  const [hasKey, { refetch: refetchKey }] = createResource(async () => {
    try {
      const state = await props.api.zaino.hasKey()
      if (!state.hasKey) return false
      const usage = await props.api.zaino.readUsage()
      // The usage call fails closed on a revoked key (main process clears
      // it); any other failure leaves the key alone, because the portal
      // being unreachable is not the same as being signed out.
      return usage?.quota?._tag !== "Unauthorized"
    } catch {
      return false
    }
  })
  const [sidecar, { mutate: setSidecar }] = createResource(() => props.api.awaitInitialization())

  // A sign-in replaces the sidecar — the new credential only reaches the
  // gateway through a new process — so the endpoint can change. Refresh it
  // once the main process reports the approval.
  createEffect(() => {
    const off = props.api.zaino.onPhase((phase: any) => {
      if (phase?._tag !== "Approved") return
      void props.api.reconnectService().then(setSidecar).catch(() => undefined)
      void refetchKey()
    })
    return () => off()
  })

  const [locale] = createResource(() => preloadStoredLocale(platform))

  const [initialRoute] = createResource(
    () => !firstLaunch.loading && (firstLaunch() && initialUrl === "/" ? "/new-session" : initialUrl),
    preloadRoute,
  )

  const router = (routerProps: BaseRouterProps) => <DesktopMemoryRouter {...routerProps} windowID={windowState.id} />

  const readyToReveal = () =>
    startup.ready &&
    (!import.meta.env.OPENCODE_TEST_ONBOARDING || !firstLaunch() || initialUrl !== "/" || startup.drawingReady)

  // Reveal only after the theme and the first-launch splash choice are both resolved.
  createEffect(() => {
    if (!startup.themeReady || firstLaunch.loading) return
    void props.api.themeReady()
  })

  function ReadyApp() {
    const extensions = useExtensionServers()
    const language = useLanguage()

    const ready = createMemo(() => !firstLaunch.loading && !sidecar.loading && !locale.loading && extensions.ready())

    const servers = createMemo(() => {
      const data = initializationData(sidecar)
      const list: ServerConnection.Any[] = []

      if (data) {
        list.push({
          displayName: language.t("desktop.server.local"),
          type: "sidecar",
          variant: "base",
          http: sidecarHttp(data),
          reconnect: createSidecarResolver({ api: props.api, current: sidecar, update: setSidecar }),
        })
      }

      list.push(...extensions.list())

      return list
    })

    return (
      <Show when={ready()}>
        <AppInterface servers={servers()} router={router}>
          <DesktopStartupReady
            routeReady={!initialRoute.loading && startup.onboardingReady}
            onReady={() => setStartup("ready", true)}
            onRoute={(route) => setStartup("route", route)}
          />
          <DesktopFirstLaunchOnboarding
            api={props.api}
            initialUrl={initialUrl}
            pending={firstLaunch() ?? false}
            onReady={() => setStartup("onboardingReady", true)}
          />
          <DesktopEffects api={props.api} />
          <Suspense fallback={null}>
            <Show when={initializationData(sidecar)} keyed>
              {(server) => <MigrationStatus server={server} />}
            </Show>
          </Suspense>
        </AppInterface>
      </Show>
    )
  }

  return (
    <PlatformProvider value={platform}>
      <AppBaseProviders
        locale={locale.latest}
        onNativeTranslations={(bundle) => void props.api.setNativeTranslations(bundle).catch(() => undefined)}
        onThemeApplied={(mode, scheme) => {
          void props.api.setTitlebar({ mode, scheme })
          setStartup("themeReady", true)
        }}
      >
        <Show when={true}>{(_) => <ReadyApp />}</Show>
        <Show when={!hasKey.loading && hasKey() === false}>
          <div class="fixed inset-0 z-[110]">
            <ZainoSignIn api={props.api} onDone={() => void refetchKey()} />
          </div>
        </Show>
        <Show when={!firstLaunch.loading && startup.visible}>
          <div
            data-component="startup-overlay"
            class="fixed inset-0 z-[100] transition-opacity duration-300 ease-out"
            classList={{ "pointer-events-none opacity-0": readyToReveal() }}
            onTransitionEnd={(event) => {
              if (event.target !== event.currentTarget || !readyToReveal()) return
              setStartup("visible", false)
            }}
          >
            <LoadingSplash
              firstLaunch={!!firstLaunch() && initialUrl === "/"}
              deep={startup.route.type === "draft"}
              platform={platform}
              preview={import.meta.env.OPENCODE_TEST_ONBOARDING}
              onDrawEnd={() => setStartup("drawingReady", true)}
            />
          </div>
        </Show>
      </AppBaseProviders>
    </PlatformProvider>
  )
}

function DesktopStartupReady(props: {
  routeReady: boolean
  onReady: () => void
  onRoute: (route: LayoutRoute) => void
}) {
  const tabs = useTabs()
  const route = useCurrentRoute()
  createEffect(() => props.onRoute(route()))
  createEffect(() => {
    if (!props.routeReady || !tabs.ready() || !tabs.infoReady()) return
    props.onReady()
  })

  return null
}

function DesktopEffects(props: { api: ElectronAPI }) {
  const command = useCommand()
  bindDesktopMenu((id) => command.trigger(id))
  const theme = useTheme()

  createEffect(() => {
    theme.themeId()
    theme.mode()
    const background = getComputedStyle(document.documentElement).getPropertyValue("--background-base").trim()

    if (background) void props.api.setBackgroundColor(background)
  })

  return null
}
