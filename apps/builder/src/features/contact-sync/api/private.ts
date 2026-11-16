import { contactSyncService } from "@chatbotx.io/business"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { requireUnrestrictedContactsScope } from "@/features/contact-scan/lib/require-unrestricted-contacts-scope"
import { workspaceAuthorizedMidddleware } from "@/middlewares/auth"
import { authorizedAPI } from "@/orpc"
import {
  contactSyncAvailabilityResponse,
  contactSyncRunResource,
  getContactSyncSchemaPublicResponse,
  listContactSyncSourcesPublicResponse,
} from "../schema/public"

const workspaceRequest = z.object({ workspaceId: zodBigintAsString() })

/**
 * Session reads behind the sync dialog. Same service methods as the public
 * API; a member limited to assigned contacts may not sync the workspace.
 */
export const contactSyncAuthenticatedAPI = {
  listSources: authorizedAPI
    .route({
      method: "GET",
      path: "/workspaces/{workspaceId}/contact-syncs/sources",
      summary: "List contact sync sources",
      tags: ["Contacts"],
    })
    .input(workspaceRequest)
    .output(listContactSyncSourcesPublicResponse)
    .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
    .handler(async ({ input }) => {
      await requireUnrestrictedContactsScope(input.workspaceId)
      return {
        data: await contactSyncService.listSources({
          workspaceId: input.workspaceId,
        }),
      }
    }),

  getSchema: authorizedAPI
    .route({
      method: "GET",
      path: "/workspaces/{workspaceId}/contact-syncs/sources/{connectionId}/schema",
      summary: "Get tags and custom fields of sync source",
      tags: ["Contacts"],
    })
    .input(workspaceRequest.extend({ connectionId: zodBigintAsString() }))
    .output(getContactSyncSchemaPublicResponse)
    .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
    .handler(async ({ input }) => {
      await requireUnrestrictedContactsScope(input.workspaceId)
      const { tags, fields } = await contactSyncService.getSchema(input)
      return { tags, fields }
    }),

  getAvailability: authorizedAPI
    .route({
      method: "GET",
      path: "/workspaces/{workspaceId}/contact-syncs/availability",
      summary: "Check whether contact sync can start now",
      tags: ["Contacts"],
    })
    .input(workspaceRequest)
    .output(contactSyncAvailabilityResponse)
    .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
    .handler(async ({ input }) => {
      await requireUnrestrictedContactsScope(input.workspaceId)
      return await contactSyncService.getAvailability(input)
    }),

  getRun: authorizedAPI
    .route({
      method: "GET",
      path: "/workspaces/{workspaceId}/contact-syncs/{runId}",
      summary: "Get contact sync run",
      tags: ["Contacts"],
    })
    .input(workspaceRequest.extend({ runId: zodBigintAsString() }))
    .output(contactSyncRunResource)
    .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
    .handler(async ({ input }) => {
      await requireUnrestrictedContactsScope(input.workspaceId)
      return await contactSyncService.get(input)
    }),
}
