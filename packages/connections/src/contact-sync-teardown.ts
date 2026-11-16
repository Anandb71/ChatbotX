import { contactSyncService } from "@chatbotx.io/business"
import type { ConnectionAdapter } from "@chatbotx.io/business/connection"

/**
 * Disconnect hook for every contact-sync source (wired through
 * `CONNECTION_REGISTRY.<provider>.teardown`, like
 * `messengerConnectionTeardownHook`): the live run reading from the source
 * is cancelled in the disconnect's own transaction.
 */
export const contactSyncConnectionTeardownHook: NonNullable<
  ConnectionAdapter["teardown"]
> = async ({ connection }) => ({
  remoteErrors: [],
  skipGenericRemoteTeardown: false,
  withinTransaction: async (tx) => {
    if (connection.integrationId) {
      await contactSyncService.cancelForIntegration(
        {
          workspaceId: connection.workspaceId,
          integrationId: connection.integrationId,
        },
        tx,
      )
    }
  },
})
