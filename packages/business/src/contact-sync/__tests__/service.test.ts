import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  connections: vi.fn(),
  execute: vi.fn(),
  findLive: vi.fn(),
  findLatestFetchedRun: vi.fn(),
  createWithItems: vi.fn(),
  cancelLive: vi.fn(),
  findForWorkspace: vi.fn(),
  findLiveRunIdForIntegration: vi.fn(),
  listItemStatuses: vi.fn(),
  finish: vi.fn(),
  listAccounts: vi.fn(),
  matchInboxes: vi.fn(),
  queueAdd: vi.fn(),
  listSchema: vi.fn(),
  loadAuth: vi.fn(),
  upsertManual: vi.fn(),
  listExhausted: vi.fn(),
  markMaxAttemptsFailed: vi.fn(),
  refundDispatch: vi.fn(),
  getJob: vi.fn(),
}))

/** `db.select().from().where().orderBy()` resolving to the connection rows. */
const selectChain = () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => mocks.connections(),
    limit: () => mocks.connections(),
  }
  return chain
}

vi.mock("@chatbotx.io/database/client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@chatbotx.io/database/client")>()
  const tx = { execute: mocks.execute }
  return {
    ...actual,
    db: {
      select: selectChain,
      transaction: (fn: (client: typeof tx) => unknown) => fn(tx),
    },
  }
})
vi.mock("@chatbotx.io/database/repositories", () => ({
  contactSyncRunRepository: {
    findLive: mocks.findLive,
    findLatestFetchedRun: mocks.findLatestFetchedRun,
    createWithItems: mocks.createWithItems,
    cancelLive: mocks.cancelLive,
    findForWorkspace: mocks.findForWorkspace,
    findLiveRunIdForIntegration: mocks.findLiveRunIdForIntegration,
    listItemStatuses: mocks.listItemStatuses,
    finish: mocks.finish,
    listExhausted: mocks.listExhausted,
    markMaxAttemptsFailed: mocks.markMaxAttemptsFailed,
    refundDispatch: mocks.refundDispatch,
  },
  contactSyncMappingRepository: { upsertManual: mocks.upsertManual },
}))
vi.mock("../providers", () => ({
  contactSyncAdapters: {
    ahachat: {
      provider: "ahachat",
      integrationType: "ahachat",
      listAccounts: mocks.listAccounts,
      listSchema: mocks.listSchema,
    },
  },
}))
vi.mock("../../connection/store-bindings", () => ({
  CONNECTION_STORE_BINDINGS: {
    ahachat: { loadAuthByForeignKey: mocks.loadAuth },
  },
}))
vi.mock("../inbox-match", () => ({
  inboxMatchKey: (channel: string, accountId: string) =>
    `${channel}:${accountId}`,
  matchInboxesForAccounts: mocks.matchInboxes,
}))
vi.mock("@chatbotx.io/worker-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/worker-config")>()),
  integrationQueue: { add: mocks.queueAdd, getJob: mocks.getJob },
}))

const { contactSyncService } = await import("../service")
const { ContactSyncMappingError } = await import("../errors")

const WORKSPACE = "ws-1"
const inbox = (id: string) => ({
  id,
  name: `Inbox ${id}`,
  channel: "messenger",
})

const connectionRow = (
  id: string,
  integrationId: string,
  status = "connected",
) => ({
  id,
  provider: "ahachat",
  integrationId,
  status,
})

const account = (accountId: string, channel: string | null = "messenger") => ({
  accountId,
  channel,
  name: `Page ${accountId}`,
  avatarUrl: null,
})

const scheduleInput = (
  sources: { connectionId: string; inboxId?: string }[],
) => ({
  workspaceId: WORKSPACE,
  requestedByUserId: "user-1",
  triggerSource: "app" as const,
  sources,
  syncTags: true,
  syncCustomFields: false,
  overwriteExisting: false,
})

beforeEach(() => {
  vi.resetAllMocks()
  mocks.connections.mockResolvedValue([
    connectionRow("conn-1", "int-1"),
    connectionRow("conn-2", "int-2"),
    connectionRow("conn-3", "int-3"),
    connectionRow("conn-4", "int-4", "needs_reauth"),
  ])
  mocks.listAccounts.mockResolvedValue(
    new Map([
      ["int-1", account("p1")],
      ["int-2", account("p2", "whatsapp")],
      ["int-3", account("p3", null)],
      ["int-4", account("p4")],
    ]),
  )
  mocks.matchInboxes.mockResolvedValue(
    new Map([
      ["messenger:p1", [inbox("i1")]],
      ["whatsapp:p2", [inbox("i2a"), inbox("i2b")]],
      ["messenger:p4", [inbox("i4")]],
    ]),
  )
  mocks.findLive.mockResolvedValue(null)
  mocks.findLatestFetchedRun.mockResolvedValue(null)
  mocks.createWithItems.mockImplementation(async (input) => ({
    id: "run-1",
    workspaceId: input.workspaceId,
    chunkSeq: 0,
    items: [],
  }))
  mocks.queueAdd.mockResolvedValue(undefined)
})

describe("contactSyncService.listSources", () => {
  test("reports each source with its inboxes and why it cannot sync", async () => {
    const sources = await contactSyncService.listSources({
      workspaceId: WORKSPACE,
    })

    expect(
      sources.map((source) => [
        source.connectionId,
        source.eligible,
        source.ineligibleReason,
        source.matchedInboxes.length,
      ]),
    ).toEqual([
      ["conn-1", true, null, 1],
      ["conn-2", true, null, 2],
      ["conn-3", false, "channelUnsupported", 0],
      ["conn-4", false, "connectionUnhealthy", 1],
    ])
  })
})

describe("contactSyncService.schedule", () => {
  test("creates the run with one item per source and enqueues its first chunk", async () => {
    await contactSyncService.schedule(
      scheduleInput([
        { connectionId: "conn-1" },
        { connectionId: "conn-2", inboxId: "i2b" },
      ]),
    )

    expect(mocks.execute).toHaveBeenCalledTimes(1)
    expect(mocks.createWithItems).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE,
        provider: "ahachat",
        triggerSource: "app",
        requestedByUserId: "user-1",
        syncTags: true,
        syncCustomFields: false,
        overwriteExisting: false,
        items: [
          {
            integrationId: "int-1",
            inboxId: "i1",
            sourceAccountName: "Page p1",
          },
          {
            integrationId: "int-2",
            inboxId: "i2b",
            sourceAccountName: "Page p2",
          },
        ],
      }),
      expect.anything(),
    )
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "contactSync",
      { type: "contactSync", data: { runId: "run-1", workspaceId: WORKSPACE } },
      expect.objectContaining({ jobId: "contact-sync-run-1-chunk-0" }),
    )
  })

  test.each([
    [[], "contactSyncNoSources"],
    [
      [{ connectionId: "conn-1" }, { connectionId: "conn-1" }],
      "contactSyncDuplicateSource",
    ],
    [[{ connectionId: "conn-9" }], "contactSyncSourceNotFound"],
    [[{ connectionId: "conn-3" }], "contactSyncSourceNotEligible"],
    [[{ connectionId: "conn-4" }], "contactSyncSourceNotEligible"],
    [[{ connectionId: "conn-2" }], "contactSyncInboxRequired"],
    [
      [{ connectionId: "conn-1", inboxId: "i2a" }],
      "contactSyncInboxNotMatched",
    ],
  ])("rejects %j with %s and creates nothing", async (sources, code) => {
    await expect(
      contactSyncService.schedule(scheduleInput(sources)),
    ).rejects.toMatchObject({ code })
    expect(mocks.createWithItems).not.toHaveBeenCalled()
  })

  test("too many sources are refused", async () => {
    const sources = Array.from({ length: 51 }, (_, index) => ({
      connectionId: `conn-${index}`,
    }))
    await expect(
      contactSyncService.schedule(scheduleInput(sources)),
    ).rejects.toMatchObject({ code: "contactSyncTooManySources" })
  })

  test("a live run blocks with 409 and names the run", async () => {
    mocks.findLive.mockResolvedValue({ id: "run-live" })

    await expect(
      contactSyncService.schedule(scheduleInput([{ connectionId: "conn-1" }])),
    ).rejects.toMatchObject({
      code: "contactSyncAlreadyRunning",
      httpStatusCode: 409,
      data: { runId: "run-live" },
    })
    expect(mocks.createWithItems).not.toHaveBeenCalled()
  })

  test("a run within the last 4 hours blocks with the next allowed time", async () => {
    const createdAt = new Date(Date.now() - 60 * 60 * 1000)
    mocks.findLatestFetchedRun.mockResolvedValue({ id: "run-old", createdAt })

    await expect(
      contactSyncService.schedule(scheduleInput([{ connectionId: "conn-1" }])),
    ).rejects.toMatchObject({
      code: "contactSyncCooldown",
      httpStatusCode: 409,
      data: {
        nextSyncAt: new Date(
          createdAt.getTime() + 4 * 60 * 60 * 1000,
        ).toISOString(),
      },
    })
  })

  test("losing the insert race to a concurrent request is reported as running", async () => {
    mocks.createWithItems.mockResolvedValue(null)

    await expect(
      contactSyncService.schedule(scheduleInput([{ connectionId: "conn-1" }])),
    ).rejects.toMatchObject({ code: "contactSyncAlreadyRunning" })
    expect(mocks.queueAdd).not.toHaveBeenCalled()
  })

  test("a failed enqueue keeps the run for the sweeper", async () => {
    mocks.queueAdd.mockRejectedValue(new Error("redis down"))

    await expect(
      contactSyncService.schedule(scheduleInput([{ connectionId: "conn-1" }])),
    ).resolves.toMatchObject({ id: "run-1" })
  })
})

describe("contactSyncService.cancel", () => {
  test("is idempotent: a finished run reports cancelled false", async () => {
    mocks.findForWorkspace.mockResolvedValue({ id: "run-1", items: [] })
    mocks.cancelLive
      .mockResolvedValueOnce({ id: "run-1" })
      .mockResolvedValueOnce(null)

    await expect(
      contactSyncService.cancel({ workspaceId: WORKSPACE, runId: "run-1" }),
    ).resolves.toEqual({ cancelled: true })
    await expect(
      contactSyncService.cancel({ workspaceId: WORKSPACE, runId: "run-1" }),
    ).resolves.toEqual({ cancelled: false })
  })

  test("a run of another workspace is not found", async () => {
    mocks.findForWorkspace.mockResolvedValue(null)

    await expect(
      contactSyncService.cancel({ workspaceId: WORKSPACE, runId: "run-x" }),
    ).rejects.toMatchObject({
      code: "contactSyncRunNotFound",
      httpStatusCode: 404,
    })
    expect(mocks.cancelLive).not.toHaveBeenCalled()
  })
})

describe("contactSyncService.finish", () => {
  test.each([
    ["running", ["succeeded", "succeeded"], "succeeded"],
    ["running", ["succeeded", "failed"], "partial"],
    ["running", ["partial", "failed"], "partial"],
    ["running", ["failed", "failed"], "failed"],
    ["cancelling", ["succeeded", "cancelled"], "cancelled"],
  ])("a %s run with items %j ends %s", async (status, items, outcome) => {
    mocks.listItemStatuses.mockResolvedValue(items)
    mocks.finish.mockResolvedValue(true)

    await contactSyncService.finish({
      run: { id: "run-1", status: status as "running" },
      expect: { claimToken: "t" },
    })

    expect(mocks.finish).toHaveBeenCalledWith({
      runId: "run-1",
      expect: { claimToken: "t" },
      outcome: { status: outcome },
    })
  })
})

describe("contactSyncService.cancelForIntegration", () => {
  test("cancels the live run reading from the disconnected source", async () => {
    mocks.findLiveRunIdForIntegration.mockResolvedValue("run-1")

    await contactSyncService.cancelForIntegration({
      workspaceId: WORKSPACE,
      integrationId: "int-1",
    })

    expect(mocks.cancelLive).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE, runId: "run-1" },
      expect.anything(),
    )
  })

  test("does nothing when no run reads from it", async () => {
    mocks.findLiveRunIdForIntegration.mockResolvedValue(null)

    await contactSyncService.cancelForIntegration({
      workspaceId: WORKSPACE,
      integrationId: "int-1",
    })

    expect(mocks.cancelLive).not.toHaveBeenCalled()
  })
})

describe("contactSyncService sweeper", () => {
  /** The chunk job ids whose state the queue reports, by job id suffix. */
  const queueWith = (states: Record<string, string>) => {
    mocks.getJob.mockImplementation((jobId: string) => {
      const entry = Object.entries(states).find(([suffix]) =>
        jobId.endsWith(suffix),
      )
      const job = entry && { getState: () => Promise.resolve(entry[1]) }
      return Promise.resolve(job)
    })
  }
  const exhausted = (id: string, status = "running") => ({
    id,
    chunkSeq: 7,
    status,
  })

  beforeEach(() => {
    mocks.markMaxAttemptsFailed.mockResolvedValue(0)
  })

  test("a run whose last chunk still waits in the queue is not failed before it runs", async () => {
    mocks.listExhausted.mockResolvedValue([
      exhausted("waiting"),
      exhausted("lost"),
    ])
    queueWith({ "waiting-chunk-7": "waiting" })

    await contactSyncService.markMaxAttemptsFailed()

    expect(mocks.listExhausted).toHaveBeenCalledWith({
      maxAttempts: 2,
      batchSize: 100,
    })
    expect(mocks.markMaxAttemptsFailed).toHaveBeenCalledWith({
      maxAttempts: 2,
      errorCode: "maxAttempts",
      runIds: ["lost"],
    })
  })

  test.each([
    "delayed",
    "prioritized",
    "waiting-children",
    "active",
  ])("a chunk in state %s has not finished: the run waits for it", async (state) => {
    mocks.listExhausted.mockResolvedValue([exhausted("run-1")])
    queueWith({ "run-1-chunk-7": state })

    await contactSyncService.markMaxAttemptsFailed()

    expect(mocks.markMaxAttemptsFailed).toHaveBeenCalledWith(
      expect.objectContaining({ runIds: [] }),
    )
  })

  test.each([
    "completed",
    "failed",
  ])("a chunk that is %s is no reason to wait: the run ends", async (state) => {
    mocks.listExhausted.mockResolvedValue([exhausted("run-1")])
    queueWith({ "run-1-chunk-7": state })

    await contactSyncService.markMaxAttemptsFailed()

    expect(mocks.markMaxAttemptsFailed).toHaveBeenCalledWith(
      expect.objectContaining({ runIds: ["run-1"] }),
    )
  })

  test("a cancelled run is ended even with a chunk queued", async () => {
    mocks.listExhausted.mockResolvedValue([exhausted("run-1", "cancelling")])
    queueWith({ "run-1-chunk-7": "waiting" })

    await contactSyncService.markMaxAttemptsFailed()

    expect(mocks.getJob).not.toHaveBeenCalled()
    expect(mocks.markMaxAttemptsFailed).toHaveBeenCalledWith(
      expect.objectContaining({ runIds: ["run-1"] }),
    )
  })

  test("a run whose job is gone from the queue ends", async () => {
    mocks.listExhausted.mockResolvedValue([exhausted("run-1")])
    queueWith({})

    await contactSyncService.markMaxAttemptsFailed()

    expect(mocks.markMaxAttemptsFailed).toHaveBeenCalledWith(
      expect.objectContaining({ runIds: ["run-1"] }),
    )
  })

  test("a queue that cannot be read ends nothing: the next sweep checks again", async () => {
    mocks.listExhausted.mockResolvedValue([exhausted("run-1")])
    mocks.getJob.mockRejectedValue(new Error("redis down"))

    await contactSyncService.markMaxAttemptsFailed()

    expect(mocks.markMaxAttemptsFailed).toHaveBeenCalledWith(
      expect.objectContaining({ runIds: [] }),
    )
  })

  test("a re-dispatch is refunded while the previous chunk is still queued", async () => {
    queueWith({ "run-1-chunk-6": "waiting" })

    const refunded = await contactSyncService.refundIfPreviousChunkQueued({
      id: "run-1",
      attempts: 2,
      chunkSeq: 7,
      status: "pending",
    })

    expect(refunded).toBe(true)
    expect(mocks.refundDispatch).toHaveBeenCalledWith({
      runId: "run-1",
      attempts: 2,
      chunkSeq: 7,
    })
  })

  test("no refund when the queue cannot be read: the dispatch goes ahead", async () => {
    mocks.getJob.mockRejectedValue(new Error("redis down"))

    const refunded = await contactSyncService.refundIfPreviousChunkQueued({
      id: "run-1",
      attempts: 2,
      chunkSeq: 7,
      status: "pending",
    })

    expect(refunded).toBe(false)
    expect(mocks.refundDispatch).not.toHaveBeenCalled()
  })

  test("no refund when the previous chunk is gone", async () => {
    queueWith({})

    const refunded = await contactSyncService.refundIfPreviousChunkQueued({
      id: "run-1",
      attempts: 2,
      chunkSeq: 7,
      status: "pending",
    })

    expect(refunded).toBe(false)
    expect(mocks.refundDispatch).not.toHaveBeenCalled()
  })
})

describe("contactSyncService.saveMappings", () => {
  test("a source id listed twice is rejected before anything is written", async () => {
    mocks.loadAuth.mockResolvedValue({ authType: "custom" })
    mocks.listSchema.mockResolvedValue({
      tags: [{ id: "12", name: "VIP" }],
      fields: [],
    })

    const error = await contactSyncService
      .saveMappings({
        workspaceId: WORKSPACE,
        connectionId: "conn-1",
        tags: [
          { externalId: "12", target: null },
          { externalId: "12", target: null },
          { externalId: "99", target: null },
        ],
      })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ContactSyncMappingError)
    const mappingError = error as InstanceType<typeof ContactSyncMappingError>
    expect(mappingError.issues).toEqual([
      { kind: "tag", externalId: "12", reason: "duplicateExternalId" },
      { kind: "tag", externalId: "12", reason: "duplicateExternalId" },
      { kind: "tag", externalId: "99", reason: "unknownExternalId" },
    ])
    expect(mappingError.message).toContain("tag 99 (unknownExternalId)")
    expect(mocks.upsertManual).not.toHaveBeenCalled()
  })
})
