import {
  and,
  type DatabaseClient,
  db,
  eq,
  inArray,
  or,
  sql,
} from "../../client"
import type { ContactSyncMappingKind } from "../../partials"
import { contactSyncMappingModel } from "../../schema"
import type { ContactSyncMappingModel } from "../../types"

export type UpsertContactSyncMappingInput = {
  kind: ContactSyncMappingKind
  externalId: string
  externalName: string
  tagId: string | null
  customFieldId: string | null
}

/** Rows per insert: seven bind parameters each, far below Postgres' 65,535. */
const MAPPING_WRITE_CHUNK_SIZE = 1000

const MAPPING_CONFLICT_TARGET = [
  contactSyncMappingModel.integrationId,
  contactSyncMappingModel.kind,
  contactSyncMappingModel.externalId,
]

/** The input rows as table rows of one origin, in insert-sized chunks. */
const mappingRowChunks = (
  input: {
    workspaceId: string
    integrationId: string
    rows: UpsertContactSyncMappingInput[]
  },
  origin: ContactSyncMappingModel["origin"],
) => {
  const rows = input.rows.map((row) => ({
    ...row,
    workspaceId: input.workspaceId,
    integrationId: input.integrationId,
    origin,
  }))
  const chunks: (typeof rows)[] = []
  for (
    let offset = 0;
    offset < rows.length;
    offset += MAPPING_WRITE_CHUNK_SIZE
  ) {
    chunks.push(rows.slice(offset, offset + MAPPING_WRITE_CHUNK_SIZE))
  }
  return chunks
}

export const contactSyncMappingRepository = {
  /**
   * The source's mappings of the given source ids only: ids the source no
   * longer lists are never read, so the read stays bounded by its schema
   * however many mappings past runs stored.
   */
  async listForExternalIds(
    input: {
      workspaceId: string
      integrationId: string
      tagIds: string[]
      fieldIds: string[]
    },
    tx: DatabaseClient = db,
  ): Promise<ContactSyncMappingModel[]> {
    const byKind = (kind: ContactSyncMappingKind, externalIds: string[]) =>
      externalIds.length > 0
        ? and(
            eq(contactSyncMappingModel.kind, kind),
            inArray(contactSyncMappingModel.externalId, externalIds),
          )
        : undefined
    const kinds = or(
      byKind("tag", input.tagIds),
      byKind("customField", input.fieldIds),
    )
    if (!kinds) {
      return []
    }
    return await tx
      .select()
      .from(contactSyncMappingModel)
      .where(
        and(
          eq(contactSyncMappingModel.workspaceId, input.workspaceId),
          eq(contactSyncMappingModel.integrationId, input.integrationId),
          kinds,
        ),
      )
  },

  /**
   * The user's choices replace whatever was there for those source ids
   * (manual or auto): a manual mapping always wins.
   */
  async upsertManual(
    input: {
      workspaceId: string
      integrationId: string
      rows: UpsertContactSyncMappingInput[]
    },
    tx: DatabaseClient = db,
  ): Promise<void> {
    for (const chunk of mappingRowChunks(input, "manual")) {
      await tx
        .insert(contactSyncMappingModel)
        .values(chunk)
        .onConflictDoUpdate({
          target: MAPPING_CONFLICT_TARGET,
          set: {
            externalName: sql`excluded."externalName"`,
            tagId: sql`excluded."tagId"`,
            customFieldId: sql`excluded."customFieldId"`,
            origin: sql`excluded."origin"`,
            updatedAt: new Date(),
          },
        })
    }
  },

  /** Removes mappings so those source ids are resolved automatically again. */
  async deleteByExternalIds(
    input: {
      workspaceId: string
      integrationId: string
      kind: ContactSyncMappingKind
      externalIds: string[]
    },
    tx: DatabaseClient = db,
  ): Promise<void> {
    if (input.externalIds.length === 0) {
      return
    }
    await tx
      .delete(contactSyncMappingModel)
      .where(
        and(
          eq(contactSyncMappingModel.workspaceId, input.workspaceId),
          eq(contactSyncMappingModel.integrationId, input.integrationId),
          eq(contactSyncMappingModel.kind, input.kind),
          inArray(contactSyncMappingModel.externalId, input.externalIds),
        ),
      )
  },

  /**
   * Records what a run resolved on its own, never over an existing row (a
   * manual choice or another run's result), then reads back what is stored
   * so every caller converges on the same target.
   */
  async insertAutoAndRead(
    input: {
      workspaceId: string
      integrationId: string
      rows: UpsertContactSyncMappingInput[]
    },
    tx: DatabaseClient = db,
  ): Promise<ContactSyncMappingModel[]> {
    if (input.rows.length === 0) {
      return []
    }
    for (const chunk of mappingRowChunks(input, "auto")) {
      await tx
        .insert(contactSyncMappingModel)
        .values(chunk)
        .onConflictDoNothing({ target: MAPPING_CONFLICT_TARGET })
    }
    const kinds = [...new Set(input.rows.map((row) => row.kind))]
    return await tx
      .select()
      .from(contactSyncMappingModel)
      .where(
        and(
          eq(contactSyncMappingModel.workspaceId, input.workspaceId),
          eq(contactSyncMappingModel.integrationId, input.integrationId),
          inArray(contactSyncMappingModel.kind, kinds),
          inArray(
            contactSyncMappingModel.externalId,
            input.rows.map((row) => row.externalId),
          ),
        ),
      )
  },
}
