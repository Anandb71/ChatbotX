// @vitest-environment node

/**
 * Contact sync repositories against a real Postgres: what only the database
 * can prove — the one-live-run partial unique index, the enum `CASE` writes,
 * the claim / fence / cancel transitions, the `UPDATE … FROM (VALUES …)`
 * profile merge, the value upsert modes and the mapping constraints.
 *
 * Every test runs in a transaction that is always rolled back, on an existing
 * inbox's workspace, so nothing is left behind.
 *
 * Skipped unless `DATABASE_URL` points at a reachable database with at least
 * one connected inbox; run it with `pnpm --filter @chatbotx.io/database test:db`.
 */

import { createId } from "@chatbotx.io/utils"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { DatabaseClient } from "../../src/client"
import { relations } from "../../src/relations"
import { contactRepository } from "../../src/repositories/contact/repository"
import { contactCustomFieldRepository } from "../../src/repositories/contact-custom-field/repository"
import { contactSyncMappingRepository as mappings } from "../../src/repositories/contact-sync/mapping-repository"
import { contactSyncRunRepository as runs } from "../../src/repositories/contact-sync/repository"
// biome-ignore lint/performance/noNamespaceImport: mirrors how src/client.ts builds the db
import * as schema from "../../src/schema"
import { realDatabaseUrl } from "./database-url"

const databaseUrl = realDatabaseUrl()

/** Thrown at the end of a fixture transaction so it never commits. */
class RollbackSignal extends Error {}

type Ref = { workspaceId: string; inboxId: string }

describe.skipIf(!databaseUrl)("contact sync repositories on Postgres", () => {
  let client: Client
  let db: ReturnType<typeof drizzle<typeof schema, typeof relations>>
  let page: Ref | null = null

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl ?? undefined })
    await client.connect()
    db = drizzle({ client, schema, relations })
    const [inbox] = (
      await client.query<{ id: string; workspaceId: string }>(
        `SELECT id, "workspaceId" FROM "Inbox" WHERE status = 'connected' LIMIT 1`,
      )
    ).rows
    page = inbox ? { workspaceId: inbox.workspaceId, inboxId: inbox.id } : null
  })

  afterAll(async () => {
    await client.end()
  })

  const inRolledBackTransaction = async (
    fn: (tx: DatabaseClient, ref: Ref) => Promise<void>,
  ) => {
    if (!page) {
      return
    }
    const ref = page
    try {
      await db.transaction(async (tx) => {
        // A live run of the real workspace must not block the fixtures.
        await tx.execute(
          sql`UPDATE "ContactSyncRun" SET status = 'cancelled' WHERE "workspaceId" = ${ref.workspaceId} AND status IN ('pending','running','cancelling')`,
        )
        await fn(tx as unknown as DatabaseClient, ref)
        throw new RollbackSignal()
      })
    } catch (error) {
      if (!(error instanceof RollbackSignal)) {
        throw error
      }
    }
  }

  const createIntegration = async (tx: DatabaseClient, ref: Ref) => {
    const id = createId()
    await tx.execute(
      sql`INSERT INTO "Integration" (id, "workspaceId", "integrationType") VALUES (${id}, ${ref.workspaceId}, 'ahachat')`,
    )
    return id
  }

  const createRun = async (tx: DatabaseClient, ref: Ref) => {
    const integrationId = await createIntegration(tx, ref)
    const run = await runs.createWithItems(
      {
        workspaceId: ref.workspaceId,
        provider: "ahachat",
        triggerSource: "api",
        requestedByUserId: null,
        syncTags: true,
        syncCustomFields: true,
        overwriteExisting: false,
        items: [
          { integrationId, inboxId: ref.inboxId, sourceAccountName: "Page A" },
          { integrationId, inboxId: ref.inboxId, sourceAccountName: "Page B" },
        ],
      },
      tx,
    )
    return { run, integrationId }
  }

  const createContact = async (
    tx: DatabaseClient,
    ref: Ref,
    values: Record<string, string | null> = {},
  ) => {
    const id = createId()
    await tx.insert(schema.contactModel).values({
      id,
      workspaceId: ref.workspaceId,
      ...values,
    })
    return id
  }

  test("a workspace has one live run, with its items in order", async () => {
    await inRolledBackTransaction(async (tx, ref) => {
      const { run } = await createRun(tx, ref)
      expect(run?.status).toBe("pending")
      expect(run?.items.map((item) => item.position)).toEqual([0, 1])
      expect((await createRun(tx, ref)).run).toBeNull()
      expect((await runs.findLive(ref.workspaceId, tx))?.id).toBe(run?.id)
    })
  })

  test("claim, fenced progress, yield and finish", async () => {
    await inRolledBackTransaction(async (tx, ref) => {
      const { run } = await createRun(tx, ref)
      const claimed = await runs.claim(
        { runId: run?.id ?? "", workspaceId: ref.workspaceId },
        tx,
      )
      expect(claimed?.status).toBe("running")
      const expect_ = { claimToken: claimed?.claimToken ?? "" }
      // A second claim while the lease is fresh is refused.
      expect(
        await runs.claim(
          { runId: run?.id ?? "", workspaceId: ref.workspaceId },
          tx,
        ),
      ).toBeNull()

      const item = await runs.findNextItem(run?.id ?? "", tx)
      const started = await runs.startItem(
        {
          runId: run?.id ?? "",
          itemId: item?.id ?? "",
          expect: expect_,
          upperBoundId: "500",
        },
        tx,
      )
      expect(started?.upperBoundId).toBe("500")
      // A resumed item keeps its original snapshot bound.
      const restarted = await runs.startItem(
        {
          runId: run?.id ?? "",
          itemId: item?.id ?? "",
          expect: expect_,
          upperBoundId: "900",
        },
        tx,
      )
      expect(restarted?.upperBoundId).toBe("500")

      const counters = {
        created: 2,
        updated: 1,
        skipped: 0,
        failed: 1,
        skippedValues: 3,
      }
      expect(
        await runs.recordItemProgress(
          {
            runId: run?.id ?? "",
            itemId: item?.id ?? "",
            expect: expect_,
            cursor: "200",
            counters,
          },
          tx,
        ),
      ).toBe("running")
      // A stale token writes nothing.
      expect(
        await runs.recordItemProgress(
          {
            runId: run?.id ?? "",
            itemId: item?.id ?? "",
            expect: { claimToken: "stale" },
            cursor: "999",
            counters,
          },
          tx,
        ),
      ).toBeNull()

      const chunkSeq = await runs.yieldForContinuation(
        { runId: run?.id ?? "", expect: expect_ },
        tx,
      )
      expect(chunkSeq).toBe(1)
      const reclaimed = await runs.claim(
        { runId: run?.id ?? "", workspaceId: ref.workspaceId },
        tx,
      )
      const again = { claimToken: reclaimed?.claimToken ?? "" }
      expect(
        await runs.finishItem(
          {
            runId: run?.id ?? "",
            itemId: item?.id ?? "",
            expect: again,
            status: "succeeded",
          },
          tx,
        ),
      ).toBe(true)
      expect(
        await runs.finish(
          {
            runId: run?.id ?? "",
            expect: again,
            outcome: { status: "partial" },
          },
          tx,
        ),
      ).toBe(true)

      const finished = await runs.findForWorkspace(
        { runId: run?.id ?? "", workspaceId: ref.workspaceId },
        tx,
      )
      expect(finished?.status).toBe("partial")
      expect(finished?.items[0]).toMatchObject({
        status: "succeeded",
        cursor: "200",
        createdCount: 2,
        updatedCount: 1,
        failedCount: 1,
        skippedValueCount: 3,
      })
      // The item never started is closed as cancelled, not left pending.
      expect(finished?.items[1]?.status).toBe("cancelled")
      expect((await runs.findLatestFetchedRun(ref.workspaceId, tx))?.id).toBe(
        run?.id,
      )
    })
  })

  test("cancel ends an unclaimed run at once and winds a claimed one down", async () => {
    await inRolledBackTransaction(async (tx, ref) => {
      const { run } = await createRun(tx, ref)
      const cancelled = await runs.cancelLive(
        { workspaceId: ref.workspaceId, runId: run?.id },
        tx,
      )
      expect(cancelled?.status).toBe("cancelled")
      expect(
        await runs.cancelLive({ workspaceId: ref.workspaceId }, tx),
      ).toBeNull()

      const second = (await createRun(tx, ref)).run
      await runs.claim(
        { runId: second?.id ?? "", workspaceId: ref.workspaceId },
        tx,
      )
      expect(
        (await runs.cancelLive({ workspaceId: ref.workspaceId }, tx))?.status,
      ).toBe("cancelling")
    })
  })

  /** Claims the run and starts its first item; returns the guard and ids. */
  const claimAndStart = async (tx: DatabaseClient, ref: Ref) => {
    const { run } = await createRun(tx, ref)
    const runId = run?.id ?? ""
    const claimed = await runs.claim(
      { runId, workspaceId: ref.workspaceId },
      tx,
    )
    const guard = { claimToken: claimed?.claimToken ?? "" }
    const item = await runs.findNextItem(runId, tx)
    const itemId = item?.id ?? ""
    await runs.startItem(
      { runId, itemId, expect: guard, upperBoundId: "500" },
      tx,
    )
    return { runId, itemId, guard }
  }

  const pageCounters = {
    created: 5,
    updated: 2,
    skipped: 1,
    failed: 0,
    skippedValues: 4,
  }

  test("a page finishing after a cancel keeps its data but adds no counters or cursor", async () => {
    await inRolledBackTransaction(async (tx, ref) => {
      const { runId, itemId, guard } = await claimAndStart(tx, ref)
      expect(
        (await runs.cancelLive({ workspaceId: ref.workspaceId, runId }, tx))
          ?.status,
      ).toBe("cancelling")

      expect(
        await runs.recordItemProgress(
          {
            runId,
            itemId,
            expect: guard,
            cursor: "200",
            counters: pageCounters,
          },
          tx,
        ),
      ).toBe("cancelling")

      const row = await runs.findForWorkspace(
        { runId, workspaceId: ref.workspaceId },
        tx,
      )
      expect(row?.items[0]).toMatchObject({
        cursor: null,
        createdCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        skippedValueCount: 0,
      })
    })
  })

  test("a cancel accepted after the worker settled its outcome still ends the run cancelled", async () => {
    await inRolledBackTransaction(async (tx, ref) => {
      const { runId, guard } = await claimAndStart(tx, ref)
      // The worker read its items as all succeeded, then the cancel landed.
      await runs.cancelLive({ workspaceId: ref.workspaceId, runId }, tx)

      const finished = await runs.finish(
        { runId, expect: guard, outcome: { status: "succeeded" } },
        tx,
      )

      expect(finished).toBe(true)
      const run = await runs.findForWorkspace(
        { runId, workspaceId: ref.workspaceId },
        tx,
      )
      expect(run?.status).toBe("cancelled")
      expect(run?.claimToken).toBeNull()
    })
  })

  test("several values for one contact field write only the first, also when overwriting", async () => {
    await inRolledBackTransaction(async (tx, ref) => {
      const contactId = await createContact(tx, ref)
      const customFieldId = createId()
      await tx.insert(schema.customFieldModel).values({
        id: customFieldId,
        workspaceId: ref.workspaceId,
        name: `sync-test-${customFieldId}`,
        type: "shortText",
      })
      const entries = [
        { contactId, customFieldId, value: "first" },
        { contactId, customFieldId, value: "second" },
      ]

      for (const mode of ["fill", "overwrite"] as const) {
        expect(
          await contactCustomFieldRepository.bulkUpsertValues(
            { workspaceId: ref.workspaceId, mode, entries },
            tx,
          ),
        ).toEqual({ dropped: 1 })
      }
      const rows = await tx
        .select({ value: schema.contactCustomFieldModel.value })
        .from(schema.contactCustomFieldModel)
        .where(sql`"contactId" = ${contactId}`)
      expect(rows).toEqual([{ value: "first" }])
    })
  })

  test("a page larger than one insert statement can bind is written in chunks", async () => {
    await inRolledBackTransaction(async (tx, ref) => {
      const contactIds: string[] = []
      for (let index = 0; index < 200; index++) {
        contactIds.push(await createContact(tx, ref))
      }
      const tagIds = Array.from({ length: 170 }, () => createId())
      await tx.insert(schema.tagModel).values(
        tagIds.map((id) => ({
          id,
          workspaceId: ref.workspaceId,
          name: `sync-test-${id}`,
        })),
      )
      const fieldIds = Array.from({ length: 100 }, () => createId())
      await tx.insert(schema.customFieldModel).values(
        fieldIds.map((id) => ({
          id,
          workspaceId: ref.workspaceId,
          name: `sync-test-${id}`,
          type: "shortText" as const,
        })),
      )

      // 34,000 tag pairs and 20,000 values: one statement would need more
      // bind parameters than Postgres allows (65,535).
      const linked = await contactRepository.linkTags(
        {
          workspaceId: ref.workspaceId,
          pairs: contactIds.flatMap((contactId) =>
            tagIds.map((tagId) => ({ contactId, tagId })),
          ),
        },
        tx,
      )
      const written = await contactCustomFieldRepository.bulkUpsertValues(
        {
          workspaceId: ref.workspaceId,
          mode: "overwrite",
          entries: contactIds.flatMap((contactId) =>
            fieldIds.map((customFieldId) => ({
              contactId,
              customFieldId,
              value: "v",
            })),
          ),
        },
        tx,
      )

      expect(linked).toBe(34_000)
      expect(written).toEqual({ dropped: 0 })
      const [{ count }] = (
        await tx.execute<{ count: string }>(
          sql`SELECT count(*) AS count FROM "ContactCustomField" WHERE "contactId" IN (${sql.join(
            contactIds.map((id) => sql`${id}::int8`),
            sql`, `,
          )})`,
        )
      ).rows as [{ count: string }]
      expect(Number(count)).toBe(20_000)
    })
  })

  test("10,000 mappings are saved in chunks, manual and auto alike", async () => {
    await inRolledBackTransaction(async (tx, ref) => {
      const integrationId = await createIntegration(tx, ref)
      const tagIds = Array.from({ length: 5000 }, () => createId())
      const fieldIds = Array.from({ length: 5000 }, () => createId())
      for (let offset = 0; offset < 5000; offset += 1000) {
        await tx.insert(schema.tagModel).values(
          tagIds.slice(offset, offset + 1000).map((id) => ({
            id,
            workspaceId: ref.workspaceId,
            name: `sync-test-${id}`,
          })),
        )
        await tx.insert(schema.customFieldModel).values(
          fieldIds.slice(offset, offset + 1000).map((id) => ({
            id,
            workspaceId: ref.workspaceId,
            name: `sync-test-${id}`,
            type: "shortText" as const,
          })),
        )
      }
      const rows = [
        ...tagIds.map((tagId, index) => ({
          kind: "tag" as const,
          externalId: `t${index}`,
          externalName: `Tag ${index}`,
          tagId,
          customFieldId: null,
        })),
        ...fieldIds.map((customFieldId, index) => ({
          kind: "customField" as const,
          externalId: `f${index}`,
          externalName: `Field ${index}`,
          tagId: null,
          customFieldId,
        })),
      ]
      const scope = { workspaceId: ref.workspaceId, integrationId }

      // One statement would bind ~70,000 parameters, over Postgres' 65,535.
      await mappings.upsertManual({ ...scope, rows }, tx)
      const readBack = await mappings.insertAutoAndRead({ ...scope, rows }, tx)

      expect(readBack).toHaveLength(10_000)
      expect(readBack.every((row) => row.origin === "manual")).toBe(true)

      // A read is bounded by the ids asked for, per kind.
      const listed = await mappings.listForExternalIds(
        { ...scope, tagIds: ["t0", "t1", "f0"], fieldIds: ["f2"] },
        tx,
      )
      expect(
        listed.map((row) => `${row.kind}:${row.externalId}`).sort(),
      ).toEqual(["customField:f2", "tag:t0", "tag:t1"])
      expect(
        await mappings.listForExternalIds(
          { ...scope, tagIds: [], fieldIds: [] },
          tx,
        ),
      ).toEqual([])
    })
  })

  test("a stale lease is taken over and the old holder can no longer write", async () => {
    await inRolledBackTransaction(async (tx, ref) => {
      const { runId, itemId, guard } = await claimAndStart(tx, ref)
      await tx.execute(
        sql`UPDATE "ContactSyncRun" SET "lastHeartbeatAt" = NOW() - INTERVAL '20 minutes' WHERE id = ${runId}`,
      )

      const takeover = await runs.claim(
        { runId, workspaceId: ref.workspaceId },
        tx,
      )
      expect(takeover?.claimToken).toBeTruthy()
      expect(takeover?.claimToken).not.toBe(guard.claimToken)
      expect(
        await runs.recordItemProgress(
          {
            runId,
            itemId,
            expect: guard,
            cursor: "200",
            counters: pageCounters,
          },
          tx,
        ),
      ).toBeNull()
      expect(
        await runs.recordItemProgress(
          {
            runId,
            itemId,
            expect: { claimToken: takeover?.claimToken ?? "" },
            cursor: "200",
            counters: pageCounters,
          },
          tx,
        ),
      ).toBe("running")
    })
  })

  test("a run out of attempts and untouched for a lease ends failed with its items closed", async () => {
    await inRolledBackTransaction(async (tx, ref) => {
      const { runId } = await claimAndStart(tx, ref)
      await tx.execute(
        sql`UPDATE "ContactSyncRun" SET attempts = 5, "lastHeartbeatAt" = NOW() - INTERVAL '20 minutes', "updatedAt" = NOW() - INTERVAL '20 minutes' WHERE id = ${runId}`,
      )

      // A batch bounds the sweep: an empty one ends nothing, the next one does.
      expect(
        await runs.markMaxAttemptsFailed(
          { maxAttempts: 5, errorCode: "maxAttempts", batchSize: 0 },
          tx,
        ),
      ).toBe(0)
      expect((await runs.findLive(ref.workspaceId, tx))?.id).toBe(runId)
      expect(
        await runs.markMaxAttemptsFailed(
          { maxAttempts: 5, errorCode: "maxAttempts", batchSize: 100 },
          tx,
        ),
      ).toBe(1)

      const row = await runs.findForWorkspace(
        { runId, workspaceId: ref.workspaceId },
        tx,
      )
      expect(row).toMatchObject({
        status: "failed",
        currentError: "maxAttempts",
        claimToken: null,
      })
      expect(
        row?.items.every((item) =>
          ["failed", "cancelled", "partial", "succeeded"].includes(item.status),
        ),
      ).toBe(true)
      expect(await runs.findLive(ref.workspaceId, tx)).toBeNull()
    })
  })

  test("the sweeper picks a stale pending run and burns an attempt", async () => {
    await inRolledBackTransaction(async (tx, ref) => {
      const { run } = await createRun(tx, ref)
      await tx.execute(
        sql`UPDATE "ContactSyncRun" SET "updatedAt" = NOW() - INTERVAL '5 minutes' WHERE id = ${run?.id}`,
      )
      const picked = await runs.pickDue({ maxAttempts: 5, batchSize: 100 }, tx)
      const mine = picked.find((row) => row.id === run?.id)
      expect(mine).toMatchObject({
        attempts: 1,
        chunkSeq: 1,
        status: "pending",
      })
    })
  })

  test("a disconnected source finds the live run reading from it", async () => {
    await inRolledBackTransaction(async (tx, ref) => {
      const { run, integrationId } = await createRun(tx, ref)
      expect(
        await runs.findLiveRunIdForIntegration(
          { workspaceId: ref.workspaceId, integrationId },
          tx,
        ),
      ).toBe(run?.id)
    })
  })

  test("mergeProfiles fills only empty columns, overwrite replaces, nothing is cleared", async () => {
    await inRolledBackTransaction(async (tx, ref) => {
      const id = await createContact(tx, ref, {
        firstName: "Keep",
        lastName: "",
        city: null,
      })
      const patch = {
        firstName: "Source",
        lastName: "Nguyen",
        gender: "male" as const,
        location: { latitude: 10.8, longitude: 106.7 },
      }

      const filled = await contactRepository.mergeProfiles(
        {
          workspaceId: ref.workspaceId,
          mode: "fill",
          rows: [{ contactId: id, patch }],
        },
        tx,
      )
      expect(filled).toEqual([id])
      let [row] = await tx
        .select()
        .from(schema.contactModel)
        .where(sql`id = ${id}`)
      expect(row).toMatchObject({
        firstName: "Keep",
        lastName: "Nguyen",
        gender: "male",
        city: null,
        location: { latitude: 10.8, longitude: 106.7 },
      })

      // Same input again changes nothing.
      expect(
        await contactRepository.mergeProfiles(
          {
            workspaceId: ref.workspaceId,
            mode: "fill",
            rows: [{ contactId: id, patch }],
          },
          tx,
        ),
      ).toEqual([])

      await contactRepository.mergeProfiles(
        {
          workspaceId: ref.workspaceId,
          mode: "overwrite",
          rows: [{ contactId: id, patch: { firstName: "Source" } }],
        },
        tx,
      )
      ;[row] = await tx
        .select()
        .from(schema.contactModel)
        .where(sql`id = ${id}`)
      expect(row).toMatchObject({ firstName: "Source", lastName: "Nguyen" })
    })
  })

  test("mergeProfiles never touches a contact of another workspace", async () => {
    await inRolledBackTransaction(async (tx, ref) => {
      const id = await createContact(tx, ref, { firstName: null })
      expect(
        await contactRepository.mergeProfiles(
          {
            workspaceId: "1",
            mode: "overwrite",
            rows: [{ contactId: id, patch: { firstName: "X" } }],
          },
          tx,
        ),
      ).toEqual([])
    })
  })

  test("value upserts: fill keeps existing values, overwrite replaces them", async () => {
    await inRolledBackTransaction(async (tx, ref) => {
      const contactId = await createContact(tx, ref)
      const customFieldId = createId()
      await tx.insert(schema.customFieldModel).values({
        id: customFieldId,
        workspaceId: ref.workspaceId,
        name: `sync-test-${customFieldId}`,
        type: "shortText",
      })
      const write = (mode: "fill" | "overwrite", value: string) =>
        contactCustomFieldRepository.bulkUpsertValues(
          {
            workspaceId: ref.workspaceId,
            mode,
            entries: [{ contactId, customFieldId, value }],
          },
          tx,
        )
      const read = async () =>
        (
          await tx
            .select({ value: schema.contactCustomFieldModel.value })
            .from(schema.contactCustomFieldModel)
            .where(
              sql`"contactId" = ${contactId} AND "customFieldId" = ${customFieldId}`,
            )
        ).map((row) => row.value)

      await write("fill", "first")
      await write("fill", "second")
      expect(await read()).toEqual(["first"])
      await write("overwrite", "third")
      expect(await read()).toEqual(["third"])
    })
  })

  test("tag links are idempotent", async () => {
    await inRolledBackTransaction(async (tx, ref) => {
      const contactId = await createContact(tx, ref)
      const tagId = createId()
      await tx.insert(schema.tagModel).values({
        id: tagId,
        workspaceId: ref.workspaceId,
        name: `sync-test-${tagId}`,
      })
      const link = (id: string) =>
        contactRepository.linkTags(
          {
            workspaceId: ref.workspaceId,
            pairs: [{ contactId, tagId: id }],
          },
          tx,
        )
      expect(await link(tagId)).toBe(1)
      expect(await link(tagId)).toBe(0)

      // A tag deleted while the page imports gets no stale link.
      const deletedTagId = createId()
      await tx.insert(schema.tagModel).values({
        id: deletedTagId,
        workspaceId: ref.workspaceId,
        name: `sync-test-${deletedTagId}`,
        deletedAt: new Date(),
      })
      expect(await link(deletedTagId)).toBe(0)
    })
  })

  test("values of a deleted field or another workspace's field are dropped, not failed", async () => {
    await inRolledBackTransaction(async (tx, ref) => {
      const contactId = await createContact(tx, ref)
      const liveFieldId = createId()
      await tx.insert(schema.customFieldModel).values({
        id: liveFieldId,
        workspaceId: ref.workspaceId,
        name: `sync-test-${liveFieldId}`,
        type: "shortText",
      })
      const [other] = (
        await tx.execute<{ id: string }>(
          sql`SELECT id FROM "Workspace" WHERE id <> ${ref.workspaceId} LIMIT 1`,
        )
      ).rows
      const foreignFieldId = createId()
      if (other) {
        await tx.insert(schema.customFieldModel).values({
          id: foreignFieldId,
          workspaceId: other.id,
          name: `sync-test-${foreignFieldId}`,
          type: "shortText",
        })
      }

      const result = await contactCustomFieldRepository.bulkUpsertValues(
        {
          workspaceId: ref.workspaceId,
          mode: "fill",
          entries: [
            { contactId, customFieldId: liveFieldId, value: "kept" },
            // Never existed (or was just deleted): no foreign-key failure.
            { contactId, customFieldId: createId(), value: "gone" },
            { contactId, customFieldId: foreignFieldId, value: "foreign" },
          ],
        },
        tx,
      )

      expect(result).toEqual({ dropped: 2 })
      const rows = await tx
        .select({ customFieldId: schema.contactCustomFieldModel.customFieldId })
        .from(schema.contactCustomFieldModel)
        .where(sql`"contactId" = ${contactId}`)
      expect(rows).toEqual([{ customFieldId: liveFieldId }])
    })
  })

  test("a contact, tag or field deleted by a concurrent transaction is skipped once it commits, never failing the write", async () => {
    if (!page) {
      return
    }
    const ref = page
    const other = new Client({ connectionString: databaseUrl ?? undefined })
    await other.connect()
    const committed = db as unknown as DatabaseClient
    const keptContact = await createContact(committed, ref)
    const goneContact = await createContact(committed, ref)
    const [keptTag, goneTag, keptField, goneField] = [
      createId(),
      createId(),
      createId(),
      createId(),
    ]
    await db.insert(schema.tagModel).values(
      [keptTag, goneTag].map((id) => ({
        id,
        workspaceId: ref.workspaceId,
        name: `sync-test-${id}`,
      })),
    )
    await db.insert(schema.customFieldModel).values(
      [keptField, goneField].map((id) => ({
        id,
        workspaceId: ref.workspaceId,
        name: `sync-test-${id}`,
        type: "shortText" as const,
      })),
    )
    // The other transaction deletes first and holds its row locks; the write
    // must wait for it, then skip what it deleted.
    const raceWith = async <Result>(
      deletes: { text: string; values: string[] }[],
      write: () => Promise<Result>,
    ): Promise<Result> => {
      await other.query("BEGIN")
      for (const statement of deletes) {
        await other.query(statement.text, statement.values)
      }
      let settled = false
      const pending = write().finally(() => {
        settled = true
      })
      // Poll (a condition, not a sleep the outcome depends on) until Postgres
      // reports a session blocked by the deleter: the write reached its lock.
      const deleterPid = (
        await other.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]?.pid
      let blocked = false
      for (let attempt = 0; attempt < 200 && !blocked && !settled; attempt++) {
        const waiting = await client.query<{ waiting: number }>(
          "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
          [deleterPid],
        )
        blocked = (waiting.rows[0]?.waiting ?? 0) > 0
        if (!blocked) {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
      }
      expect(settled).toBe(false)
      expect(blocked).toBe(true)
      await other.query("COMMIT")
      return await pending
    }
    const contactIds = [keptContact, goneContact]
    try {
      // Each race deletes one kind of row, so each lock is proven on its own.
      const linkTagsTo = (pairs: { contactId: string; tagId: string }[]) =>
        contactRepository.linkTags({ workspaceId: ref.workspaceId, pairs })
      const linkedPastTagDelete = await raceWith(
        [
          {
            text: `UPDATE "Tag" SET "deletedAt" = now() WHERE id = $1`,
            values: [goneTag],
          },
        ],
        () =>
          linkTagsTo([
            { contactId: keptContact, tagId: keptTag },
            { contactId: keptContact, tagId: goneTag },
          ]),
      )
      expect(linkedPastTagDelete).toBe(1)
      const linkedPastContactDelete = await raceWith(
        [
          {
            text: `DELETE FROM "Contact" WHERE id = $1`,
            values: [goneContact],
          },
        ],
        () => linkTagsTo([{ contactId: goneContact, tagId: keptTag }]),
      )
      expect(linkedPastContactDelete).toBe(0)

      const goneContact2 = await createContact(committed, ref)
      contactIds.push(goneContact2)
      const valuesPastContactDelete = await raceWith(
        [
          {
            text: `DELETE FROM "Contact" WHERE id = $1`,
            values: [goneContact2],
          },
        ],
        () =>
          contactCustomFieldRepository.bulkUpsertValues({
            workspaceId: ref.workspaceId,
            mode: "fill",
            entries: [
              { contactId: goneContact2, customFieldId: keptField, value: "c" },
            ],
          }),
      )
      // A deleted contact's values are dropped silently, not reported.
      expect(valuesPastContactDelete).toEqual({ dropped: 0 })
      const written = await raceWith(
        [
          {
            text: `DELETE FROM "CustomField" WHERE id = $1`,
            values: [goneField],
          },
        ],
        () =>
          contactCustomFieldRepository.bulkUpsertValues({
            workspaceId: ref.workspaceId,
            mode: "fill",
            entries: [
              { contactId: keptContact, customFieldId: keptField, value: "a" },
              { contactId: keptContact, customFieldId: goneField, value: "b" },
            ],
          }),
      )
      // A deleted field's value is reported as dropped.
      expect(written).toEqual({ dropped: 1 })

      const tags = await client.query(
        `SELECT "contactId", "tagId" FROM "ContactToTag" WHERE "tagId" = ANY($1::int8[])`,
        [[keptTag, goneTag]],
      )
      expect(tags.rows).toEqual([{ contactId: keptContact, tagId: keptTag }])
      const values = await client.query(
        `SELECT "contactId", "customFieldId" FROM "ContactCustomField" WHERE "customFieldId" = ANY($1::int8[])`,
        [[keptField, goneField]],
      )
      expect(values.rows).toEqual([
        { contactId: keptContact, customFieldId: keptField },
      ])
    } finally {
      await other.query("ROLLBACK").catch(() => null)
      await other.end()
      await client.query(`DELETE FROM "Contact" WHERE id = ANY($1::int8[])`, [
        contactIds,
      ])
      await client.query(`DELETE FROM "Tag" WHERE id = ANY($1::int8[])`, [
        [keptTag, goneTag],
      ])
      await client.query(
        `DELETE FROM "CustomField" WHERE id = ANY($1::int8[])`,
        [[keptField, goneField]],
      )
    }
  })

  test("two concurrent requests for a workspace without a live run create exactly one", async () => {
    if (!page) {
      return
    }
    const ref = page
    const live = await client.query(
      `SELECT 1 FROM "ContactSyncRun" WHERE "workspaceId" = $1 AND status IN ('pending','running','cancelling')`,
      [ref.workspaceId],
    )
    if ((live.rowCount ?? 0) > 0) {
      return
    }
    const other = new Client({ connectionString: databaseUrl ?? undefined })
    await other.connect()
    const otherDb = drizzle({ client: other, schema, relations })
    const integrationId = createId()
    await client.query(
      `INSERT INTO "Integration" (id, "workspaceId", "integrationType") VALUES ($1, $2, 'ahachat')`,
      [integrationId, ref.workspaceId],
    )
    const input = {
      workspaceId: ref.workspaceId,
      provider: "ahachat" as const,
      triggerSource: "api" as const,
      requestedByUserId: null,
      syncTags: true,
      syncCustomFields: true,
      overwriteExisting: false,
      items: [
        { integrationId, inboxId: ref.inboxId, sourceAccountName: "Page A" },
      ],
    }
    let second: Promise<unknown> = Promise.resolve(null)
    try {
      const first = await db.transaction(async (tx) => {
        const created = await runs.createWithItems(
          input,
          tx as unknown as DatabaseClient,
        )
        // The second request blocks on the live-run index until this commits.
        second = runs.createWithItems(
          input,
          otherDb as unknown as DatabaseClient,
        )
        await new Promise((resolve) => setTimeout(resolve, 300))
        return created
      })
      expect(first?.status).toBe("pending")
      expect(await second).toBeNull()
    } finally {
      await second.catch(() => null)
      await client.query(
        `DELETE FROM "ContactSyncRun" WHERE "workspaceId" = $1 AND id IN (SELECT "runId" FROM "ContactSyncRunItem" WHERE "integrationId" = $2)`,
        [ref.workspaceId, integrationId],
      )
      await client.query(`DELETE FROM "Integration" WHERE id = $1`, [
        integrationId,
      ])
      await other.end()
    }
  })

  test("an auto mapping never replaces a manual one, and the target must match the kind", async () => {
    await inRolledBackTransaction(async (tx, ref) => {
      const integrationId = await createIntegration(tx, ref)
      const manualTag = createId()
      const autoTag = createId()
      for (const id of [manualTag, autoTag]) {
        await tx.insert(schema.tagModel).values({
          id,
          workspaceId: ref.workspaceId,
          name: `sync-test-${id}`,
        })
      }
      const scope = { workspaceId: ref.workspaceId, integrationId }
      const row = (tagId: string) => ({
        kind: "tag" as const,
        externalId: "12",
        externalName: "VIP",
        tagId,
        customFieldId: null,
      })
      await mappings.upsertManual({ ...scope, rows: [row(manualTag)] }, tx)
      const stored = await mappings.insertAutoAndRead(
        { ...scope, rows: [row(autoTag)] },
        tx,
      )
      expect(stored).toEqual([
        expect.objectContaining({ tagId: manualTag, origin: "manual" }),
      ])

      await expect(
        tx.execute(sql`SAVEPOINT bad_mapping`).then(() =>
          tx.insert(schema.contactSyncMappingModel).values({
            ...scope,
            kind: "customField",
            externalId: "13",
            externalName: "x",
            tagId: manualTag,
            customFieldId: null,
            origin: "manual",
          }),
        ),
      ).rejects.toThrow()
      await tx.execute(sql`ROLLBACK TO SAVEPOINT bad_mapping`)
    })
  })
})
