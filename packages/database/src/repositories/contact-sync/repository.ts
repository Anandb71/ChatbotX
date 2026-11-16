import {
  and,
  type DatabaseClient,
  db,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "../../client"
import {
  CONTACT_SYNC_LIVE_STATUSES,
  type ContactSyncProvider,
  type ContactSyncRunItemStatus,
  type ContactSyncRunStatus,
  type ContactSyncTriggerSource,
} from "../../partials"
import { contactSyncRunItemModel, contactSyncRunModel } from "../../schema"
import type { ContactSyncRunItemModel, ContactSyncRunModel } from "../../types"
import { getPaginationWithDefaults } from "../../utils"

/** A claim holder's proof of ownership; every guarded write carries it. */
export type ContactSyncRunGuard = { claimToken: string }

export type CreateContactSyncRunInput = {
  workspaceId: string
  provider: ContactSyncProvider
  triggerSource: ContactSyncTriggerSource
  requestedByUserId: string | null
  syncTags: boolean
  syncCustomFields: boolean
  overwriteExisting: boolean
  /** In processing order. */
  items: {
    integrationId: string
    inboxId: string
    sourceAccountName: string | null
  }[]
}

export type ContactSyncItemCounters = {
  created: number
  updated: number
  skipped: number
  failed: number
  /** Custom-field values dropped (incompatible mapping, invalid value). */
  skippedValues: number
}

export type FinishContactSyncRunInput = {
  status: Extract<
    ContactSyncRunStatus,
    "succeeded" | "partial" | "failed" | "cancelled"
  >
  currentError?: string | null
}

export type PickedContactSyncRun = Pick<
  ContactSyncRunModel,
  "id" | "workspaceId" | "attempts" | "chunkSeq" | "status"
>

export type ContactSyncRunWithItems = ContactSyncRunModel & {
  items: ContactSyncRunItemModel[]
}

// Read lazily (never at module scope): a suite that mocks
// `@chatbotx.io/database/client` narrowly must still be able to import this file.

/** A released continuation nobody re-claimed within this is a lost enqueue. */
const releasedStaleInterval = () => sql`INTERVAL '1 minute'`
/** Above the integration queue's lock duration, so a live chunk is never stolen. */
const leaseStaleInterval = () => sql`INTERVAL '15 minutes'`

const liveStatusList = () =>
  sql.join(
    CONTACT_SYNC_LIVE_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  )

/** The pause (if any) is over; a cancel never waits for it. */
const pauseElapsed = () =>
  sql`(${contactSyncRunModel.pausedUntil} IS NULL
    OR ${contactSyncRunModel.pausedUntil} <= NOW()
    OR ${contactSyncRunModel.status} = 'cancelling')`

/**
 * The cancel write. A run nobody holds ends `cancelled` on the spot; a claimed
 * one becomes `cancelling` for its worker to wind down. The enum casts matter:
 * a bare string literal in `CASE` is `text`, which Postgres will not assign to
 * the status enum.
 */
const cancelPatch = () => ({
  status: sql`CASE WHEN ${contactSyncRunModel.status} = 'pending'
      OR ${contactSyncRunModel.claimToken} IS NULL
    THEN 'cancelled'::"contactSyncRunStatus"
    ELSE 'cancelling'::"contactSyncRunStatus" END`,
  finishedAt: sql`CASE WHEN ${contactSyncRunModel.status} = 'pending'
      OR ${contactSyncRunModel.claimToken} IS NULL
    THEN NOW() ELSE ${contactSyncRunModel.finishedAt} END`,
  pausedUntil: null,
  updatedAt: new Date(),
})

const guardedRun = (runId: string, guard: ContactSyncRunGuard) =>
  and(
    eq(contactSyncRunModel.id, runId),
    inArray(contactSyncRunModel.status, ["running", "cancelling"]),
    eq(contactSyncRunModel.claimToken, guard.claimToken),
  )

/** Bumps the heartbeat of a run this claim still holds; `null` = claim lost. */
const touchGuardedRun = async (
  runId: string,
  guard: ContactSyncRunGuard,
  tx: DatabaseClient,
  patch: { resetAttempts?: boolean } = {},
): Promise<Extract<ContactSyncRunStatus, "running" | "cancelling"> | null> => {
  const [row] = await tx
    .update(contactSyncRunModel)
    .set({
      lastHeartbeatAt: new Date(),
      updatedAt: new Date(),
      ...(patch.resetAttempts && { attempts: 0 }),
    })
    .where(guardedRun(runId, guard))
    .returning({ status: contactSyncRunModel.status })
  return row ? (row.status as "running" | "cancelling") : null
}

export const contactSyncRunRepository = {
  /**
   * Inserts a `pending` run and its items, or returns `null` when the
   * workspace already has a live run (the partial unique index decides, so
   * two concurrent requests cannot both win). Every column is written.
   */
  async createWithItems(
    input: CreateContactSyncRunInput,
    tx: DatabaseClient = db,
  ): Promise<ContactSyncRunWithItems | null> {
    const [run] = await tx
      .insert(contactSyncRunModel)
      .values({
        workspaceId: input.workspaceId,
        provider: input.provider,
        status: "pending",
        triggerSource: input.triggerSource,
        requestedByUserId: input.requestedByUserId,
        syncTags: input.syncTags,
        syncCustomFields: input.syncCustomFields,
        overwriteExisting: input.overwriteExisting,
        startedAt: null,
        finishedAt: null,
        lastHeartbeatAt: null,
        pausedUntil: null,
        claimToken: null,
        attempts: 0,
        chunkSeq: 0,
        currentError: null,
      })
      // Targetless: a partial unique index cannot be a `target` without
      // repeating its predicate.
      .onConflictDoNothing()
      .returning()
    if (!run) {
      return null
    }
    const items = await tx
      .insert(contactSyncRunItemModel)
      .values(
        input.items.map((item, position) => ({
          runId: run.id,
          workspaceId: input.workspaceId,
          integrationId: item.integrationId,
          inboxId: item.inboxId,
          sourceAccountName: item.sourceAccountName,
          position,
          status: "pending" as const,
          cursor: null,
          upperBoundId: null,
          createdCount: 0,
          updatedCount: 0,
          skippedCount: 0,
          failedCount: 0,
          skippedValueCount: 0,
          currentError: null,
          startedAt: null,
          finishedAt: null,
        })),
      )
      .returning()
    return { ...run, items }
  },

  /** The workspace's live run, if any. */
  async findLive(
    workspaceId: string,
    tx: DatabaseClient = db,
  ): Promise<ContactSyncRunModel | null> {
    const [row] = await tx
      .select()
      .from(contactSyncRunModel)
      .where(
        and(
          eq(contactSyncRunModel.workspaceId, workspaceId),
          inArray(contactSyncRunModel.status, CONTACT_SYNC_LIVE_STATUSES),
        ),
      )
      .limit(1)
    return row ?? null
  },

  /**
   * The latest run that actually reached its source (at least one item
   * started fetching): the cooldown is measured from it. A run that failed
   * before contacting the source does not count.
   */
  async findLatestFetchedRun(
    workspaceId: string,
    tx: DatabaseClient = db,
  ): Promise<Pick<ContactSyncRunModel, "id" | "createdAt"> | null> {
    const [row] = await tx
      .select({
        id: contactSyncRunModel.id,
        createdAt: contactSyncRunModel.createdAt,
      })
      .from(contactSyncRunModel)
      .where(
        and(
          eq(contactSyncRunModel.workspaceId, workspaceId),
          exists(
            tx
              .select({ one: sql`1` })
              .from(contactSyncRunItemModel)
              .where(
                and(
                  eq(contactSyncRunItemModel.runId, contactSyncRunModel.id),
                  isNotNull(contactSyncRunItemModel.startedAt),
                ),
              ),
          ),
        ),
      )
      .orderBy(desc(contactSyncRunModel.createdAt))
      .limit(1)
    return row ?? null
  },

  async findForWorkspace(
    input: { runId: string; workspaceId: string },
    tx: DatabaseClient = db,
  ): Promise<ContactSyncRunWithItems | null> {
    const row = await tx.query.contactSyncRunModel.findFirst({
      where: { id: input.runId, workspaceId: input.workspaceId },
      with: { items: { orderBy: { position: "asc" } } },
    })
    return row ?? null
  },

  async listHistory(
    input: { workspaceId: string; page?: number; perPage?: number },
    tx: DatabaseClient = db,
  ) {
    const pagination = getPaginationWithDefaults(input)
    const [data, total] = await Promise.all([
      tx.query.contactSyncRunModel.findMany({
        where: { workspaceId: input.workspaceId },
        orderBy: { createdAt: "desc" },
        with: { items: { orderBy: { position: "asc" } } },
        ...pagination,
      }),
      tx.$count(
        contactSyncRunModel,
        eq(contactSyncRunModel.workspaceId, input.workspaceId),
      ),
    ])
    return { data, total, pageCount: Math.ceil(total / pagination.limit) }
  },

  /**
   * Claims a run for THIS worker and mints a fresh token. Only a `pending`
   * run, or a `running` / `cancelling` one that is released (no token) or
   * whose lease is stale, can be claimed: a terminal run is never reopened by
   * a stale job. A paused run cannot be claimed before its pause ends, except
   * a `cancelling` one. `startedAt` is COALESCEd so resumes keep the first start.
   */
  async claim(
    input: { runId: string; workspaceId: string },
    tx: DatabaseClient = db,
  ): Promise<ContactSyncRunModel | null> {
    const [row] = await tx
      .update(contactSyncRunModel)
      .set({
        status: sql`CASE WHEN ${contactSyncRunModel.status} = 'pending' THEN 'running'::"contactSyncRunStatus" ELSE ${contactSyncRunModel.status} END`,
        // Web Crypto: reachable from a Next Server Component too.
        claimToken: crypto.randomUUID(),
        pausedUntil: null,
        startedAt: sql`COALESCE(${contactSyncRunModel.startedAt}, NOW())`,
        lastHeartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(contactSyncRunModel.id, input.runId),
          // A job for another workspace must not take (and strand) the lease.
          eq(contactSyncRunModel.workspaceId, input.workspaceId),
          inArray(contactSyncRunModel.status, CONTACT_SYNC_LIVE_STATUSES),
          pauseElapsed(),
          sql`(
            ${contactSyncRunModel.status} = 'pending'
            OR ${contactSyncRunModel.claimToken} IS NULL
            OR ${contactSyncRunModel.lastHeartbeatAt} < NOW() - ${leaseStaleInterval()}
          )`,
        ),
      )
      .returning()
    return row ?? null
  },

  /**
   * Fenced heartbeat taken before every source call: `null` means the claim
   * was lost or the run is no longer live, so the caller stops at once.
   */
  renewLease(
    input: { runId: string; expect: ContactSyncRunGuard },
    tx: DatabaseClient = db,
  ) {
    return touchGuardedRun(input.runId, input.expect, tx)
  },

  /** The first item still to process, in `position` order. */
  async findNextItem(
    runId: string,
    tx: DatabaseClient = db,
  ): Promise<ContactSyncRunItemModel | null> {
    const [row] = await tx
      .select()
      .from(contactSyncRunItemModel)
      .where(
        and(
          eq(contactSyncRunItemModel.runId, runId),
          inArray(contactSyncRunItemModel.status, ["pending", "running"]),
        ),
      )
      .orderBy(contactSyncRunItemModel.position)
      .limit(1)
    return row ?? null
  },

  /**
   * Marks an item `running` with its snapshot bound, under the run's guard.
   * Keeps an existing bound so a resumed item never widens its snapshot.
   */
  async startItem(
    input: {
      runId: string
      itemId: string
      expect: ContactSyncRunGuard
      upperBoundId: string | null
    },
    tx: DatabaseClient = db,
  ): Promise<ContactSyncRunItemModel | null> {
    return await tx.transaction(async (trx) => {
      if (!(await touchGuardedRun(input.runId, input.expect, trx))) {
        return null
      }
      const [row] = await trx
        .update(contactSyncRunItemModel)
        .set({
          status: "running",
          upperBoundId: sql`COALESCE(${contactSyncRunItemModel.upperBoundId}, ${input.upperBoundId})`,
          startedAt: sql`COALESCE(${contactSyncRunItemModel.startedAt}, NOW())`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(contactSyncRunItemModel.id, input.itemId),
            eq(contactSyncRunItemModel.runId, input.runId),
          ),
        )
        .returning()
      return row ?? null
    })
  },

  /**
   * The one fenced write after a page: cursor and counters of the item plus
   * the run heartbeat, together. Counters are incremented in SQL. Returns the
   * run's status, or `null` when the claim was lost (the caller abandons and
   * the counters are not added). A run being cancelled keeps the page that was
   * in flight but not its counters or cursor: the worker only winds it down.
   * Real progress resets the retry budget.
   */
  async recordItemProgress(
    input: {
      runId: string
      itemId: string
      expect: ContactSyncRunGuard
      cursor: string | null
      counters: ContactSyncItemCounters
    },
    tx: DatabaseClient = db,
  ): Promise<Extract<ContactSyncRunStatus, "running" | "cancelling"> | null> {
    const { counters } = input
    return await tx.transaction(async (trx) => {
      const status = await touchGuardedRun(input.runId, input.expect, trx, {
        resetAttempts: true,
      })
      if (status !== "running") {
        return status
      }
      await trx
        .update(contactSyncRunItemModel)
        .set({
          cursor: input.cursor,
          createdCount: sql`${contactSyncRunItemModel.createdCount} + ${counters.created}`,
          updatedCount: sql`${contactSyncRunItemModel.updatedCount} + ${counters.updated}`,
          skippedCount: sql`${contactSyncRunItemModel.skippedCount} + ${counters.skipped}`,
          failedCount: sql`${contactSyncRunItemModel.failedCount} + ${counters.failed}`,
          skippedValueCount: sql`${contactSyncRunItemModel.skippedValueCount} + ${counters.skippedValues}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(contactSyncRunItemModel.id, input.itemId),
            eq(contactSyncRunItemModel.runId, input.runId),
          ),
        )
      return status
    })
  },

  /** Terminal write of one item under the run's guard; `false` = claim lost. */
  async finishItem(
    input: {
      runId: string
      itemId: string
      expect: ContactSyncRunGuard
      status: Extract<
        ContactSyncRunItemStatus,
        "succeeded" | "partial" | "failed" | "cancelled"
      >
      currentError?: string | null
    },
    tx: DatabaseClient = db,
  ): Promise<boolean> {
    return await tx.transaction(async (trx) => {
      if (!(await touchGuardedRun(input.runId, input.expect, trx))) {
        return false
      }
      await trx
        .update(contactSyncRunItemModel)
        .set({
          status: input.status,
          currentError: input.currentError ?? null,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(contactSyncRunItemModel.id, input.itemId),
            eq(contactSyncRunItemModel.runId, input.runId),
          ),
        )
      return true
    })
  },

  /** Statuses of a run's items, to settle the run's own outcome. */
  async listItemStatuses(
    runId: string,
    tx: DatabaseClient = db,
  ): Promise<ContactSyncRunItemStatus[]> {
    const rows = await tx
      .select({ status: contactSyncRunItemModel.status })
      .from(contactSyncRunItemModel)
      .where(eq(contactSyncRunItemModel.runId, runId))
    return rows.map((row) => row.status)
  },

  /**
   * Releases the lease while the run stays live and advances the
   * continuation revision (makes the next chunk's job id unique). Returns the
   * new revision, or `null` when the guard failed. `pausedUntil` parks the
   * run (the source asked to wait): nothing claims it before then.
   */
  async yieldForContinuation(
    input: {
      runId: string
      expect: ContactSyncRunGuard
      pausedUntil?: Date
    },
    tx: DatabaseClient = db,
  ): Promise<number | null> {
    const [row] = await tx
      .update(contactSyncRunModel)
      .set({
        claimToken: null,
        chunkSeq: sql`${contactSyncRunModel.chunkSeq} + 1`,
        pausedUntil: input.pausedUntil ?? null,
        // A rate-limit pause is a deliberate wait, not a failed dispatch.
        ...(input.pausedUntil && { attempts: 0 }),
        lastHeartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(guardedRun(input.runId, input.expect))
      .returning({ chunkSeq: contactSyncRunModel.chunkSeq })
    return row?.chunkSeq ?? null
  },

  /**
   * Terminal write by the claim holder. A cancel accepted after the worker
   * computed its outcome still wins: the row's own `cancelling` status is
   * read in the same statement. Items still open end `cancelled` so the
   * history never shows a source as running forever.
   */
  async finish(
    input: {
      runId: string
      expect: ContactSyncRunGuard
      outcome: FinishContactSyncRunInput
    },
    tx: DatabaseClient = db,
  ): Promise<boolean> {
    return await tx.transaction(async (trx) => {
      const rows = await trx
        .update(contactSyncRunModel)
        .set({
          status: sql`CASE WHEN ${contactSyncRunModel.status} = 'cancelling'
            THEN 'cancelled'::"contactSyncRunStatus"
            ELSE ${input.outcome.status}::"contactSyncRunStatus" END`,
          ...(input.outcome.currentError !== undefined && {
            currentError: input.outcome.currentError,
          }),
          claimToken: null,
          pausedUntil: null,
          finishedAt: new Date(),
          lastHeartbeatAt: new Date(),
          updatedAt: new Date(),
        })
        .where(guardedRun(input.runId, input.expect))
        .returning({ id: contactSyncRunModel.id })
      if (rows.length === 0) {
        return false
      }
      await closeOpenItems([input.runId], trx)
      return true
    })
  },

  /**
   * Cancels a workspace's live run (optionally only `runId`). A run nobody
   * holds is cancelled outright; a claimed one becomes `cancelling` and its
   * claim holder winds it down at the next guarded write. Returns the row, or
   * `null` when nothing live matched.
   */
  async cancelLive(
    input: { workspaceId: string; runId?: string },
    tx: DatabaseClient = db,
  ): Promise<ContactSyncRunModel | null> {
    return await tx.transaction(async (trx) => {
      const [row] = await trx
        .update(contactSyncRunModel)
        .set(cancelPatch())
        .where(
          and(
            eq(contactSyncRunModel.workspaceId, input.workspaceId),
            input.runId ? eq(contactSyncRunModel.id, input.runId) : undefined,
            inArray(contactSyncRunModel.status, ["pending", "running"]),
          ),
        )
        .returning()
      if (row?.status === "cancelled") {
        await closeOpenItems([row.id], trx)
      }
      return row ?? null
    })
  },

  /** The live run that reads from `integrationId`, if any (disconnect cancels it). */
  async findLiveRunIdForIntegration(
    input: { workspaceId: string; integrationId: string },
    tx: DatabaseClient = db,
  ): Promise<string | null> {
    const [row] = await tx
      .select({ id: contactSyncRunModel.id })
      .from(contactSyncRunModel)
      .innerJoin(
        contactSyncRunItemModel,
        eq(contactSyncRunItemModel.runId, contactSyncRunModel.id),
      )
      .where(
        and(
          eq(contactSyncRunModel.workspaceId, input.workspaceId),
          inArray(contactSyncRunModel.status, CONTACT_SYNC_LIVE_STATUSES),
          eq(contactSyncRunItemModel.integrationId, input.integrationId),
        ),
      )
      .limit(1)
    return row?.id ?? null
  },

  /**
   * Sweeper fallback for a released continuation whose job could not be
   * enqueued: puts a `running` + no-token row back to `pending`.
   */
  async reopenReleased(
    input: { runId: string },
    tx: DatabaseClient = db,
  ): Promise<number> {
    const rows = await tx
      .update(contactSyncRunModel)
      .set({ status: "pending", updatedAt: new Date() })
      .where(
        and(
          eq(contactSyncRunModel.id, input.runId),
          eq(contactSyncRunModel.status, "running"),
          isNull(contactSyncRunModel.claimToken),
          pauseElapsed(),
        ),
      )
      .returning({ id: contactSyncRunModel.id })
    return rows.length
  },

  /**
   * Terminalizes, at most `batchSize` per call, runs the sweeper retried to
   * exhaustion and nobody touched for a full lease: `cancelling` ends
   * `cancelled`, everything else `failed`. Rows are taken `FOR UPDATE SKIP
   * LOCKED`, so a backlog drains over several sweeps in short transactions.
   * Returns how many runs it ended.
   */
  async markMaxAttemptsFailed(
    input: { maxAttempts: number; errorCode: string; batchSize: number },
    tx: DatabaseClient = db,
  ): Promise<number> {
    return await tx.transaction(async (trx) => {
      const due = await trx
        .select({ id: contactSyncRunModel.id })
        .from(contactSyncRunModel)
        .where(
          and(
            sql`${contactSyncRunModel.attempts} >= ${input.maxAttempts}`,
            inArray(contactSyncRunModel.status, CONTACT_SYNC_LIVE_STATUSES),
            pauseElapsed(),
            sql`(${contactSyncRunModel.lastHeartbeatAt} IS NULL
              OR ${contactSyncRunModel.lastHeartbeatAt} < NOW() - ${leaseStaleInterval()})`,
            sql`${contactSyncRunModel.updatedAt} < NOW() - ${leaseStaleInterval()}`,
          ),
        )
        .orderBy(contactSyncRunModel.createdAt)
        .limit(input.batchSize)
        .for("update", { skipLocked: true })
      const runIds = due.map((row) => row.id)
      if (runIds.length === 0) {
        return 0
      }
      await trx
        .update(contactSyncRunModel)
        .set({
          status: sql`CASE WHEN ${contactSyncRunModel.status} = 'cancelling' THEN 'cancelled'::"contactSyncRunStatus" ELSE 'failed'::"contactSyncRunStatus" END`,
          currentError: input.errorCode,
          claimToken: null,
          pausedUntil: null,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(inArray(contactSyncRunModel.id, runIds))
      await closeOpenItems(runIds, trx)
      return runIds.length
    })
  },

  /**
   * Undoes what `pickDue` just did when the previous dispatch is still
   * queued, so a backed-up queue never burns the retry budget. Only while the
   * row still holds exactly the picked values.
   */
  async refundDispatch(
    input: { runId: string; attempts: number; chunkSeq: number },
    tx: DatabaseClient = db,
  ): Promise<boolean> {
    const rows = await tx
      .update(contactSyncRunModel)
      .set({
        attempts: sql`${contactSyncRunModel.attempts} - 1`,
        chunkSeq: sql`${contactSyncRunModel.chunkSeq} - 1`,
      })
      .where(
        and(
          eq(contactSyncRunModel.id, input.runId),
          eq(contactSyncRunModel.attempts, input.attempts),
          eq(contactSyncRunModel.chunkSeq, input.chunkSeq),
          gt(contactSyncRunModel.attempts, 0),
          gt(contactSyncRunModel.chunkSeq, 0),
        ),
      )
      .returning({ id: contactSyncRunModel.id })
    return rows.length > 0
  },

  /**
   * Claims due runs for the sweeper and burns one attempt each: a `pending`
   * run past the grace period, a run whose lease went stale (worker died), or
   * a released continuation never re-claimed. `cancelling` keeps its status.
   */
  async pickDue(
    input: { maxAttempts: number; batchSize: number },
    tx: DatabaseClient = db,
  ): Promise<PickedContactSyncRun[]> {
    const picked = await tx.execute<PickedContactSyncRun>(sql`
      UPDATE "ContactSyncRun"
      SET attempts = attempts + 1,
          "chunkSeq" = "chunkSeq" + 1,
          status = CASE WHEN status = 'cancelling' THEN status ELSE 'pending' END,
          "updatedAt" = NOW()
      WHERE id IN (
        SELECT id FROM "ContactSyncRun"
        WHERE status IN (${liveStatusList()})
          AND attempts < ${input.maxAttempts}
          AND ("pausedUntil" IS NULL OR "pausedUntil" <= NOW() OR status = 'cancelling')
          AND (
            (status = 'pending' AND "updatedAt" < NOW() - INTERVAL '2 minutes')
            OR (status IN ('running', 'cancelling')
                AND "claimToken" IS NOT NULL
                AND "lastHeartbeatAt" < NOW() - ${leaseStaleInterval()})
            OR (status IN ('running', 'cancelling')
                AND "claimToken" IS NULL
                AND "lastHeartbeatAt" < NOW() - ${releasedStaleInterval()})
          )
        ORDER BY "createdAt" ASC
        LIMIT ${input.batchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, "workspaceId", attempts, "chunkSeq", status
    `)
    return picked.rows
  },
}

/** Items of finished runs that never settled are shown as cancelled. */
const closeOpenItems = async (runIds: string[], tx: DatabaseClient) => {
  await tx
    .update(contactSyncRunItemModel)
    .set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        inArray(contactSyncRunItemModel.runId, runIds),
        inArray(contactSyncRunItemModel.status, ["pending", "running"]),
      ),
    )
}
