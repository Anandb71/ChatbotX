import { and, db, eq, inArray } from "@chatbotx.io/database/client"
import { type ChannelType, inboxStatuses } from "@chatbotx.io/database/partials"
import {
  inboxModel,
  integrationWhatsappModel,
} from "@chatbotx.io/database/schema"

export type MatchedInbox = { id: string; name: string; channel: ChannelType }

/** What one channel's matcher needs: the source account ids to look up. */
type InboxMatcher = (input: {
  workspaceId: string
  channel: ChannelType
  accountIds: string[]
}) => Promise<Map<string, MatchedInbox[]>>

const groupBy = (rows: { key: string; inbox: MatchedInbox }[]) => {
  const grouped = new Map<string, MatchedInbox[]>()
  for (const row of rows) {
    grouped.set(row.key, [...(grouped.get(row.key) ?? []), row.inbox])
  }
  return grouped
}

/** The inbox whose channel id is the source account id (page, IG account, OA, bot). */
const byInboxSourceId: InboxMatcher = async (input) => {
  const rows = await db
    .select({
      id: inboxModel.id,
      name: inboxModel.name,
      sourceId: inboxModel.sourceId,
    })
    .from(inboxModel)
    .where(
      and(
        eq(inboxModel.workspaceId, input.workspaceId),
        eq(inboxModel.channel, input.channel),
        eq(inboxModel.status, inboxStatuses.enum.connected),
        inArray(inboxModel.sourceId, input.accountIds),
      ),
    )
  return groupBy(
    rows.map((row) => ({
      key: row.sourceId,
      inbox: { id: row.id, name: row.name, channel: input.channel },
    })),
  )
}

/** A WhatsApp source is a business account: every connected number of it matches. */
const byWhatsappBusinessAccount: InboxMatcher = async (input) => {
  const rows = await db
    .select({
      id: inboxModel.id,
      name: inboxModel.name,
      wabaId: integrationWhatsappModel.wabaId,
    })
    .from(integrationWhatsappModel)
    .innerJoin(inboxModel, eq(inboxModel.id, integrationWhatsappModel.inboxId))
    .where(
      and(
        eq(integrationWhatsappModel.workspaceId, input.workspaceId),
        inArray(integrationWhatsappModel.wabaId, input.accountIds),
        eq(inboxModel.workspaceId, input.workspaceId),
        eq(inboxModel.status, inboxStatuses.enum.connected),
      ),
    )
  return groupBy(
    rows.map((row) => ({
      key: row.wabaId,
      inbox: { id: row.id, name: row.name, channel: input.channel },
    })),
  )
}

const INBOX_MATCHERS: Partial<Record<ChannelType, InboxMatcher>> = {
  whatsapp: byWhatsappBusinessAccount,
}

/**
 * Connected inboxes of the workspace each source account can import into,
 * keyed by `<channel>:<accountId>`. One query per channel involved, never one
 * per source.
 */
export const matchInboxesForAccounts = async (input: {
  workspaceId: string
  accounts: { channel: ChannelType; accountId: string }[]
}): Promise<Map<string, MatchedInbox[]>> => {
  const accountIdsByChannel = new Map<ChannelType, string[]>()
  for (const account of input.accounts) {
    accountIdsByChannel.set(account.channel, [
      ...(accountIdsByChannel.get(account.channel) ?? []),
      account.accountId,
    ])
  }
  const matched = new Map<string, MatchedInbox[]>()
  for (const [channel, accountIds] of accountIdsByChannel) {
    const matcher = INBOX_MATCHERS[channel] ?? byInboxSourceId
    const byAccount = await matcher({
      workspaceId: input.workspaceId,
      channel,
      accountIds: [...new Set(accountIds)],
    })
    for (const [accountId, inboxes] of byAccount) {
      matched.set(inboxMatchKey(channel, accountId), inboxes)
    }
  }
  return matched
}

export const inboxMatchKey = (channel: ChannelType, accountId: string) =>
  `${channel}:${accountId}`
