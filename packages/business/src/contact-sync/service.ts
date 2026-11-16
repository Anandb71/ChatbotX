import {
  and,
  type DatabaseClient,
  db,
  eq,
  inArray,
  ne,
  sql,
} from "@chatbotx.io/database/client"
import type {
  ChannelType,
  ContactSyncProvider,
  ContactSyncTriggerSource,
  IntegrationType,
} from "@chatbotx.io/database/partials"
import {
  type ContactSyncItemCounters,
  type ContactSyncRunGuard,
  connectionRepository,
  contactSyncMappingRepository,
  contactSyncRunRepository,
  type FinishContactSyncRunInput,
} from "@chatbotx.io/database/repositories"
import { connectionModel, tagModel } from "@chatbotx.io/database/schema"
import type {
  ContactSyncRunItemModel,
  ContactSyncRunModel,
} from "@chatbotx.io/database/types"
import { getChildLogger } from "@chatbotx.io/logger"
import type { AuthValue } from "@chatbotx.io/sdk"
import { ACTIVE_CONNECTION_STATUSES } from "@chatbotx.io/utils/connection"
import {
  buildContactSyncJobId,
  IntegrationJobAction,
  integrationQueue,
} from "@chatbotx.io/worker-config"
import { BaseService } from "../base.service"
import { connectionStateService } from "../connection/state-service"
import { CONNECTION_STORE_BINDINGS } from "../connection/store-bindings"
import { workspaceService } from "../workspace/service"
import {
  type ContactSyncAvailability,
  resolveContactSyncAvailability,
} from "./availability"
import {
  CONTACT_SYNC_ERROR_CODES,
  CONTACT_SYNC_INELIGIBLE_REASONS,
  CONTACT_SYNC_MAX_ATTEMPTS,
  CONTACT_SYNC_MAX_SOURCES_PER_RUN,
  CONTACT_SYNC_SWEEP_BATCH_SIZE,
  type ContactSyncIneligibleReason,
} from "./constants"
import {
  assertContactSyncAvailable,
  ContactSyncMappingError,
  contactSyncAlreadyRunningError,
  contactSyncException,
} from "./errors"
import { externalFieldTypeTargets, isCompatibleFieldType } from "./field-type"
import type { ContactSyncImportContext } from "./import-page"
import {
  inboxMatchKey,
  type MatchedInbox,
  matchInboxesForAccounts,
} from "./inbox-match"
import { loadContactSyncMappingState, loadCustomFieldsByIds } from "./mapping"
import {
  type ContactSyncFieldMappingInput,
  type ContactSyncTagMappingInput,
  planContactSyncMappings,
} from "./mapping-input"
import { contactSyncAdapters } from "./providers"
import type {
  ContactSyncAdapter,
  ContactSyncSchema,
  ContactSyncSourceAccount,
} from "./types"

const log = getChildLogger("contact-sync")

/** BullMQ states in which a chunk job has not started and will still run. */
const QUEUED_JOB_STATES: ReadonlySet<string> = new Set([
  "waiting",
  "delayed",
  "prioritized",
  "waiting-children",
])

const ADAPTER_BY_INTEGRATION_TYPE = new Map<
  IntegrationType,
  ContactSyncAdapter
>(
  Object.values(contactSyncAdapters).map(
    (adapter) => [adapter.integrationType, adapter] as const,
  ),
)

const adapterFor = (provider: ContactSyncProvider) =>
  contactSyncAdapters[provider]

/** A connected external account a workspace can import contacts from. */
export type ContactSyncSource = {
  connectionId: string
  integrationId: string
  provider: ContactSyncProvider
  connectionStatus: string
  account: ContactSyncSourceAccount
  matchedInboxes: MatchedInbox[]
  eligible: boolean
  ineligibleReason: ContactSyncIneligibleReason | null
}

export type ScheduleContactSyncInput = {
  workspaceId: string
  requestedByUserId: string | null
  triggerSource: ContactSyncTriggerSource
  sources: { connectionId: string; inboxId?: string }[]
  syncTags: boolean
  syncCustomFields: boolean
  overwriteExisting: boolean
}

/** What a chunk needs to know about the workspace, read once per chunk. */
export type ContactSyncWorkerContext = ContactSyncImportContext

type ResolvedRunSource = {
  integrationId: string
  inboxId: string
  sourceAccountName: string | null
}

class ContactSyncService extends BaseService {
  /** Every connected source of the workspace, with the inboxes it can import into. */
  async listSources(input: {
    workspaceId: string
    provider?: ContactSyncProvider
  }): Promise<ContactSyncSource[]> {
    const adapters = input.provider
      ? [adapterFor(input.provider)]
      : Object.values(contactSyncAdapters)
    const connections = await db
      .select({
        id: connectionModel.id,
        provider: connectionModel.provider,
        integrationId: connectionModel.integrationId,
        status: connectionModel.status,
      })
      .from(connectionModel)
      .where(
        and(
          eq(connectionModel.workspaceId, input.workspaceId),
          inArray(
            connectionModel.provider,
            adapters.map((adapter) => adapter.integrationType),
          ),
          ne(connectionModel.status, "disconnected"),
        ),
      )
      .orderBy(connectionModel.createdAt)

    const accounts = new Map<string, ContactSyncSourceAccount>()
    for (const adapter of adapters) {
      const byIntegration = await adapter.listAccounts({
        workspaceId: input.workspaceId,
        integrationIds: connections.flatMap((connection) =>
          connection.provider === adapter.integrationType &&
          connection.integrationId
            ? [connection.integrationId]
            : [],
        ),
      })
      for (const [integrationId, account] of byIntegration) {
        accounts.set(integrationId, account)
      }
    }

    const matched = await matchInboxesForAccounts({
      workspaceId: input.workspaceId,
      accounts: [...accounts.values()].flatMap((account) =>
        account.channel
          ? [{ channel: account.channel, accountId: account.accountId }]
          : [],
      ),
    })

    return connections.flatMap((connection) => {
      const adapter = ADAPTER_BY_INTEGRATION_TYPE.get(connection.provider)
      const account = connection.integrationId
        ? accounts.get(connection.integrationId)
        : undefined
      if (!(adapter && account && connection.integrationId)) {
        return []
      }
      const matchedInboxes = account.channel
        ? (matched.get(inboxMatchKey(account.channel, account.accountId)) ?? [])
        : []
      const ineligibleReason = ineligibleReasonOf({
        account,
        matchedInboxes,
        connectionStatus: connection.status,
      })
      return [
        {
          connectionId: connection.id,
          integrationId: connection.integrationId,
          provider: adapter.provider,
          connectionStatus: connection.status,
          account,
          matchedInboxes,
          eligible: ineligibleReason === null,
          ineligibleReason,
        },
      ]
    })
  }

  /** The source's tags and fields with what each one maps to now. */
  async getSchema(input: { workspaceId: string; connectionId: string }) {
    const source = await this.findSourceOrFail(input)
    const schema = await this.loadSourceSchema(input.workspaceId, source)
    const state = await loadContactSyncMappingState(
      { workspaceId: input.workspaceId, integrationId: source.integrationId },
      schema,
    )
    const [tagNames, fieldsById] = await Promise.all([
      this.findTagNames(
        input.workspaceId,
        [...state.tags.values()].map((tag) => tag.tagId),
      ),
      loadCustomFieldsByIds(
        input.workspaceId,
        [...state.fields.values()].map((field) => field.customFieldId),
      ),
    ])
    return {
      source,
      tags: schema.tags.map((tag) => {
        const mapped = state.tags.get(tag.id)
        return {
          id: tag.id,
          name: tag.name,
          mapping: mapped
            ? {
                tagId: mapped.tagId,
                tagName: tagNames.get(mapped.tagId) ?? null,
                origin: mapped.origin,
              }
            : null,
        }
      }),
      fields: schema.fields.map((field) => {
        const mapped = state.fields.get(field.id)
        return {
          id: field.id,
          name: field.name,
          type: field.type,
          defaultTargetType: externalFieldTypeTargets[field.type].default,
          compatibleTargetTypes: [
            ...externalFieldTypeTargets[field.type].compatible,
          ],
          mapping: mapped
            ? {
                customFieldId: mapped.customFieldId,
                customFieldName:
                  fieldsById.get(mapped.customFieldId)?.name ?? null,
                customFieldType: mapped.type,
                origin: mapped.origin,
                typeMismatch: !isCompatibleFieldType(field.type, mapped.type),
              }
            : null,
        }
      }),
    }
  }

  /**
   * Saves the user's tag/field mappings of one source. Every row is checked
   * first (`planContactSyncMappings`); any invalid row rejects the whole call
   * with a `ContactSyncMappingError` listing each problem.
   */
  async saveMappings(input: {
    workspaceId: string
    connectionId: string
    tags?: ContactSyncTagMappingInput[]
    fields?: ContactSyncFieldMappingInput[]
  }): Promise<void> {
    const source = await this.findSourceOrFail(input)
    const plan = await planContactSyncMappings({
      workspaceId: input.workspaceId,
      schema: await this.loadSourceSchema(input.workspaceId, source),
      tags: input.tags ?? [],
      fields: input.fields ?? [],
    })
    if (plan.issues.length > 0) {
      throw new ContactSyncMappingError(plan.issues)
    }
    const scope = {
      workspaceId: input.workspaceId,
      integrationId: source.integrationId,
    }
    await db.transaction(async (tx) => {
      await contactSyncMappingRepository.upsertManual(
        { ...scope, rows: plan.upserts },
        tx,
      )
      await contactSyncMappingRepository.deleteByExternalIds(
        { ...scope, kind: "tag", externalIds: plan.tagRemovals },
        tx,
      )
      await contactSyncMappingRepository.deleteByExternalIds(
        { ...scope, kind: "customField", externalIds: plan.fieldRemovals },
        tx,
      )
    })
  }

  async getAvailability(input: {
    workspaceId: string
    now?: Date
    tx?: DatabaseClient
  }): Promise<ContactSyncAvailability> {
    const tx = input.tx ?? db
    const [live, latest] = await Promise.all([
      contactSyncRunRepository.findLive(input.workspaceId, tx),
      contactSyncRunRepository.findLatestFetchedRun(input.workspaceId, tx),
    ])
    return resolveContactSyncAvailability({
      liveRunId: live?.id ?? null,
      latestFetchedRunCreatedAt: latest?.createdAt ?? null,
      now: input.now ?? new Date(),
    })
  }

  /**
   * Starts a sync. Sources are validated first; then, under a per-workspace
   * transaction lock, availability is re-read and the run inserted, so two
   * requests right after the cooldown cannot both start one (the live unique
   * index is the second barrier). The first chunk is enqueued after commit.
   */
  async schedule(input: ScheduleContactSyncInput) {
    const { provider, items } = await this.resolveRunSources(input)
    const run = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`contact-sync:${input.workspaceId}`}, 0))`,
      )
      assertContactSyncAvailable(
        await this.getAvailability({ workspaceId: input.workspaceId, tx }),
      )
      const created = await contactSyncRunRepository.createWithItems(
        {
          workspaceId: input.workspaceId,
          provider,
          triggerSource: input.triggerSource,
          requestedByUserId: input.requestedByUserId,
          syncTags: input.syncTags,
          syncCustomFields: input.syncCustomFields,
          overwriteExisting: input.overwriteExisting,
          items,
        },
        tx,
      )
      if (!created) {
        // Lost to a run committed after the re-read: report that run.
        const live = await contactSyncRunRepository.findLive(
          input.workspaceId,
          tx,
        )
        throw contactSyncAlreadyRunningError(live?.id ?? "")
      }
      return created
    })
    // Best effort: a failed enqueue only delays the run until the sweeper.
    await this.enqueueChunk(run).catch((err) =>
      log.error({ err, runId: run.id }, "contact sync: enqueue failed"),
    )
    return run
  }

  async get(input: { workspaceId: string; runId: string }) {
    const run = await contactSyncRunRepository.findForWorkspace(input)
    if (!run) {
      throw contactSyncException(
        CONTACT_SYNC_ERROR_CODES.runNotFound,
        "Contact sync not found",
        404,
      )
    }
    return run
  }

  listHistory(input: { workspaceId: string; page?: number; perPage?: number }) {
    return contactSyncRunRepository.listHistory(input)
  }

  /** Idempotent: a run that already finished reports `cancelled: false`. */
  async cancel(input: { workspaceId: string; runId: string }) {
    await this.get(input)
    const run = await contactSyncRunRepository.cancelLive(input)
    return { cancelled: run !== null }
  }

  /** Cancels the live run reading from a source that is being disconnected. */
  async cancelForIntegration(
    input: { workspaceId: string; integrationId: string },
    tx: DatabaseClient = db,
  ): Promise<void> {
    const runId = await contactSyncRunRepository.findLiveRunIdForIntegration(
      input,
      tx,
    )
    if (runId) {
      await contactSyncRunRepository.cancelLive(
        { workspaceId: input.workspaceId, runId },
        tx,
      )
    }
  }

  // ── Engine / sweeper surface: the worker may not call repositories itself.

  async enqueueChunk(
    run: Pick<ContactSyncRunModel, "id" | "workspaceId" | "chunkSeq">,
    options: { delayMs?: number } = {},
  ): Promise<void> {
    await integrationQueue.add(
      IntegrationJobAction.contactSync,
      {
        type: IntegrationJobAction.contactSync,
        data: { runId: run.id, workspaceId: run.workspaceId },
      },
      {
        jobId: buildContactSyncJobId({
          runId: run.id,
          chunkSeq: run.chunkSeq,
        }),
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: { count: 100 },
        ...(options.delayMs && { delay: options.delayMs }),
      },
    )
  }

  /**
   * Sweeper: whether the dispatch before the one `pickDue` just made is
   * still queued (the shared queue can lag); if so the attempt is given back.
   */
  async refundIfPreviousChunkQueued(
    run: Pick<ContactSyncRunModel, "id" | "attempts" | "chunkSeq" | "status">,
  ): Promise<boolean> {
    if (run.status === "cancelling") {
      return false
    }
    try {
      const previous = await integrationQueue.getJob(
        buildContactSyncJobId({ runId: run.id, chunkSeq: run.chunkSeq - 1 }),
      )
      if (!(previous && QUEUED_JOB_STATES.has(await previous.getState()))) {
        return false
      }
    } catch (err) {
      log.warn({ err, runId: run.id }, "could not look up the queued chunk job")
      return false
    }
    await contactSyncRunRepository.refundDispatch({
      runId: run.id,
      attempts: run.attempts,
      chunkSeq: run.chunkSeq,
    })
    return true
  }

  /** The workspace data every normalizer and the quota need, read once per chunk. */
  async loadWorkerContext(
    workspaceId: string,
  ): Promise<ContactSyncWorkerContext | null> {
    const workspace = await workspaceService.find({
      where: { id: workspaceId },
    })
    if (!workspace) {
      return null
    }
    return {
      workspaceId,
      ownerId: workspace.ownerId,
      targetCountry: workspace.targetCountry,
      workspaceTimezone: workspace.timezone,
    }
  }

  /** The decrypted auth of a source connection. */
  async loadSourceAuth(input: {
    workspaceId: string
    provider: ContactSyncProvider
    integrationId: string
  }): Promise<AuthValue> {
    const binding =
      CONNECTION_STORE_BINDINGS[adapterFor(input.provider).integrationType]
    if (!binding) {
      throw new Error(`No store binding for ${input.provider}`)
    }
    return await binding.loadAuthByForeignKey(
      input.integrationId,
      input.workspaceId,
    )
  }

  /** The source's token no longer works: its connection needs a reconnect. */
  async markSourceNeedsReauth(input: {
    workspaceId: string
    integrationId: string
  }): Promise<void> {
    const connection = await connectionRepository.findByIntegrationId({
      integrationId: input.integrationId,
    })
    if (connection?.workspaceId === input.workspaceId) {
      await connectionStateService.markUnhealthy({
        connectionId: connection.id,
      })
    }
  }

  /** The item's inbox, still connected; `null` when it is gone. */
  async findItemInbox(
    item: Pick<ContactSyncRunItemModel, "workspaceId" | "inboxId">,
  ): Promise<{ id: string; channel: ChannelType } | null> {
    if (!item.inboxId) {
      return null
    }
    const inbox = await db.query.inboxModel.findFirst({
      where: {
        id: item.inboxId,
        workspaceId: item.workspaceId,
        status: "connected",
      },
      columns: { id: true, channel: true },
    })
    if (!inbox) {
      return null
    }
    return { id: inbox.id, channel: inbox.channel as ChannelType }
  }

  adapterFor(provider: ContactSyncProvider): ContactSyncAdapter {
    return adapterFor(provider)
  }

  claim(input: { runId: string; workspaceId: string }) {
    return contactSyncRunRepository.claim(input)
  }

  renewLease(input: { runId: string; expect: ContactSyncRunGuard }) {
    return contactSyncRunRepository.renewLease(input)
  }

  findNextItem(runId: string) {
    return contactSyncRunRepository.findNextItem(runId)
  }

  startItem(input: {
    runId: string
    itemId: string
    expect: ContactSyncRunGuard
    upperBoundId: string | null
  }) {
    return contactSyncRunRepository.startItem(input)
  }

  recordItemProgress(input: {
    runId: string
    itemId: string
    expect: ContactSyncRunGuard
    cursor: string | null
    counters: ContactSyncItemCounters
  }) {
    return contactSyncRunRepository.recordItemProgress(input)
  }

  finishItem(input: Parameters<typeof contactSyncRunRepository.finishItem>[0]) {
    return contactSyncRunRepository.finishItem(input)
  }

  yieldForContinuation(input: {
    runId: string
    expect: ContactSyncRunGuard
    pausedUntil?: Date
  }) {
    return contactSyncRunRepository.yieldForContinuation(input)
  }

  /**
   * Ends the run from its items: all succeeded → `succeeded`; none
   * succeeded or partial → `failed`; otherwise `partial`. A cancel wins.
   */
  async finish(input: {
    run: Pick<ContactSyncRunModel, "id" | "status">
    expect: ContactSyncRunGuard
  }): Promise<boolean> {
    const statuses = await contactSyncRunRepository.listItemStatuses(
      input.run.id,
    )
    return await contactSyncRunRepository.finish({
      runId: input.run.id,
      expect: input.expect,
      outcome: settleRunOutcome(input.run.status, statuses),
    })
  }

  reopenReleased(runId: string) {
    return contactSyncRunRepository.reopenReleased({ runId })
  }

  /** Ends at most one batch of exhausted runs per sweep (`CONTACT_SYNC_SWEEP_BATCH_SIZE`). */
  markMaxAttemptsFailed() {
    return contactSyncRunRepository.markMaxAttemptsFailed({
      maxAttempts: CONTACT_SYNC_MAX_ATTEMPTS,
      errorCode: "maxAttempts",
      batchSize: CONTACT_SYNC_SWEEP_BATCH_SIZE,
    })
  }

  pickDue(input: { batchSize: number }) {
    return contactSyncRunRepository.pickDue({
      ...input,
      maxAttempts: CONTACT_SYNC_MAX_ATTEMPTS,
    })
  }

  // ── Internals

  private async findSourceOrFail(input: {
    workspaceId: string
    connectionId: string
  }): Promise<ContactSyncSource> {
    const sources = await this.listSources({ workspaceId: input.workspaceId })
    const source = sources.find(
      (candidate) => candidate.connectionId === input.connectionId,
    )
    if (!source) {
      throw contactSyncException(
        CONTACT_SYNC_ERROR_CODES.sourceNotFound,
        "Contact sync source not found",
        404,
      )
    }
    return source
  }

  /** The source's current tags and fields, read with its stored token. */
  private async loadSourceSchema(
    workspaceId: string,
    source: ContactSyncSource,
  ): Promise<ContactSyncSchema> {
    const auth = await this.loadSourceAuth({
      workspaceId,
      provider: source.provider,
      integrationId: source.integrationId,
    })
    return await adapterFor(source.provider).listSchema(auth)
  }

  /** Validates the requested sources and picks each one's inbox. */
  private async resolveRunSources(input: ScheduleContactSyncInput): Promise<{
    provider: ContactSyncProvider
    items: ResolvedRunSource[]
  }> {
    assertSourceListShape(input.sources)
    const available = new Map(
      (await this.listSources({ workspaceId: input.workspaceId })).map(
        (source) => [source.connectionId, source] as const,
      ),
    )
    const resolved = input.sources.map((requested) => {
      const source = available.get(requested.connectionId)
      if (!source) {
        throw contactSyncException(
          CONTACT_SYNC_ERROR_CODES.sourceNotFound,
          `Source ${requested.connectionId} not found`,
          404,
        )
      }
      if (!source.eligible) {
        throw contactSyncException(
          CONTACT_SYNC_ERROR_CODES.sourceNotEligible,
          `Source ${requested.connectionId} cannot be synced: ${source.ineligibleReason}`,
        )
      }
      return { source, inbox: pickInbox(source, requested.inboxId) }
    })
    const providers = new Set(resolved.map(({ source }) => source.provider))
    const [provider] = providers
    if (!provider || providers.size > 1) {
      throw contactSyncException(
        CONTACT_SYNC_ERROR_CODES.sourceNotEligible,
        "All sources of one sync must come from the same provider",
      )
    }
    return {
      provider,
      items: resolved.map(({ source, inbox }) => ({
        integrationId: source.integrationId,
        inboxId: inbox.id,
        sourceAccountName: source.account.name,
      })),
    }
  }

  /** Names of the workspace's tags among `ids`, by id. */
  private async findTagNames(
    workspaceId: string,
    ids: string[],
  ): Promise<Map<string, string>> {
    if (ids.length === 0) {
      return new Map()
    }
    const rows = await db
      .select({ id: tagModel.id, name: tagModel.name })
      .from(tagModel)
      .where(
        and(
          eq(tagModel.workspaceId, workspaceId),
          inArray(tagModel.id, [...new Set(ids)]),
        ),
      )
    return new Map(rows.map((row) => [row.id, row.name] as const))
  }
}

/** A run's source list must be non-empty, bounded and free of repeats. */
const assertSourceListShape = (
  sources: ScheduleContactSyncInput["sources"],
): void => {
  if (sources.length === 0) {
    throw contactSyncException(
      CONTACT_SYNC_ERROR_CODES.noSources,
      "Choose at least one source",
    )
  }
  if (sources.length > CONTACT_SYNC_MAX_SOURCES_PER_RUN) {
    throw contactSyncException(
      CONTACT_SYNC_ERROR_CODES.tooManySources,
      `At most ${CONTACT_SYNC_MAX_SOURCES_PER_RUN} sources per sync`,
    )
  }
  const connectionIds = sources.map((source) => source.connectionId)
  if (new Set(connectionIds).size !== connectionIds.length) {
    throw contactSyncException(
      CONTACT_SYNC_ERROR_CODES.duplicateSource,
      "A source is listed twice",
    )
  }
}

const ineligibleReasonOf = (input: {
  account: ContactSyncSourceAccount
  matchedInboxes: MatchedInbox[]
  connectionStatus: string
}): ContactSyncIneligibleReason | null => {
  if (!input.account.channel) {
    return CONTACT_SYNC_INELIGIBLE_REASONS.channelUnsupported
  }
  if (
    !(ACTIVE_CONNECTION_STATUSES as readonly string[]).includes(
      input.connectionStatus,
    )
  ) {
    return CONTACT_SYNC_INELIGIBLE_REASONS.connectionUnhealthy
  }
  if (input.matchedInboxes.length === 0) {
    return CONTACT_SYNC_INELIGIBLE_REASONS.noMatchingInbox
  }
  return null
}

/** One matched inbox is used as is; several require the caller to choose. */
const pickInbox = (source: ContactSyncSource, inboxId?: string) => {
  if (inboxId) {
    const inbox = source.matchedInboxes.find((match) => match.id === inboxId)
    if (!inbox) {
      throw contactSyncException(
        CONTACT_SYNC_ERROR_CODES.inboxNotMatched,
        `Inbox ${inboxId} does not belong to source ${source.connectionId}`,
      )
    }
    return inbox
  }
  const [only, ...others] = source.matchedInboxes
  if (!only || others.length > 0) {
    throw contactSyncException(
      CONTACT_SYNC_ERROR_CODES.inboxRequired,
      `Source ${source.connectionId} matches several inboxes: pass inboxId`,
    )
  }
  return only
}

const settleRunOutcome = (
  status: ContactSyncRunModel["status"],
  itemStatuses: ContactSyncRunItemModel["status"][],
): FinishContactSyncRunInput => {
  if (status === "cancelling") {
    return { status: "cancelled" }
  }
  const succeeded = itemStatuses.filter((item) => item === "succeeded").length
  if (succeeded === itemStatuses.length) {
    return { status: "succeeded" }
  }
  const anyProgress =
    succeeded > 0 || itemStatuses.some((item) => item === "partial")
  return { status: anyProgress ? "partial" : "failed" }
}

export const contactSyncService = new ContactSyncService()
