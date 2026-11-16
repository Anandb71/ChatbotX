import {
  contactSyncMappingOrigins,
  contactSyncProviders,
  contactSyncRunItemStatuses,
  contactSyncRunStatuses,
  customFieldTypes,
} from "@chatbotx.io/database/partials"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { channelTypes } from "@chatbotx.io/utils/channel"
import { z } from "zod"
import { publicListRequest, publicListResponse } from "@/lib/public-api/list"

const connectionIdParam = zodBigintAsString().describe(
  "Connection id of the source (an AhaChat token connected with `connections.create`, provider `ahachat`). Get it from `contactSyncs.listSources`.",
)

const externalFieldType = z.enum([
  "text",
  "number",
  "date",
  "datetime",
  "boolean",
  "json",
  "array",
])

const matchedInbox = z.object({
  id: zodBigintAsString(),
  name: z.string(),
  channel: channelTypes,
})

export const contactSyncSourceResource = z.object({
  connectionId: zodBigintAsString(),
  provider: contactSyncProviders,
  connectionStatus: z.string(),
  account: z.object({
    accountId: z.string().describe("The page / account id on the source."),
    channel: channelTypes
      .nullable()
      .describe("Channel its contacts import into; `null` = unsupported."),
    name: z.string().nullable(),
    avatarUrl: z.string().nullable(),
  }),
  matchedInboxes: z
    .array(matchedInbox)
    .describe(
      "Connected inboxes this source can import into. Several (WhatsApp: one business account, several numbers) means `contactSyncs.create` needs `inboxId`.",
    ),
  eligible: z.boolean(),
  ineligibleReason: z
    .enum(["channelUnsupported", "noMatchingInbox", "connectionUnhealthy"])
    .nullable(),
})

export const listContactSyncSourcesPublicRequest = z.object({
  provider: contactSyncProviders
    .optional()
    .describe("Only sources of this provider; every provider when omitted."),
})
export const listContactSyncSourcesPublicResponse = z.object({
  data: z.array(contactSyncSourceResource),
})

export const getContactSyncSchemaPublicRequest = z.object({
  connectionId: connectionIdParam,
})
export const getContactSyncSchemaPublicResponse = z.object({
  tags: z.array(
    z.object({
      id: z.string().describe("Tag id on the source."),
      name: z.string(),
      mapping: z
        .object({
          tagId: zodBigintAsString(),
          tagName: z.string().nullable(),
          origin: contactSyncMappingOrigins,
        })
        .nullable()
        .describe(
          "Workspace tag it lands on; `null` = matched by name (created when missing) at sync time.",
        ),
    }),
  ),
  fields: z.array(
    z.object({
      id: z.string().describe("Custom field id on the source."),
      name: z.string(),
      type: externalFieldType,
      defaultTargetType: customFieldTypes,
      compatibleTargetTypes: z.array(customFieldTypes),
      mapping: z
        .object({
          customFieldId: zodBigintAsString(),
          customFieldName: z.string().nullable(),
          customFieldType: customFieldTypes,
          origin: contactSyncMappingOrigins,
          typeMismatch: z
            .boolean()
            .describe(
              "`true` = values of this field are skipped at sync time.",
            ),
        })
        .nullable()
        .describe(
          "Workspace field it lands on; `null` = same name and type reused at sync time, or `<name> copy` created when the name is taken by another type.",
        ),
    }),
  ),
})

export const saveContactSyncMappingsPublicRequest = z.object({
  connectionId: connectionIdParam,
  tags: z
    .array(
      z.object({
        externalId: z
          .string()
          .describe("Tag id on the source (`contactSyncs.getSchema`)."),
        target: z
          .union([
            z.object({ tagId: zodBigintAsString() }),
            z.object({
              tagName: z
                .string()
                .min(1)
                .describe("Exact (case-sensitive) name of an existing tag."),
            }),
          ])
          .nullable()
          .describe(
            "Workspace tag by id or exact name; `null` removes the mapping.",
          ),
      }),
    )
    .optional()
    .describe("Tag mappings to set; tags not listed keep their mapping."),
  fields: z
    .array(
      z.object({
        externalId: z
          .string()
          .describe("Field id on the source (`contactSyncs.getSchema`)."),
        target: z
          .union([
            z.object({ customFieldId: zodBigintAsString() }),
            z.object({
              customFieldName: z.string().min(1),
              customFieldType: customFieldTypes.describe(
                "Required with a name: the same name can exist once per type.",
              ),
            }),
          ])
          .nullable()
          .describe(
            "Workspace field by id, or by exact name plus type; must be one of `compatibleTargetTypes`. `null` removes the mapping.",
          ),
      }),
    )
    .optional()
    .describe("Field mappings to set; fields not listed keep their mapping."),
})

export const createContactSyncPublicRequest = z.object({
  sources: z
    .array(
      z.object({
        connectionId: connectionIdParam,
        inboxId: zodBigintAsString()
          .optional()
          .describe(
            "Needed only when the source matches several inboxes (`matchedInboxes`).",
          ),
      }),
    )
    .min(1)
    .describe("Sources to import, processed one after the other."),
  syncTags: z
    .boolean()
    .default(true)
    .describe("Attach the source tags to the contacts (tags are only added)."),
  syncCustomFields: z
    .boolean()
    .default(true)
    .describe(
      "Copy the source custom-field values, through `contactSyncs.saveMappings` mappings.",
    ),
  overwriteExisting: z
    .boolean()
    .default(false)
    .describe(
      "`false`: an existing contact only gets values it is missing. `true`: source values replace existing ones. An empty source value never clears data; tags are only ever added.",
    ),
})
export const createContactSyncPublicResponse = z.object({
  runId: zodBigintAsString(),
})

export const contactSyncRunItemResource = z.object({
  id: zodBigintAsString(),
  position: z.number().int(),
  integrationId: zodBigintAsString().nullable(),
  inboxId: zodBigintAsString().nullable(),
  sourceAccountName: z.string().nullable(),
  status: contactSyncRunItemStatuses,
  createdCount: z.number().int(),
  updatedCount: z.number().int(),
  skippedCount: z.number().int(),
  failedCount: z.number().int(),
  skippedValueCount: z
    .number()
    .int()
    .describe(
      "Custom-field values not written: mapped to an incompatible type, or invalid for the target type.",
    ),
  currentError: z.string().nullable(),
  startedAt: z.date().nullable(),
  finishedAt: z.date().nullable(),
})

/** No `workspaceId`: `public-spec-operations.test.ts` fails a public response carrying one. */
export const contactSyncRunResource = z.object({
  id: zodBigintAsString(),
  provider: contactSyncProviders,
  status: contactSyncRunStatuses,
  syncTags: z.boolean(),
  syncCustomFields: z.boolean(),
  overwriteExisting: z.boolean(),
  requestedByUserId: zodBigintAsString().nullable(),
  currentError: z.string().nullable(),
  createdAt: z.date(),
  startedAt: z.date().nullable(),
  finishedAt: z.date().nullable(),
  items: z.array(contactSyncRunItemResource),
})

export const contactSyncRunIdRequest = z.object({
  runId: zodBigintAsString().describe(
    "Run id returned by `contactSyncs.create` or listed by `contactSyncs.list`.",
  ),
})

export const cancelContactSyncPublicResponse = z.object({
  cancelled: z
    .boolean()
    .describe("`false` when the run had already finished (not an error)."),
})

export const contactSyncAvailabilityResponse = z.object({
  canSync: z.boolean(),
  blockedReason: z.enum(["running", "cooldown"]).nullable(),
  nextSyncAt: z
    .date()
    .nullable()
    .describe("When a new sync may start (4 hours after the last one)."),
  activeRunId: zodBigintAsString().nullable(),
})

export const listContactSyncsPublicRequest = publicListRequest
export const listContactSyncsPublicResponse = publicListResponse(
  contactSyncRunResource,
)
