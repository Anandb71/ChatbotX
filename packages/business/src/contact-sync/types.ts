import type {
  ChannelType,
  ContactSyncProvider,
  IntegrationType,
} from "@chatbotx.io/database/partials"
import type { AuthValue } from "@chatbotx.io/sdk"

/** The neutral field types an adapter declares for its source fields. */
export const externalFieldTypes = [
  "text",
  "number",
  "date",
  "datetime",
  "boolean",
  "json",
  "array",
] as const
export type ExternalFieldType = (typeof externalFieldTypes)[number]

/** The connected account a run reads from, as the adapter sees it. */
export type ContactSyncSourceAccount = {
  accountId: string
  /** `null` when the source's channel has no counterpart here. */
  channel: ChannelType | null
  name: string | null
  avatarUrl: string | null
}

export type ContactSyncExternalTag = { id: string; name: string }

export type ContactSyncExternalField = {
  id: string
  name: string
  type: ExternalFieldType
}

export type ContactSyncSchema = {
  tags: ContactSyncExternalTag[]
  fields: ContactSyncExternalField[]
}

/** One contact read from a source, in neutral terms. */
export type ContactSyncRecord = {
  externalId: string
  /** The channel's user id (PSID, IGSID, chat id, `wa_id`, …). */
  channelUserId: string | null
  /** A scoped user id the channel also keys on (WhatsApp BSUID). */
  scopedUserId: string | null
  firstName: string | null
  lastName: string | null
  fullName: string | null
  gender: string | null
  locale: string | null
  timezoneOffsetHours: number | null
  avatarUrl: string | null
  phone: string | null
  email: string | null
  ref: string | null
  country: string | null
  state: string | null
  city: string | null
  location: { latitude: number; longitude: number } | null
  tags: ContactSyncExternalTag[]
  fieldValues: { id: string; value: string | boolean }[]
}

export type ContactSyncRecordPage = {
  records: ContactSyncRecord[]
  /** Rows the source sent that broke its contract; counted failed. */
  invalidCount: number
  nextCursor: string | null
  hasMore: boolean
}

/** How the engine reacts to a failed source call. */
export type ContactSyncErrorKind =
  | { kind: "rateLimited"; retryAfterMs: number | null }
  | { kind: "retryable" }
  | { kind: "tokenInvalid" }
  | { kind: "fatal" }

/**
 * Everything provider-specific the engine and the service need. The run
 * tables and the engine know nothing else about a source.
 */
export type ContactSyncAdapter = {
  provider: ContactSyncProvider
  /** The `Connection.provider` whose connections are this provider's sources. */
  integrationType: IntegrationType
  /** Display data of connected sources, by integration id, read without decrypting. */
  listAccounts: (input: {
    workspaceId: string
    integrationIds: string[]
  }) => Promise<Map<string, ContactSyncSourceAccount>>
  listSchema: (auth: AuthValue) => Promise<ContactSyncSchema>
  /** The highest record id now: a run never reads past it. */
  readSnapshotBound: (auth: AuthValue) => Promise<string | null>
  listRecords: (
    auth: AuthValue,
    input: {
      cursor: string | null
      upperBoundId: string | null
      limit: number
    },
  ) => Promise<ContactSyncRecordPage>
  classifyError: (error: unknown) => ContactSyncErrorKind
}
