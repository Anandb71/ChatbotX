import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import {
  type ContactSyncMappingKind,
  type ContactSyncMappingOrigin,
  type ContactSyncProvider,
  type ContactSyncRunItemStatus,
  type ContactSyncRunStatus,
  type ContactSyncTriggerSource,
  contactSyncMappingKinds,
  contactSyncMappingOrigins,
  contactSyncProviders,
  contactSyncRunItemStatuses,
  contactSyncRunStatuses,
  contactSyncTriggerSources,
} from "../partials/contact-sync"
import {
  bigintAsString,
  sharedColumns,
  timestampConfig,
} from "../partials/shared"
import { userModel } from "./auth-user"
import { customFieldModel } from "./custom-field"
import { inboxModel } from "./inbox"
import { integrationModel } from "./integration-base"
import { tagModel } from "./tag"
import { workspaceModel } from "./workspace"

export const contactSyncProviderEnum = pgEnum(
  "contactSyncProvider",
  contactSyncProviders.options as [
    ContactSyncProvider,
    ...ContactSyncProvider[],
  ],
)

export const contactSyncTriggerSourceEnum = pgEnum(
  "contactSyncTriggerSource",
  contactSyncTriggerSources.options as [
    ContactSyncTriggerSource,
    ...ContactSyncTriggerSource[],
  ],
)

export const contactSyncRunStatusEnum = pgEnum(
  "contactSyncRunStatus",
  contactSyncRunStatuses.options as [
    ContactSyncRunStatus,
    ...ContactSyncRunStatus[],
  ],
)

export const contactSyncRunItemStatusEnum = pgEnum(
  "contactSyncRunItemStatus",
  contactSyncRunItemStatuses.options as [
    ContactSyncRunItemStatus,
    ...ContactSyncRunItemStatus[],
  ],
)

export const contactSyncMappingKindEnum = pgEnum(
  "contactSyncMappingKind",
  contactSyncMappingKinds.options as [
    ContactSyncMappingKind,
    ...ContactSyncMappingKind[],
  ],
)

export const contactSyncMappingOriginEnum = pgEnum(
  "contactSyncMappingOrigin",
  contactSyncMappingOrigins.options as [
    ContactSyncMappingOrigin,
    ...ContactSyncMappingOrigin[],
  ],
)

/**
 * One import of contacts from an external system into a workspace. Executed
 * as short chunk jobs; this row is the lease, the options and the history.
 * At most one live run per workspace, whatever the provider. No `.default()`
 * on purpose: every insert writes every column.
 */
export const contactSyncRunModel = pgTable(
  "ContactSyncRun",
  {
    ...sharedColumns,
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    provider: contactSyncProviderEnum().notNull(),
    status: contactSyncRunStatusEnum().notNull(),
    triggerSource: contactSyncTriggerSourceEnum().notNull(),
    // `set null` so deleting the user keeps the history.
    requestedByUserId: bigintAsString().references(() => userModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    syncTags: boolean().notNull(),
    syncCustomFields: boolean().notNull(),
    // false = only fill what the contact is missing; true = source values win.
    // An empty source value never clears workspace data in either mode.
    overwriteExisting: boolean().notNull(),
    startedAt: timestamp(timestampConfig),
    finishedAt: timestamp(timestampConfig),
    lastHeartbeatAt: timestamp(timestampConfig),
    // The source asked to wait (rate limit): nothing may claim or re-dispatch
    // the run before this. A cancel bypasses it. NULL = not paused.
    pausedUntil: timestamp(timestampConfig),
    // Exclusive lease token, re-minted by every claim; every write a claim
    // holder makes is conditional on it. NULL = released / never claimed.
    claimToken: text(),
    // Sweeper dispatches burned (a continuation chunk is not an attempt).
    attempts: integer().notNull(),
    // Monotonic continuation revision; makes each chunk job id unique.
    chunkSeq: integer().notNull(),
    currentError: text(),
  },
  (t) => [
    // One live run per workspace, across providers.
    uniqueIndex("ContactSyncRun_workspace_live_uq")
      .on(t.workspaceId)
      .where(sql`status IN ('pending', 'running', 'cancelling')`),
    // Cooldown and history lookups; also the leading index of the workspace FK.
    index("ContactSyncRun_workspace_createdAt_idx").on(
      t.workspaceId,
      sql`${t.createdAt} DESC`,
    ),
    index("ContactSyncRun_live_idx")
      .on(t.status, t.lastHeartbeatAt)
      .where(sql`status IN ('pending', 'running', 'cancelling')`),
    index("ContactSyncRun_requestedByUserId_idx")
      .on(t.requestedByUserId)
      .where(sql`${t.requestedByUserId} IS NOT NULL`),
  ],
)

/**
 * One source (e.g. one external page) of a run, imported into one inbox.
 * Items of a run are processed one at a time in `position` order; `cursor`
 * is the source's opaque resume point and `upperBoundId` the snapshot bound
 * fixed when the item starts, so each item is a finite set.
 */
export const contactSyncRunItemModel = pgTable(
  "ContactSyncRunItem",
  {
    ...sharedColumns,
    runId: bigintAsString()
      .notNull()
      .references(() => contactSyncRunModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    // `set null` so disconnecting the source or deleting the inbox keeps the history.
    integrationId: bigintAsString().references(() => integrationModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    inboxId: bigintAsString().references(() => inboxModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    // Display snapshot of the source, kept after a disconnect.
    sourceAccountName: text(),
    position: integer().notNull(),
    status: contactSyncRunItemStatusEnum().notNull(),
    cursor: text(),
    upperBoundId: text(),
    createdCount: integer().notNull(),
    updatedCount: integer().notNull(),
    skippedCount: integer().notNull(),
    failedCount: integer().notNull(),
    // Custom-field values dropped: incompatible mapping or an invalid value.
    skippedValueCount: integer().notNull(),
    currentError: text(),
    startedAt: timestamp(timestampConfig),
    finishedAt: timestamp(timestampConfig),
  },
  (t) => [
    uniqueIndex("ContactSyncRunItem_runId_position_key").on(
      t.runId,
      t.position,
    ),
    index("ContactSyncRunItem_workspaceId_idx").on(t.workspaceId),
    index("ContactSyncRunItem_integrationId_idx")
      .on(t.integrationId)
      .where(sql`${t.integrationId} IS NOT NULL`),
    index("ContactSyncRunItem_inboxId_idx")
      .on(t.inboxId)
      .where(sql`${t.inboxId} IS NOT NULL`),
  ],
)

/**
 * A source-side tag or custom field and what it maps to in the workspace.
 * `manual` rows come from the user; `auto` rows are written by a run (never
 * over a manual row) so later runs reuse the same target. Deleting the target
 * removes the mapping, so the next run resolves it again.
 */
export const contactSyncMappingModel = pgTable(
  "ContactSyncMapping",
  {
    ...sharedColumns,
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    integrationId: bigintAsString()
      .notNull()
      .references(() => integrationModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    kind: contactSyncMappingKindEnum().notNull(),
    externalId: text().notNull(),
    externalName: text().notNull(),
    tagId: bigintAsString().references(() => tagModel.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
    customFieldId: bigintAsString().references(() => customFieldModel.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
    origin: contactSyncMappingOriginEnum().notNull(),
  },
  (t) => [
    uniqueIndex("ContactSyncMapping_integration_kind_externalId_key").on(
      t.integrationId,
      t.kind,
      t.externalId,
    ),
    index("ContactSyncMapping_workspaceId_idx").on(t.workspaceId),
    index("ContactSyncMapping_tagId_idx")
      .on(t.tagId)
      .where(sql`${t.tagId} IS NOT NULL`),
    index("ContactSyncMapping_customFieldId_idx")
      .on(t.customFieldId)
      .where(sql`${t.customFieldId} IS NOT NULL`),
    check(
      "ContactSyncMapping_target_check",
      sql`(${t.kind} = 'tag' AND ${t.tagId} IS NOT NULL AND ${t.customFieldId} IS NULL) OR (${t.kind} = 'customField' AND ${t.customFieldId} IS NOT NULL AND ${t.tagId} IS NULL)`,
    ),
    check(
      "ContactSyncMapping_external_check",
      sql`btrim(${t.externalId}) <> '' AND btrim(${t.externalName}) <> ''`,
    ),
  ],
)
