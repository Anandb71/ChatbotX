/** One sync per workspace per this window, measured from the latest run that reached its source. */
export const CONTACT_SYNC_COOLDOWN_MS = 4 * 60 * 60 * 1000

/**
 * Sweeper re-dispatches of a run that stopped without progress (timeout,
 * network error, 5xx, crash): the first chunk plus this many retries, so an
 * outage ends the run `failed` (`maxAttempts`) after 3 failed tries in a row.
 * A re-dispatch of a lost enqueue counts too; a chunk still waiting in the
 * queue does not. Recorded progress and a rate-limit pause reset the count.
 */
export const CONTACT_SYNC_MAX_ATTEMPTS = 2

/**
 * Wall-clock budget of one chunk job, far below the integration queue's lock
 * duration: a source call started near the end still finishes inside it.
 */
export const CONTACT_SYNC_CHUNK_BUDGET_MS = 60_000

/** Source pages read by one chunk before it yields to other jobs. */
export const CONTACT_SYNC_PAGES_PER_CHUNK = 5

/** Contacts asked per source page. */
export const CONTACT_SYNC_PAGE_SIZE = 200

/** Longest wait honoured when a source asks to slow down. */
export const CONTACT_SYNC_MAX_PAUSE_MS = 30 * 60 * 1000

/** Wait before a retry when the source gave no hint. */
export const CONTACT_SYNC_DEFAULT_PAUSE_MS = 60 * 1000

/** Exhausted runs one sweep ends; a backlog drains over the next sweeps. */
export const CONTACT_SYNC_SWEEP_BATCH_SIZE = 100

/** Sources one run may import. */
export const CONTACT_SYNC_MAX_SOURCES_PER_RUN = 50

/**
 * Contacts one source may settle in a run, expressed in full pages (this ×
 * `CONTACT_SYNC_PAGE_SIZE`); past it the source ends `partial`. Reading is
 * finite anyway: every page with "more" has rows and a cursor that moves
 * forward within the snapshot.
 */
export const CONTACT_SYNC_MAX_PAGES_PER_ITEM = 25_000

export { CONTACT_SYNC_ERROR_CODES } from "@chatbotx.io/database/partials"

/** Why a source cannot be synced, shown next to it (localized by the builder). */
export const CONTACT_SYNC_INELIGIBLE_REASONS = {
  channelUnsupported: "channelUnsupported",
  noMatchingInbox: "noMatchingInbox",
  connectionUnhealthy: "connectionUnhealthy",
} as const
export type ContactSyncIneligibleReason =
  (typeof CONTACT_SYNC_INELIGIBLE_REASONS)[keyof typeof CONTACT_SYNC_INELIGIBLE_REASONS]

/** `currentError` sentinels a run or one of its sources can end with. */
export const CONTACT_SYNC_RUN_ERRORS = {
  tokenInvalid: "tokenInvalid",
  inboxUnavailable: "inboxUnavailable",
  sourceUnavailable: "sourceUnavailable",
  sourceDisconnected: "sourceDisconnected",
  pageLimitReached: "pageLimitReached",
  maxAttempts: "maxAttempts",
} as const
