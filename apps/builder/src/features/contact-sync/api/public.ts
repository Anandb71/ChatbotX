import { contactSyncService } from "@chatbotx.io/business"
import {
  possibleErrorsOnContactSyncRun,
  possibleErrorsOnContactSyncSource,
  possibleErrorsOnListingResource,
  possibleErrorsOnReadingContactSyncRun,
  possibleErrorsOnReadingContactSyncSource,
  possibleErrorsOnSchedulingContactSync,
} from "@/lib/orpc/orpc-error-helper"
import { workspaceTokenAuthAPIForScope } from "@/orpc"
import {
  cancelContactSyncPublicResponse,
  contactSyncAvailabilityResponse,
  contactSyncRunIdRequest,
  contactSyncRunResource,
  createContactSyncPublicRequest,
  createContactSyncPublicResponse,
  getContactSyncSchemaPublicRequest,
  getContactSyncSchemaPublicResponse,
  listContactSyncSourcesPublicRequest,
  listContactSyncSourcesPublicResponse,
  listContactSyncsPublicRequest,
  listContactSyncsPublicResponse,
  saveContactSyncMappingsPublicRequest,
} from "../schema/public"

const workspaceTokenAuthAPI = workspaceTokenAuthAPIForScope("contacts")

const TAGS = ["Contacts"]

export const contactSyncPublicRouter = {
  listSources: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/contact-syncs/sources",
      summary: "List contact sync sources",
      description:
        "Every connected external source (e.g. an AhaChat page connected with `connections.create`, provider `ahachat`) with the inboxes its contacts can import into. Use the `connectionId` with `contactSyncs.create`.",
      tags: TAGS,
    })
    .input(listContactSyncSourcesPublicRequest)
    .output(listContactSyncSourcesPublicResponse)
    .errors(possibleErrorsOnListingResource)
    .handler(async ({ context, input }) => ({
      data: await contactSyncService.listSources({
        workspaceId: context.workspace.id,
        provider: input.provider,
      }),
    })),

  getSchema: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/contact-syncs/sources/{connectionId}/schema",
      summary: "Get tags and custom fields of sync source",
      description:
        "The source's tags and custom fields with the workspace tag/field each one maps to. Change mappings with `contactSyncs.saveMappings`.",
      tags: TAGS,
    })
    .input(getContactSyncSchemaPublicRequest)
    .output(getContactSyncSchemaPublicResponse)
    .errors(possibleErrorsOnReadingContactSyncSource)
    .handler(async ({ context, input }) => {
      const { tags, fields } = await contactSyncService.getSchema({
        workspaceId: context.workspace.id,
        connectionId: input.connectionId,
      })
      return { tags, fields }
    }),

  saveMappings: workspaceTokenAuthAPI
    .route({
      method: "PUT",
      path: "/v1/contact-syncs/sources/{connectionId}/mappings",
      summary: "Map source tags and custom fields to workspace ones",
      description:
        "Sets which workspace tag / custom field each listed source tag / field lands on. Targets go by id or by exact name (a field name also needs its type). Every row is checked first: any invalid row rejects the call with 422 listing each one, and nothing is saved. Unlisted mappings are kept.",
      successStatus: 204,
      tags: TAGS,
    })
    .input(saveContactSyncMappingsPublicRequest)
    .errors(possibleErrorsOnContactSyncSource)
    .handler(async ({ context, input }) => {
      await contactSyncService.saveMappings({
        workspaceId: context.workspace.id,
        connectionId: input.connectionId,
        tags: input.tags,
        fields: input.fields,
      })
    }),

  getAvailability: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/contact-syncs/availability",
      summary: "Check whether contact sync can start now",
      description:
        "One sync may run per workspace, and a new one may start 4 hours after the last. Returns the blocking reason and `nextSyncAt`.",
      tags: TAGS,
    })
    .output(contactSyncAvailabilityResponse)
    .errors(possibleErrorsOnListingResource)
    .handler(
      async ({ context }) =>
        await contactSyncService.getAvailability({
          workspaceId: context.workspace.id,
        }),
    ),

  create: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/contact-syncs",
      summary: "Start contact sync",
      description:
        "Imports contacts (with tags and custom fields) from the given sources in the background, one source after the other. Nothing it creates or changes runs a trigger, flow or webhook. Rejected with 409 while a sync runs or within 4 hours of the last one (`contactSyncs.getAvailability`). Follow progress with `contactSyncs.get`.",
      successStatus: 202,
      tags: TAGS,
    })
    .input(createContactSyncPublicRequest)
    .output(createContactSyncPublicResponse)
    .errors(possibleErrorsOnSchedulingContactSync)
    .handler(async ({ context, input }) => {
      const run = await contactSyncService.schedule({
        workspaceId: context.workspace.id,
        // A workspace token has no session user; the column is nullable.
        requestedByUserId: null,
        triggerSource: "api",
        sources: input.sources,
        syncTags: input.syncTags,
        syncCustomFields: input.syncCustomFields,
        overwriteExisting: input.overwriteExisting,
      })
      return { runId: run.id }
    }),

  list: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/contact-syncs",
      summary: "List contact sync runs",
      description:
        "Every contact sync run of the workspace, newest first, with the counts and status of each source.",
      tags: TAGS,
    })
    .input(listContactSyncsPublicRequest)
    .output(listContactSyncsPublicResponse)
    .errors(possibleErrorsOnListingResource)
    .handler(async ({ context, input }) => {
      const { data, pageCount } = await contactSyncService.listHistory({
        workspaceId: context.workspace.id,
        page: input.page,
        perPage: input.perPage,
      })
      return { data, pageCount }
    }),

  get: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/contact-syncs/{runId}",
      summary: "Get contact sync run",
      description:
        "Status of the run and of each source: created, updated, skipped and failed counts, and the error a source ended with.",
      tags: TAGS,
    })
    .input(contactSyncRunIdRequest)
    .output(contactSyncRunResource)
    .errors(possibleErrorsOnReadingContactSyncRun)
    .handler(
      async ({ context, input }) =>
        await contactSyncService.get({
          workspaceId: context.workspace.id,
          runId: input.runId,
        }),
    ),

  cancel: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/contact-syncs/{runId}/cancel",
      summary: "Cancel contact sync run",
      description:
        "Stops the run; contacts already imported are kept. Returns `cancelled: false` (not an error) when the run already finished, so it is safe to call repeatedly.",
      tags: TAGS,
    })
    .input(contactSyncRunIdRequest)
    .output(cancelContactSyncPublicResponse)
    .errors(possibleErrorsOnContactSyncRun)
    .handler(
      async ({ context, input }) =>
        await contactSyncService.cancel({
          workspaceId: context.workspace.id,
          runId: input.runId,
        }),
    ),
}
