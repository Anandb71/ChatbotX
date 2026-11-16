import { contactSyncService } from "@chatbotx.io/business"
import { requireUnrestrictedContactsScope } from "@/features/contact-scan/lib/require-unrestricted-contacts-scope"
import { assertCurrentUserCanAccessChatbot } from "@/lib/auth/utils"
import { contactSyncRunResource } from "../schema/public"

/** The runs as the public API shows them: no lease, cursor or retry state. */
const historyRuns = contactSyncRunResource.array()

/**
 * Thin request adapter for the sync history page, like the scan history's
 * (`features/contact-scan/queries/list-contact-scan-history.queries.ts`): the
 * same service method as the public `contactSyncs.list`, behind the same
 * unrestricted-contacts scope as the sync dialog. A page or size below 1 from
 * the URL falls back to 1; the repository caps the size.
 */
export async function listContactSyncHistory(input: {
  workspaceId: string
  page: number
  perPage: number
}) {
  await assertCurrentUserCanAccessChatbot(input.workspaceId)
  await requireUnrestrictedContactsScope(input.workspaceId)
  const result = await contactSyncService.listHistory({
    workspaceId: input.workspaceId,
    page: Math.max(1, input.page),
    perPage: Math.max(1, input.perPage),
  })
  return { ...result, data: historyRuns.parse(result.data) }
}

export type ContactSyncHistoryPage = Awaited<
  ReturnType<typeof listContactSyncHistory>
>
