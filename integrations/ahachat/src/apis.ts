import { z } from "zod"
import { ahachatRequest } from "./client"
import {
  AHACHAT_DEFAULT_CONTACTS_PAGE_SIZE,
  AHACHAT_MAX_CONTACTS_PAGE_SIZE,
  AHACHAT_MAX_LIST_ITEMS,
} from "./constants"
import { AhachatApiError } from "./error"
import {
  type AhachatAuthValue,
  type AhachatContact,
  type AhachatContactsPage,
  type AhachatCustomField,
  type AhachatPage,
  type AhachatTag,
  ahachatContactSchema,
  ahachatContactsPageSchema,
  ahachatCustomFieldSchema,
  ahachatPageSchema,
  ahachatTagSchema,
} from "./schemas"

type TokenHolder = Pick<AhachatAuthValue, "token">

/** The page of a token; also how a token is validated on connect. */
export const getAhachatPage = (token: string): Promise<AhachatPage> =>
  ahachatRequest(token, "page", ahachatPageSchema)

export const listAhachatTags = (auth: TokenHolder): Promise<AhachatTag[]> =>
  ahachatRequest(
    auth.token,
    "tags",
    z.array(ahachatTagSchema).max(AHACHAT_MAX_LIST_ITEMS),
  )

export const listAhachatCustomFields = (
  auth: TokenHolder,
): Promise<AhachatCustomField[]> =>
  ahachatRequest(
    auth.token,
    "custom-fields",
    z.array(ahachatCustomFieldSchema).max(AHACHAT_MAX_LIST_ITEMS),
  )

/**
 * Whether a page keeps the paging contract, so reading stays finite: "more"
 * comes with rows and a next cursor, which moves forward without passing the
 * snapshot bound. Each broken rule could otherwise loop or read past it.
 */
const isPageWithinContract = (
  page: z.infer<typeof ahachatContactsPageSchema>,
  input: { afterId: string | null; untilId: string | null },
  nextCursor: string | null,
): boolean => {
  if (page.has_more && (page.items.length === 0 || nextCursor === null)) {
    return false
  }
  if (nextCursor === null) {
    return true
  }
  if (input.afterId !== null && BigInt(nextCursor) <= BigInt(input.afterId)) {
    return false
  }
  return input.untilId === null || BigInt(nextCursor) <= BigInt(input.untilId)
}

/**
 * One page of contacts with `afterId < id <= untilId`, in id order. A row
 * that does not match the contract is counted in `invalidCount` instead of
 * failing the whole page.
 */
export const listAhachatContacts = async (
  auth: TokenHolder,
  input: { afterId: string | null; untilId: string | null; limit?: number },
): Promise<AhachatContactsPage> => {
  const limit = Math.min(
    input.limit ?? AHACHAT_DEFAULT_CONTACTS_PAGE_SIZE,
    AHACHAT_MAX_CONTACTS_PAGE_SIZE,
  )
  const page = await ahachatRequest(
    auth.token,
    "users",
    ahachatContactsPageSchema,
    {
      after_id: input.afterId ?? undefined,
      until_id: input.untilId ?? undefined,
      limit,
    },
  )
  const nextCursor = page.next_cursor ?? null
  if (!isPageWithinContract(page, input, nextCursor)) {
    throw new AhachatApiError({ code: "invalidResponse", statusCode: 502 })
  }
  const contacts: AhachatContact[] = []
  let invalidCount = 0
  for (const item of page.items) {
    const parsed = ahachatContactSchema.safeParse(item)
    if (parsed.success) {
      contacts.push(parsed.data)
    } else {
      invalidCount += 1
    }
  }
  return {
    contacts,
    invalidCount,
    nextCursor,
    hasMore: page.has_more,
  }
}
