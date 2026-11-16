import { defineRelationsPart } from "drizzle-orm"
// biome-ignore lint/performance/noNamespaceImport: drizzle schema
import * as schema from "../schema"

export const contactSyncRelations = defineRelationsPart(schema, (r) => ({
  contactSyncRunModel: {
    workspace: r.one.workspaceModel({
      from: r.contactSyncRunModel.workspaceId,
      to: r.workspaceModel.id,
      optional: false,
    }),
    requestedBy: r.one.userModel({
      from: r.contactSyncRunModel.requestedByUserId,
      to: r.userModel.id,
    }),
    items: r.many.contactSyncRunItemModel({
      from: r.contactSyncRunModel.id,
      to: r.contactSyncRunItemModel.runId,
    }),
  },
  contactSyncRunItemModel: {
    run: r.one.contactSyncRunModel({
      from: r.contactSyncRunItemModel.runId,
      to: r.contactSyncRunModel.id,
      optional: false,
    }),
    integration: r.one.integrationModel({
      from: r.contactSyncRunItemModel.integrationId,
      to: r.integrationModel.id,
    }),
    inbox: r.one.inboxModel({
      from: r.contactSyncRunItemModel.inboxId,
      to: r.inboxModel.id,
    }),
  },
  contactSyncMappingModel: {
    workspace: r.one.workspaceModel({
      from: r.contactSyncMappingModel.workspaceId,
      to: r.workspaceModel.id,
      optional: false,
    }),
    integration: r.one.integrationModel({
      from: r.contactSyncMappingModel.integrationId,
      to: r.integrationModel.id,
      optional: false,
    }),
    tag: r.one.tagModel({
      from: r.contactSyncMappingModel.tagId,
      to: r.tagModel.id,
    }),
    customField: r.one.customFieldModel({
      from: r.contactSyncMappingModel.customFieldId,
      to: r.customFieldModel.id,
    }),
  },
}))
