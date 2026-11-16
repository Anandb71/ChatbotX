import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  finish: vi.fn(),
  renewLease: vi.fn(),
  findNextItem: vi.fn(),
  startItem: vi.fn(),
  recordItemProgress: vi.fn(),
  finishItem: vi.fn(),
  yieldForContinuation: vi.fn(),
  enqueueChunk: vi.fn(),
  reopenReleased: vi.fn(),
  loadWorkerContext: vi.fn(),
  loadSourceAuth: vi.fn(),
  markSourceNeedsReauth: vi.fn(),
  findItemInbox: vi.fn(),
  importContactSyncPage: vi.fn(),
  loadMappingState: vi.fn(),
  readSnapshotBound: vi.fn(),
  listSchema: vi.fn(),
  listRecords: vi.fn(),
  classifyError: vi.fn(),
}))

vi.mock("@chatbotx.io/business", () => ({
  CONTACT_SYNC_CHUNK_BUDGET_MS: 60_000,
  CONTACT_SYNC_DEFAULT_PAUSE_MS: 60_000,
  CONTACT_SYNC_MAX_PAGES_PER_ITEM: 25_000,
  CONTACT_SYNC_MAX_PAUSE_MS: 30 * 60 * 1000,
  CONTACT_SYNC_PAGE_SIZE: 200,
  CONTACT_SYNC_PAGES_PER_CHUNK: 5,
  CONTACT_SYNC_RUN_ERRORS: {
    tokenInvalid: "tokenInvalid",
    inboxUnavailable: "inboxUnavailable",
    sourceUnavailable: "sourceUnavailable",
    sourceDisconnected: "sourceDisconnected",
    pageLimitReached: "pageLimitReached",
    maxAttempts: "maxAttempts",
  },
  contactSyncService: {
    claim: mocks.claim,
    finish: mocks.finish,
    renewLease: mocks.renewLease,
    findNextItem: mocks.findNextItem,
    startItem: mocks.startItem,
    recordItemProgress: mocks.recordItemProgress,
    finishItem: mocks.finishItem,
    yieldForContinuation: mocks.yieldForContinuation,
    enqueueChunk: mocks.enqueueChunk,
    reopenReleased: mocks.reopenReleased,
    loadWorkerContext: mocks.loadWorkerContext,
    loadSourceAuth: mocks.loadSourceAuth,
    markSourceNeedsReauth: mocks.markSourceNeedsReauth,
    findItemInbox: mocks.findItemInbox,
    adapterFor: () => ({
      provider: "ahachat",
      readSnapshotBound: mocks.readSnapshotBound,
      listSchema: mocks.listSchema,
      listRecords: mocks.listRecords,
      classifyError: mocks.classifyError,
    }),
  },
}))
vi.mock("@chatbotx.io/business/contact-sync/import", () => ({
  importContactSyncPage: mocks.importContactSyncPage,
  loadContactSyncMappingState: mocks.loadMappingState,
}))

const { runContactSync } = await import(
  "../src/integration/handlers/contact-sync/engine"
)

const DATA = { runId: "run-1", workspaceId: "ws-1" }
const AUTH = { authType: "custom", token: "t" }
const CONTEXT = {
  workspaceId: "ws-1",
  ownerId: "owner-1",
  targetCountry: "VN",
  workspaceTimezone: "Asia/Ho_Chi_Minh",
}
const EMPTY_STATE = { tags: new Map(), fields: new Map() }

const run = (overrides: Record<string, unknown> = {}) => ({
  id: "run-1",
  workspaceId: "ws-1",
  provider: "ahachat",
  status: "running",
  claimToken: "token-1",
  chunkSeq: 3,
  syncTags: true,
  syncCustomFields: true,
  overwriteExisting: false,
  ...overrides,
})

const item = (overrides: Record<string, unknown> = {}) => ({
  id: "item-1",
  runId: "run-1",
  workspaceId: "ws-1",
  integrationId: "int-1",
  inboxId: "inbox-1",
  status: "running",
  startedAt: new Date(),
  cursor: null,
  upperBoundId: "500",
  createdCount: 0,
  updatedCount: 0,
  skippedCount: 0,
  failedCount: 0,
  skippedValueCount: 0,
  ...overrides,
})

const page = (overrides: Record<string, unknown> = {}) => ({
  records: [{ externalId: "1" }],
  invalidCount: 0,
  nextCursor: "200",
  hasMore: false,
  ...overrides,
})

const counters = {
  created: 1,
  updated: 0,
  skipped: 0,
  failed: 0,
  skippedValues: 2,
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.claim.mockResolvedValue(run())
  mocks.loadWorkerContext.mockResolvedValue(CONTEXT)
  mocks.findNextItem.mockResolvedValueOnce(item()).mockResolvedValue(null)
  mocks.findItemInbox.mockResolvedValue({ id: "inbox-1", channel: "messenger" })
  mocks.loadSourceAuth.mockResolvedValue(AUTH)
  mocks.listSchema.mockResolvedValue({ tags: [], fields: [] })
  mocks.loadMappingState.mockResolvedValue(EMPTY_STATE)
  mocks.renewLease.mockResolvedValue("running")
  mocks.listRecords.mockResolvedValue(page())
  mocks.importContactSyncPage.mockResolvedValue({
    counters,
    state: EMPTY_STATE,
  })
  mocks.recordItemProgress.mockResolvedValue("running")
  mocks.finishItem.mockResolvedValue(true)
  mocks.finish.mockResolvedValue(true)
  mocks.yieldForContinuation.mockResolvedValue(4)
  mocks.enqueueChunk.mockResolvedValue(undefined)
})

describe("runContactSync", () => {
  test("does nothing when the run cannot be claimed", async () => {
    mocks.claim.mockResolvedValue(null)

    await runContactSync(DATA)

    expect(mocks.findNextItem).not.toHaveBeenCalled()
    expect(mocks.finish).not.toHaveBeenCalled()
  })

  test("imports a source to its end, then finishes the run", async () => {
    await runContactSync(DATA)

    expect(mocks.listRecords).toHaveBeenCalledWith(AUTH, {
      cursor: null,
      upperBoundId: "500",
      limit: 200,
    })
    expect(mocks.importContactSyncPage).toHaveBeenCalledWith(
      expect.objectContaining({
        context: CONTEXT,
        integrationId: "int-1",
        inbox: { id: "inbox-1", channel: "messenger" },
        options: expect.objectContaining({ overwriteExisting: false }),
      }),
    )
    expect(mocks.recordItemProgress).toHaveBeenCalledWith({
      runId: "run-1",
      itemId: "item-1",
      expect: { claimToken: "token-1" },
      cursor: "200",
      counters,
    })
    expect(mocks.finishItem).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "item-1", status: "succeeded" }),
    )
    expect(mocks.finish).toHaveBeenCalledWith({
      run: expect.objectContaining({ status: "running" }),
      expect: { claimToken: "token-1" },
    })
  })

  test("fixes the snapshot bound when an item starts", async () => {
    mocks.findNextItem.mockReset()
    mocks.findNextItem
      .mockResolvedValueOnce(
        item({ status: "pending", startedAt: null, upperBoundId: null }),
      )
      .mockResolvedValue(null)
    mocks.readSnapshotBound.mockResolvedValue("900")
    mocks.startItem.mockResolvedValue(item({ upperBoundId: "900" }))

    await runContactSync(DATA)

    expect(mocks.startItem).toHaveBeenCalledWith({
      runId: "run-1",
      itemId: "item-1",
      expect: { claimToken: "token-1" },
      upperBoundId: "900",
    })
    expect(mocks.listRecords).toHaveBeenCalledWith(
      AUTH,
      expect.objectContaining({ upperBoundId: "900" }),
    )
  })

  test("a source without contacts succeeds without reading pages", async () => {
    mocks.findNextItem.mockReset()
    mocks.findNextItem
      .mockResolvedValueOnce(
        item({ status: "pending", startedAt: null, upperBoundId: null }),
      )
      .mockResolvedValue(null)
    mocks.readSnapshotBound.mockResolvedValue(null)
    mocks.startItem.mockResolvedValue(item({ upperBoundId: null }))

    await runContactSync(DATA)

    expect(mocks.listRecords).not.toHaveBeenCalled()
    expect(mocks.finishItem).toHaveBeenCalledWith(
      expect.objectContaining({ status: "succeeded" }),
    )
  })

  test("yields after the page budget and queues the next chunk", async () => {
    mocks.listRecords.mockResolvedValue(page({ hasMore: true }))

    await runContactSync(DATA)

    expect(mocks.listRecords).toHaveBeenCalledTimes(5)
    expect(mocks.yieldForContinuation).toHaveBeenCalledWith({
      runId: "run-1",
      expect: { claimToken: "token-1" },
    })
    expect(mocks.enqueueChunk).toHaveBeenCalledWith(
      expect.objectContaining({ id: "run-1", chunkSeq: 4 }),
      {},
    )
    expect(mocks.finish).not.toHaveBeenCalled()
  })

  test("counts rows that broke the contract as failed", async () => {
    mocks.listRecords.mockResolvedValue(page({ invalidCount: 2 }))

    await runContactSync(DATA)

    expect(mocks.recordItemProgress).toHaveBeenCalledWith(
      expect.objectContaining({ counters: { ...counters, failed: 2 } }),
    )
    // The source finished, but not completely.
    expect(mocks.finishItem).toHaveBeenCalledWith(
      expect.objectContaining({ status: "partial", currentError: null }),
    )
  })

  test("rows that failed on an earlier page still end the source partial", async () => {
    mocks.findNextItem.mockReset()
    mocks.findNextItem
      .mockResolvedValueOnce(item({ cursor: "100", failedCount: 1 }))
      .mockResolvedValue(null)

    await runContactSync(DATA)

    expect(mocks.finishItem).toHaveBeenCalledWith(
      expect.objectContaining({ status: "partial" }),
    )
  })

  test("a source whose rows all imported ends succeeded", async () => {
    await runContactSync(DATA)

    expect(mocks.finishItem).toHaveBeenCalledWith(
      expect.objectContaining({ status: "succeeded" }),
    )
  })

  test("with tag and field sync both off the source schema is never fetched", async () => {
    mocks.claim.mockResolvedValue(
      run({ syncTags: false, syncCustomFields: false }),
    )

    await runContactSync(DATA)

    expect(mocks.listSchema).not.toHaveBeenCalled()
    expect(mocks.loadMappingState).toHaveBeenCalledWith(expect.anything(), {
      tags: [],
      fields: [],
    })
    expect(mocks.importContactSyncPage).toHaveBeenCalled()
  })

  test.each([
    { syncTags: true, syncCustomFields: false },
    { syncTags: false, syncCustomFields: true },
  ])("the schema is fetched when tags=$syncTags or fields=$syncCustomFields", async (flags) => {
    mocks.claim.mockResolvedValue(run(flags))

    await runContactSync(DATA)

    expect(mocks.listSchema).toHaveBeenCalledTimes(1)
  })

  test("a rate limit parks the run and queues a delayed chunk, capped", async () => {
    mocks.listRecords.mockRejectedValue(new Error("429"))
    mocks.classifyError.mockReturnValue({
      kind: "rateLimited",
      retryAfterMs: 2 * 60 * 60 * 1000,
    })

    await runContactSync(DATA)

    const yielded = mocks.yieldForContinuation.mock.calls[0]?.[0]
    expect(yielded.pausedUntil).toBeInstanceOf(Date)
    expect(mocks.enqueueChunk).toHaveBeenCalledWith(
      expect.objectContaining({ chunkSeq: 4 }),
      { delayMs: 30 * 60 * 1000 + 1000 },
    )
    expect(mocks.finishItem).not.toHaveBeenCalled()
  })

  test.each([
    { retryAfterMs: null, label: "no hint" },
    { retryAfterMs: 0, label: "a zero hint" },
  ])("a rate limit with $label waits the default minute", async ({
    retryAfterMs,
  }) => {
    mocks.listRecords.mockRejectedValue(new Error("429"))
    mocks.classifyError.mockReturnValue({ kind: "rateLimited", retryAfterMs })

    await runContactSync(DATA)

    expect(mocks.enqueueChunk).toHaveBeenCalledWith(expect.anything(), {
      delayMs: 60_000 + 1000,
    })
  })

  test("an invalid token fails the source, flags the connection and moves on", async () => {
    mocks.findNextItem.mockReset()
    mocks.findNextItem
      .mockResolvedValueOnce(item())
      .mockResolvedValueOnce(item({ id: "item-2", integrationId: "int-2" }))
      .mockResolvedValue(null)
    mocks.listRecords
      .mockRejectedValueOnce(new Error("401"))
      .mockResolvedValue(page())
    mocks.classifyError.mockReturnValue({ kind: "tokenInvalid" })

    await runContactSync(DATA)

    expect(mocks.markSourceNeedsReauth).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      integrationId: "int-1",
    })
    expect(mocks.finishItem).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: "item-1",
        status: "failed",
        currentError: "tokenInvalid",
      }),
    )
    expect(mocks.finishItem).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "item-2", status: "succeeded" }),
    )
    expect(mocks.finish).toHaveBeenCalled()
  })

  test("an outage lets the job fail for the sweeper to retry", async () => {
    const outage = new Error("503")
    mocks.listRecords.mockRejectedValue(outage)
    mocks.classifyError.mockReturnValue({ kind: "retryable" })

    await expect(runContactSync(DATA)).rejects.toBe(outage)
    expect(mocks.finishItem).not.toHaveBeenCalled()
    expect(mocks.yieldForContinuation).not.toHaveBeenCalled()
    expect(mocks.finish).not.toHaveBeenCalled()
  })

  test("a local import error is not swallowed: the job fails for the sweeper", async () => {
    const broken = new Error("insert failed")
    mocks.importContactSyncPage.mockRejectedValue(broken)
    mocks.classifyError.mockReturnValue({ kind: "retryable" })

    await expect(runContactSync(DATA)).rejects.toBe(broken)
    expect(mocks.recordItemProgress).not.toHaveBeenCalled()
    expect(mocks.finishItem).not.toHaveBeenCalled()
  })

  test("a fatal failure fails only that source", async () => {
    mocks.listRecords.mockRejectedValue(new Error("bad contract"))
    mocks.classifyError.mockReturnValue({ kind: "fatal" })

    await runContactSync(DATA)

    expect(mocks.finishItem).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        currentError: "sourceUnavailable",
      }),
    )
    expect(mocks.finish).toHaveBeenCalled()
  })

  test.each([
    [{ inboxId: null }, "inboxUnavailable"],
    [{ integrationId: null }, "sourceDisconnected"],
  ])("a source whose %o is gone fails with %s", async (patch, error) => {
    mocks.findNextItem.mockReset()
    mocks.findNextItem
      .mockResolvedValueOnce(item(patch))
      .mockResolvedValue(null)
    mocks.findItemInbox.mockResolvedValue(
      patch.inboxId === null ? null : { id: "inbox-1", channel: "messenger" },
    )

    await runContactSync(DATA)

    expect(mocks.listRecords).not.toHaveBeenCalled()
    expect(mocks.finishItem).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", currentError: error }),
    )
  })

  test("a lost lease stops before calling the source", async () => {
    mocks.renewLease.mockResolvedValue(null)

    await runContactSync(DATA)

    expect(mocks.listRecords).not.toHaveBeenCalled()
    expect(mocks.finish).not.toHaveBeenCalled()
    expect(mocks.yieldForContinuation).not.toHaveBeenCalled()
  })

  test("a cancel seen at the lease renewal winds the run down", async () => {
    mocks.renewLease.mockResolvedValue("cancelling")

    await runContactSync(DATA)

    expect(mocks.listRecords).not.toHaveBeenCalled()
    expect(mocks.finish).toHaveBeenCalledWith({
      run: expect.objectContaining({ status: "cancelling" }),
      expect: { claimToken: "token-1" },
    })
  })

  test("a run claimed while cancelling is finished at once", async () => {
    mocks.claim.mockResolvedValue(run({ status: "cancelling" }))

    await runContactSync(DATA)

    expect(mocks.findNextItem).not.toHaveBeenCalled()
    expect(mocks.finish).toHaveBeenCalled()
  })

  test("a cancel seen at the progress write reads no further page and winds the run down", async () => {
    mocks.listRecords.mockResolvedValue(page({ hasMore: true }))
    mocks.recordItemProgress.mockResolvedValue("cancelling")

    await runContactSync(DATA)

    expect(mocks.listRecords).toHaveBeenCalledTimes(1)
    expect(mocks.finishItem).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "succeeded" }),
    )
    expect(mocks.yieldForContinuation).not.toHaveBeenCalled()
    expect(mocks.finish).toHaveBeenCalledWith(
      expect.objectContaining({ expect: { claimToken: "token-1" } }),
    )
  })

  test("a progress write that lost the claim adds nothing and stops", async () => {
    mocks.recordItemProgress.mockResolvedValue(null)

    await runContactSync(DATA)

    expect(mocks.finishItem).not.toHaveBeenCalled()
    expect(mocks.finish).not.toHaveBeenCalled()
  })

  test("a source that says more without a cursor ends partial instead of looping", async () => {
    mocks.listRecords.mockResolvedValue(
      page({ hasMore: true, nextCursor: null }),
    )

    await runContactSync(DATA)

    expect(mocks.listRecords).toHaveBeenCalledTimes(1)
    expect(mocks.finishItem).toHaveBeenCalledWith(
      expect.objectContaining({ status: "partial" }),
    )
  })

  test("a lost continuation enqueue reopens the run for the sweeper", async () => {
    mocks.listRecords.mockResolvedValue(page({ hasMore: true }))
    mocks.enqueueChunk.mockRejectedValue(new Error("redis down"))

    await runContactSync(DATA)

    expect(mocks.reopenReleased).toHaveBeenCalledWith("run-1")
  })
})
