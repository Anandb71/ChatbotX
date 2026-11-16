import { z } from "zod"

/**
 * External systems a workspace can import contacts from. Each value has one
 * adapter in `@chatbotx.io/business/contact-sync`; the run tables and the
 * engine know nothing provider-specific.
 */
export const contactSyncProviders = z.enum(["ahachat"])
export type ContactSyncProvider = z.infer<typeof contactSyncProviders>

/** Who asked for a run: the builder UI or a public API call. */
export const contactSyncTriggerSources = z.enum(["app", "api"])
export type ContactSyncTriggerSource = z.infer<typeof contactSyncTriggerSources>

/**
 * `pending` (queued, or released for the sweeper) → `running` → a terminal
 * state. `cancelling` is live on purpose: the chunk in flight still settles
 * its page, so a new run must not start until the worker confirms `cancelled`.
 * `partial` = finished, but at least one source failed or hit its page cap.
 */
export const contactSyncRunStatuses = z.enum([
  "pending",
  "running",
  "cancelling",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
])
export type ContactSyncRunStatus = z.infer<typeof contactSyncRunStatuses>

/** Statuses during which a run still owns the one-live-run slot of its workspace. */
export const CONTACT_SYNC_LIVE_STATUSES: readonly ContactSyncRunStatus[] = [
  "pending",
  "running",
  "cancelling",
]

/** One source of a run; processed one at a time in `position` order. */
export const contactSyncRunItemStatuses = z.enum([
  "pending",
  "running",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
])
export type ContactSyncRunItemStatus = z.infer<
  typeof contactSyncRunItemStatuses
>

/** What a source-side id maps to in the workspace. */
export const contactSyncMappingKinds = z.enum(["tag", "customField"])
export type ContactSyncMappingKind = z.infer<typeof contactSyncMappingKinds>

/** `manual` = chosen by the user; `auto` = resolved by a run and reused by later runs. */
export const contactSyncMappingOrigins = z.enum(["manual", "auto"])
export type ContactSyncMappingOrigin = z.infer<typeof contactSyncMappingOrigins>

/**
 * Error codes of contact sync (`ChatbotXException.code`). One table so the
 * service, the public API error map and the builder messages cannot drift.
 */
export const CONTACT_SYNC_ERROR_CODES = {
  alreadyRunning: "contactSyncAlreadyRunning",
  cooldown: "contactSyncCooldown",
  noSources: "contactSyncNoSources",
  tooManySources: "contactSyncTooManySources",
  duplicateSource: "contactSyncDuplicateSource",
  sourceNotFound: "contactSyncSourceNotFound",
  sourceNotEligible: "contactSyncSourceNotEligible",
  inboxRequired: "contactSyncInboxRequired",
  inboxNotMatched: "contactSyncInboxNotMatched",
  mappingInvalid: "contactSyncMappingInvalid",
  runNotFound: "contactSyncRunNotFound",
} as const

/** Why one row of a save-mappings call was refused. */
export const contactSyncMappingIssueReasons = z.enum([
  "unknownExternalId",
  "duplicateExternalId",
  "targetNotFound",
  "targetAmbiguous",
  "typeMismatch",
])
export type ContactSyncMappingIssueReason = z.infer<
  typeof contactSyncMappingIssueReasons
>

/** `data` of `contactSyncMappingInvalid`: every refused row and why. */
export const contactSyncMappingInvalidDataSchema = z
  .record(z.string(), contactSyncMappingIssueReasons)
  .describe(
    'Each refused row as `"<kind>:<externalId>"` → reason, e.g. `{"tag:12": "targetNotFound"}`.',
  )

/** `data` of `contactSyncAlreadyRunning`: the run to follow instead. */
export const contactSyncAlreadyRunningDataSchema = z.object({
  runId: z.string().describe("The live run of the workspace."),
})

/** `data` of `contactSyncCooldown`: when a new sync may start. */
export const contactSyncCooldownDataSchema = z.object({
  nextSyncAt: z.string().describe("ISO 8601 time a new sync may start."),
})
