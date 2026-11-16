import { and, db, eq, inArray } from "@chatbotx.io/database/client"
import type {
  AhachatChannel,
  ChannelType,
} from "@chatbotx.io/database/partials"
import { integrationAhachatModel } from "@chatbotx.io/database/schema"
import {
  type AhachatContact,
  type AhachatErrorCode,
  ahachatAuthSchema,
  getAhachatPage,
  isAhachatApiError,
  listAhachatContacts,
  listAhachatCustomFields,
  listAhachatTags,
} from "@chatbotx.io/integration-ahachat"
import type { AuthValue } from "@chatbotx.io/sdk"
import { ChatbotXException } from "../../errors"
import type {
  ContactSyncAdapter,
  ContactSyncErrorKind,
  ContactSyncRecord,
} from "../types"

/**
 * The workspace channel an AhaChat page's contacts belong to. `null` = no
 * counterpart, the page is shown as unsupported.
 */
export const AHACHAT_CHANNEL_MAP: Record<AhachatChannel, ChannelType | null> = {
  messenger: "messenger",
  instagram: "instagram",
  zalo: "zalo",
  telegram: "telegram",
  whatsapp: "whatsapp",
  google_business_message: null,
}

const ERROR_KINDS: Record<
  AhachatErrorCode,
  (retryAfterSeconds: number | undefined) => ContactSyncErrorKind
> = {
  unauthorized: () => ({ kind: "tokenInvalid" }),
  // The page of the token was deleted: only a new token can fix it.
  notFound: () => ({ kind: "tokenInvalid" }),
  rateLimited: (retryAfterSeconds) => ({
    kind: "rateLimited",
    retryAfterMs:
      retryAfterSeconds === undefined ? null : retryAfterSeconds * 1000,
  }),
  serverError: () => ({ kind: "retryable" }),
  network: () => ({ kind: "retryable" }),
  timeout: () => ({ kind: "retryable" }),
  notConfigured: () => ({ kind: "fatal" }),
  invalidRequest: () => ({ kind: "fatal" }),
  redirect: () => ({ kind: "fatal" }),
  invalidResponse: () => ({ kind: "fatal" }),
}

/** A stored token that cannot be decrypted needs a reconnect, like a revoked one. */
const UNREADABLE_CREDENTIALS_CODE = "ahachatCredentialsUnreadable"

const toRecord = (contact: AhachatContact): ContactSyncRecord => ({
  externalId: contact.id,
  channelUserId: contact.platformUserId,
  scopedUserId: contact.whatsappUserId,
  firstName: contact.firstName,
  lastName: contact.lastName,
  fullName: contact.fullName,
  gender: contact.gender,
  locale: contact.locale,
  timezoneOffsetHours: contact.timezoneOffsetHours,
  avatarUrl: contact.avatarUrl,
  phone: contact.phone,
  email: contact.email,
  ref: contact.ref,
  country: contact.country,
  state: contact.state,
  city: contact.city,
  location: contact.location,
  tags: contact.tags,
  fieldValues: contact.customFields,
})

const parseAuth = (auth: AuthValue) => ahachatAuthSchema.parse(auth)

export const ahachatContactSyncAdapter: ContactSyncAdapter = {
  provider: "ahachat",
  integrationType: "ahachat",
  listAccounts: async ({ workspaceId, integrationIds }) => {
    if (integrationIds.length === 0) {
      return new Map()
    }
    const rows = await db
      .select({
        integrationId: integrationAhachatModel.integrationId,
        sourceChannel: integrationAhachatModel.sourceChannel,
        sourceAccountId: integrationAhachatModel.sourceAccountId,
        sourceAccountName: integrationAhachatModel.sourceAccountName,
        sourceAvatarUrl: integrationAhachatModel.sourceAvatarUrl,
      })
      .from(integrationAhachatModel)
      .where(
        and(
          eq(integrationAhachatModel.workspaceId, workspaceId),
          inArray(integrationAhachatModel.integrationId, integrationIds),
        ),
      )
    return new Map(
      rows.map((row) => [
        row.integrationId,
        {
          accountId: row.sourceAccountId,
          channel: AHACHAT_CHANNEL_MAP[row.sourceChannel],
          name: row.sourceAccountName,
          avatarUrl: row.sourceAvatarUrl,
        },
      ]),
    )
  },
  listSchema: async (auth) => {
    const parsed = parseAuth(auth)
    const [tags, fields] = await Promise.all([
      listAhachatTags(parsed),
      listAhachatCustomFields(parsed),
    ])
    return { tags, fields }
  },
  readSnapshotBound: async (auth) =>
    (await getAhachatPage(parseAuth(auth).token)).latestUserId,
  listRecords: async (auth, input) => {
    const page = await listAhachatContacts(parseAuth(auth), {
      afterId: input.cursor,
      untilId: input.upperBoundId,
      limit: input.limit,
    })
    return {
      records: page.contacts.map(toRecord),
      invalidCount: page.invalidCount,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    }
  },
  classifyError: (error) => {
    if (isAhachatApiError(error)) {
      return ERROR_KINDS[error.code](error.retryAfterSeconds)
    }
    if (
      error instanceof ChatbotXException &&
      error.code === UNREADABLE_CREDENTIALS_CODE
    ) {
      return { kind: "tokenInvalid" }
    }
    return { kind: "retryable" }
  },
}
