/**
 * Copy for the Zaino sign-in surface.
 *
 * The project's rule is that user-visible English lives in the shared typed
 * i18n layer (@opencode/app), never inline. That layer is not checked out
 * here, so these strings live in a local, typed, single-source catalog
 * instead of being inlined in the component — and every call site resolves
 * through `zainoT` so moving them into the shared layer is a one-file
 * change when the monorepo is available.
 *
 * English is the source copy. Do not edit the English text to make a
 * translation easier; adapt the locale around it.
 */

export const ZAINO_MESSAGES = {
  "title": "Sign in to Zaino",
  "subtitle": "Your browser approves the device. The key goes straight to your OS keychain.",
  "signIn": "Sign in with Zaino",
  "pasteKey": "Paste a device key",
  "pasteKeyPlaceholder": "zn-…",
  "pasteKeySubmit": "Use this key",
  "cancel": "Cancel",
  "retry": "Try again",
  "waiting": "Waiting for approval",
  "waitingHint": "Approve the code in your browser to continue.",
  "codeLabel": "Your code",
  "approved": "Signed in",
  "expired": "That code expired. Start a new sign-in.",
  "cancelled": "Sign-in cancelled.",
  "error": "Sign-in failed. Try again.",
  "errorDetail": "{detail}",
  "usage": "Prompt quota",
  "usageUnknown": "Prompt quota unavailable.",
  "usageRemaining": "{remaining} of {limit} prompts left",
  "usageLine": "{remaining} of {limit} {model}",
  "usageTitle": "Prompts left this period",
  "signedInAs": "Signed in — {models}",
  "viewQuota": "View quota",
  "quotaHeading": "Quota",
  "usageExhausted": "Your {models} prompt allowance is used up. Upgrade your plan to keep going.",
  "signOut": "Sign out",
  "modelLabel": "Model",
  "planLabel": "Plan",
} as const

export type ZainoMessageKey = keyof typeof ZAINO_MESSAGES

export function zainoT(key: ZainoMessageKey, params?: Record<string, string | number>): string {
  const template = ZAINO_MESSAGES[key]
  if (!params) return template

  return template.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  )
}
