import { defineRelationsPart } from "drizzle-orm"
// biome-ignore lint/performance/noNamespaceImport: drizzle schema
import * as schema from "../schema"

export const integrationAhachatRelations = defineRelationsPart(schema, (r) => ({
  integrationAhachatModel: {
    integration: r.one.integrationModel({
      from: r.integrationAhachatModel.integrationId,
      to: r.integrationModel.id,
    }),
    workspace: r.one.workspaceModel({
      from: r.integrationAhachatModel.workspaceId,
      to: r.workspaceModel.id,
    }),
  },
}))
