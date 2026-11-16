import {
  CONTACT_SYNC_CHUNK_BUDGET_MS,
  CONTACT_SYNC_DEFAULT_PAUSE_MS,
  CONTACT_SYNC_MAX_PAGES_PER_ITEM,
  CONTACT_SYNC_MAX_PAUSE_MS,
  CONTACT_SYNC_PAGE_SIZE,
  CONTACT_SYNC_PAGES_PER_CHUNK,
  CONTACT_SYNC_RUN_ERRORS,
  type ContactSyncAdapter,
  type ContactSyncErrorKind,
  type ContactSyncSchema,
  type ContactSyncWorkerContext,
  contactSyncService,
} from "@chatbotx.io/business"
import {
  importContactSyncPage,
  loadContactSyncMappingState,
} from "@chatbotx.io/business/contact-sync/import"
import type { ChannelType } from "@chatbotx.io/database/partials"
import type { ContactSyncRunGuard } from "@chatbotx.io/database/repositories"
import type {
  ContactSyncRunItemModel,
  ContactSyncRunModel,
} from "@chatbotx.io/database/types"
import { getChildLogger } from "@chatbotx.io/logger"
import type { AuthValue } from "@chatbotx.io/sdk"

const log = getChildLogger("contact-sync")

/** A touch after `pausedUntil`, so DB-clock skew never finds the pause unfinished. */
const PAUSE_RESUME_SLACK_MS = 1000

type ChunkContext = {
  run: ContactSyncRunModel
  expect: ContactSyncRunGuard
  startedAt: number
  pagesRead: number
  adapter: ContactSyncAdapter
}

/** No tag or field is synced: the source's schema is never fetched. */
const EMPTY_SCHEMA: ContactSyncSchema = { tags: [], fields: [] }

/** How one source ended this chunk. */
type ItemOutcome =
  | { kind: "itemDone" }
  | { kind: "yield" }
  | { kind: "pause"; pauseMs: number }
  /** The claim was lost or the run is being cancelled: stop touching it. */
  | { kind: "stop"; cancelling: boolean }

const isOverBudget = (ctx: ChunkContext) =>
  ctx.pagesRead >= CONTACT_SYNC_PAGES_PER_CHUNK ||
  Date.now() - ctx.startedAt >= CONTACT_SYNC_CHUNK_BUDGET_MS

const settledCount = (item: ContactSyncRunItemModel) =>
  item.createdCount + item.updatedCount + item.skippedCount + item.failedCount

const endItem = async (
  ctx: ChunkContext,
  item: ContactSyncRunItemModel,
  status: "succeeded" | "partial" | "failed",
  currentError: string | null = null,
): Promise<ItemOutcome> => {
  const written = await contactSyncService.finishItem({
    runId: ctx.run.id,
    itemId: item.id,
    expect: ctx.expect,
    status,
    currentError,
  })
  return written ? { kind: "itemDone" } : { kind: "stop", cancelling: false }
}

/** The source's own wait; none or zero would retry at once into the same limit. */
const rateLimitPauseMs = (retryAfterMs: number | null): number => {
  if (retryAfterMs && retryAfterMs > 0) {
    return retryAfterMs
  }
  return CONTACT_SYNC_DEFAULT_PAUSE_MS
}

type ErrorOutcomeHandler<Kind extends ContactSyncErrorKind["kind"]> = (input: {
  ctx: ChunkContext
  item: ContactSyncRunItemModel
  error: Extract<ContactSyncErrorKind, { kind: Kind }>
  cause: unknown
}) => Promise<ItemOutcome>

/** What the engine does with each kind of failed source call; each handler gets its own kind. */
const ERROR_OUTCOMES: {
  [Kind in ContactSyncErrorKind["kind"]]: ErrorOutcomeHandler<Kind>
} = {
  rateLimited: async ({ error }) => ({
    kind: "pause",
    pauseMs: rateLimitPauseMs(error.retryAfterMs),
  }),
  // Lets the job fail: the lease goes stale and the sweeper retries the run,
  // burning one of its attempts (`CONTACT_SYNC_MAX_ATTEMPTS`).
  retryable: ({ cause }) => Promise.reject(cause),
  tokenInvalid: async ({ ctx, item }) => {
    if (item.integrationId) {
      await contactSyncService.markSourceNeedsReauth({
        workspaceId: ctx.run.workspaceId,
        integrationId: item.integrationId,
      })
    }
    return await endItem(
      ctx,
      item,
      "failed",
      CONTACT_SYNC_RUN_ERRORS.tokenInvalid,
    )
  },
  fatal: ({ ctx, item }) =>
    endItem(ctx, item, "failed", CONTACT_SYNC_RUN_ERRORS.sourceUnavailable),
}

const onSourceError = (
  ctx: ChunkContext,
  item: ContactSyncRunItemModel,
  cause: unknown,
): Promise<ItemOutcome> => {
  const error = ctx.adapter.classifyError(cause)
  log.warn(
    { runId: ctx.run.id, itemId: item.id, kind: error.kind },
    "contact sync: source call failed",
  )
  // `error.kind` picks the handler of that same kind; TypeScript cannot
  // correlate the two through the union on its own.
  const handler = ERROR_OUTCOMES[error.kind] as ErrorOutcomeHandler<
    typeof error.kind
  >
  return handler({ ctx, item, error, cause })
}

/** Fixes the snapshot bound once, when the item starts. */
const startItem = async (
  ctx: ChunkContext,
  item: ContactSyncRunItemModel,
  auth: AuthValue,
): Promise<ContactSyncRunItemModel | null> => {
  if (item.status === "running" && item.startedAt) {
    return item
  }
  const upperBoundId = await ctx.adapter.readSnapshotBound(auth)
  return await contactSyncService.startItem({
    runId: ctx.run.id,
    itemId: item.id,
    expect: ctx.expect,
    upperBoundId,
  })
}

/** Reads and imports pages of one source until it ends or the chunk budget does. */
const importPages = async (input: {
  ctx: ChunkContext
  item: ContactSyncRunItemModel
  integrationId: string
  auth: AuthValue
  context: ContactSyncWorkerContext
  inbox: { id: string; channel: ChannelType }
}): Promise<ItemOutcome> => {
  const { ctx, integrationId, auth, context, inbox } = input
  let item = input.item
  if (!item.upperBoundId) {
    // The source had no contact when the item started: nothing to import.
    return await endItem(ctx, item, "succeeded")
  }
  const syncsSchema = ctx.run.syncTags || ctx.run.syncCustomFields
  const schema = syncsSchema ? await ctx.adapter.listSchema(auth) : EMPTY_SCHEMA
  let state = await loadContactSyncMappingState(
    { workspaceId: ctx.run.workspaceId, integrationId },
    schema,
  )
  let cursor = item.cursor
  while (!isOverBudget(ctx)) {
    const leased = await contactSyncService.renewLease({
      runId: ctx.run.id,
      expect: ctx.expect,
    })
    if (leased !== "running") {
      return { kind: "stop", cancelling: leased === "cancelling" }
    }
    if (
      settledCount(item) >=
      CONTACT_SYNC_MAX_PAGES_PER_ITEM * CONTACT_SYNC_PAGE_SIZE
    ) {
      return await endItem(
        ctx,
        item,
        "partial",
        CONTACT_SYNC_RUN_ERRORS.pageLimitReached,
      )
    }
    const page = await ctx.adapter.listRecords(auth, {
      cursor,
      upperBoundId: item.upperBoundId,
      limit: CONTACT_SYNC_PAGE_SIZE,
    })
    const imported = await importContactSyncPage({
      context,
      integrationId,
      inbox,
      records: page.records,
      schema,
      state,
      options: ctx.run,
    })
    state = imported.state
    const counters = {
      ...imported.counters,
      failed: imported.counters.failed + page.invalidCount,
    }
    cursor = page.nextCursor ?? cursor
    ctx.pagesRead += 1
    const recorded = await contactSyncService.recordItemProgress({
      runId: ctx.run.id,
      itemId: item.id,
      expect: ctx.expect,
      cursor,
      counters,
    })
    if (recorded !== "running") {
      return { kind: "stop", cancelling: recorded === "cancelling" }
    }
    item = {
      ...item,
      cursor,
      createdCount: item.createdCount + counters.created,
      updatedCount: item.updatedCount + counters.updated,
      skippedCount: item.skippedCount + counters.skipped,
      failedCount: item.failedCount + counters.failed,
      skippedValueCount: item.skippedValueCount + counters.skippedValues,
    }
    if (!page.hasMore) {
      // Rows that broke the source's contract are counted failed: the
      // source finished, but not completely.
      const status = item.failedCount > 0 ? "partial" : "succeeded"
      return await endItem(ctx, item, status)
    }
    if (!page.nextCursor) {
      // A source that says "more" without a cursor would loop forever.
      return await endItem(
        ctx,
        item,
        "partial",
        CONTACT_SYNC_RUN_ERRORS.sourceUnavailable,
      )
    }
  }
  return { kind: "yield" }
}

const processItem = async (
  ctx: ChunkContext,
  item: ContactSyncRunItemModel,
  context: ContactSyncWorkerContext,
): Promise<ItemOutcome> => {
  if (!item.integrationId) {
    return await endItem(
      ctx,
      item,
      "failed",
      CONTACT_SYNC_RUN_ERRORS.sourceDisconnected,
    )
  }
  const inbox = await contactSyncService.findItemInbox(item)
  if (!inbox) {
    return await endItem(
      ctx,
      item,
      "failed",
      CONTACT_SYNC_RUN_ERRORS.inboxUnavailable,
    )
  }
  try {
    const auth = await contactSyncService.loadSourceAuth({
      workspaceId: ctx.run.workspaceId,
      provider: ctx.run.provider,
      integrationId: item.integrationId,
    })
    const started = await startItem(ctx, item, auth)
    if (!started) {
      return { kind: "stop", cancelling: false }
    }
    return await importPages({
      ctx,
      item: started,
      integrationId: item.integrationId,
      auth,
      context,
      inbox,
    })
  } catch (cause) {
    return await onSourceError(ctx, item, cause)
  }
}

const yieldAndContinue = async (
  ctx: ChunkContext,
  pauseMs?: number,
): Promise<void> => {
  const delayMs =
    pauseMs === undefined
      ? undefined
      : Math.min(pauseMs, CONTACT_SYNC_MAX_PAUSE_MS)
  const chunkSeq = await contactSyncService.yieldForContinuation({
    runId: ctx.run.id,
    expect: ctx.expect,
    ...(delayMs !== undefined && {
      pausedUntil: new Date(Date.now() + delayMs),
    }),
  })
  if (chunkSeq === null) {
    log.warn({ runId: ctx.run.id }, "contact sync: yield lost the claim")
    return
  }
  try {
    await contactSyncService.enqueueChunk(
      { ...ctx.run, chunkSeq },
      delayMs === undefined ? {} : { delayMs: delayMs + PAUSE_RESUME_SLACK_MS },
    )
  } catch (err) {
    log.error(
      { err, runId: ctx.run.id },
      "contact sync: continuation enqueue failed, reopening for the sweeper",
    )
    await contactSyncService.reopenReleased(ctx.run.id)
  }
}

const finishRun = async (ctx: ChunkContext, cancelling = false) => {
  await contactSyncService.finish({
    run: cancelling ? { ...ctx.run, status: "cancelling" } : ctx.run,
    expect: ctx.expect,
  })
}

/** Processes items in order until the run ends or the chunk must yield. */
const drive = async (ctx: ChunkContext): Promise<void> => {
  if (ctx.run.status === "cancelling") {
    return await finishRun(ctx, true)
  }
  const context = await contactSyncService.loadWorkerContext(
    ctx.run.workspaceId,
  )
  if (!context) {
    return await finishRun(ctx, true)
  }
  for (;;) {
    const item = await contactSyncService.findNextItem(ctx.run.id)
    if (!item) {
      return await finishRun(ctx)
    }
    const outcome = await processItem(ctx, item, context)
    if (outcome.kind === "stop") {
      return outcome.cancelling ? await finishRun(ctx, true) : undefined
    }
    if (outcome.kind === "pause") {
      return await yieldAndContinue(ctx, outcome.pauseMs)
    }
    if (outcome.kind === "yield" || isOverBudget(ctx)) {
      return await yieldAndContinue(ctx)
    }
  }
}

/**
 * Runs one budgeted chunk of a contact sync run. The run row is the only
 * input: the claim proves ownership, every write is guarded by it, and a
 * chunk that runs out of budget releases the lease and queues the next. Job
 * payloads carry no instructions, so a stale or forged job can only continue
 * a run that is genuinely live. At most one chunk per run runs at a time, and
 * at most one live run exists per workspace.
 */
export async function runContactSync(data: {
  runId: string
  workspaceId: string
}): Promise<void> {
  const run = await contactSyncService.claim(data)
  if (!run?.claimToken) {
    return
  }
  const ctx: ChunkContext = {
    run,
    expect: { claimToken: run.claimToken },
    startedAt: Date.now(),
    pagesRead: 0,
    adapter: contactSyncService.adapterFor(run.provider),
  }
  try {
    await drive(ctx)
  } catch (err) {
    log.error({ err, runId: run.id }, "contact sync: chunk crashed")
    // Leave the lease to expire: the sweeper re-dispatches after the stale
    // window; every page write converges, so a replay is harmless.
    throw err
  }
}
