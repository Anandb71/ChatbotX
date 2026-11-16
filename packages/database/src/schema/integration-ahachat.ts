import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import type { CredentialEncrypted } from "../partials/credential"
import {
  type AhachatChannel,
  ahachatChannels,
} from "../partials/integration-ahachat"
import { bigintAsString, sharedColumns } from "../partials/shared"
import { integrationModel } from "./integration-base"
import { workspaceModel } from "./workspace"

export const ahachatChannelEnum = pgEnum(
  "ahachatChannel",
  ahachatChannels.options as [AhachatChannel, ...AhachatChannel[]],
)

/**
 * One AhaChat page connected with its broadcast API token; a workspace may
 * connect several (one row per token). `encryptedAuth` holds the token
 * encrypted with `ahachat:{workspaceId}` as AAD and is never sent to a client.
 * The `source*` columns are a display snapshot of the page taken on connect.
 */
export const integrationAhachatModel = pgTable(
  "IntegrationAhachat",
  {
    ...sharedColumns,
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    integrationId: bigintAsString()
      .notNull()
      .references(() => integrationModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    encryptedAuth: jsonb().$type<CredentialEncrypted>().notNull(),
    sourceChannel: ahachatChannelEnum().notNull(),
    sourceAccountId: text().notNull(),
    sourceAccountName: text(),
    sourceAvatarUrl: text(),
  },
  (table) => [
    uniqueIndex("IntegrationAhachat_integrationId_key").on(table.integrationId),
    index("IntegrationAhachat_workspaceId_idx").on(table.workspaceId),
  ],
)
