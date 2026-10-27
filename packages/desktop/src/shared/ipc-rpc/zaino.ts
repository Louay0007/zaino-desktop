import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

/**
 * The Zaino gateway contract, as the renderer sees it.
 *
 * Two rules hold across every payload here:
 *   1. The `zn-…` credential NEVER crosses this boundary. The renderer
 *      receives display data (user code, verification URL), the alias list,
 *      and quota numbers — never the key body.
 *   2. Only aliases cross. `fast` / `smart` / `frontier` — the upstream
 *      model names never appear.
 */

export const ZainoDevicePhase = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Idle") }),
  Schema.Struct({
    _tag: Schema.Literal("AwaitingBrowser"),
    userCode: Schema.String,
    verificationUrl: Schema.String,
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    _tag: Schema.Literal("Approved"),
    models: Schema.Array(Schema.String),
  }),
  Schema.Struct({ _tag: Schema.Literal("Expired") }),
  Schema.Struct({ _tag: Schema.Literal("Cancelled") }),
  Schema.Struct({ _tag: Schema.Literal("Error"), message: Schema.String }),
])

export type ZainoDevicePhase = typeof ZainoDevicePhase.Type

export const ZainoUsageSnapshot = Schema.Struct({
  planCode: Schema.NullOr(Schema.String),
  models: Schema.Array(Schema.String),
  promptLimits: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  promptsByModel: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  tokenLimits: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  tokensByModel: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  remainingTokensByModel: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  tokenExhausted: Schema.optional(Schema.Array(Schema.String)),
  exhaustedByModel: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(Schema.Literal("tokens")))),
  periodStart: Schema.String,
  periodEnd: Schema.String,
})

export type ZainoUsageSnapshot = typeof ZainoUsageSnapshot.Type

export const ZainoQuota = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Unknown") }),
  Schema.Struct({
    _tag: Schema.Literal("Ok"),
    models: Schema.Array(Schema.String),
    remaining: Schema.Record(Schema.String, Schema.Number),
    limits: Schema.Record(Schema.String, Schema.Number),
  }),
  Schema.Struct({
    _tag: Schema.Literal("Exhausted"),
    // Every alias with no tokens left — the sign-in surface shows the whole
    // list, scoped to the alias the user is about to use, instead of
    // whichever alias the server happened to iterate first.
    models: Schema.Array(Schema.String),
  }),
  Schema.Struct({ _tag: Schema.Literal("Unauthorized") }),
  Schema.Struct({ _tag: Schema.Literal("Error"), message: Schema.String }),
])

export type ZainoQuota = typeof ZainoQuota.Type

export const ZainoDeviceBegin = Rpc.make("ZainoDeviceBegin", {
  payload: { portalUrl: Schema.optional(Schema.String) },
  success: Schema.Struct({ ok: Schema.Boolean }),
})

export const ZainoDeviceCancel = Rpc.make("ZainoDeviceCancel", { success: Schema.Struct({ ok: Schema.Boolean }) })

export const ZainoKeySet = Rpc.make("ZainoKeySet", {
  payload: { key: Schema.String },
  success: Schema.Struct({ ok: Schema.Boolean, models: Schema.Array(Schema.String) }),
})

export const ZainoKeyState = Rpc.make("ZainoKeyState", {
  success: Schema.Struct({ hasKey: Schema.Boolean }),
})

export const ZainoKeyClear = Rpc.make("ZainoKeyClear", { success: Schema.Struct({ ok: Schema.Boolean }) })

export const ZainoUsageRead = Rpc.make("ZainoUsageRead", {
  payload: { portalUrl: Schema.optional(Schema.String) },
  success: Schema.Struct({
    snapshot: Schema.NullOr(ZainoUsageSnapshot),
    quota: ZainoQuota,
  }),
})

export const ZainoRpcs = RpcGroup.make(
  ZainoDeviceBegin,
  ZainoDeviceCancel,
  ZainoKeySet,
  ZainoKeyState,
  ZainoKeyClear,
  ZainoUsageRead,
)
