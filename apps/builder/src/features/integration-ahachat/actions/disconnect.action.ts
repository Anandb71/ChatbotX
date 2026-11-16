"use server"

import { connectionStateService } from "@chatbotx.io/business/connection"
import { notFoundException } from "@chatbotx.io/business/errors"
import { connectionService } from "@chatbotx.io/connections"
import {
  type WorkspaceIdAndIdRequestParams,
  workspaceIdAndIdRequestParams,
} from "@/features/common/schema"
import { workspaceActionClientAllowExpired } from "@/lib/safe-action"

/**
 * Removes one AhaChat page connection. Its encrypted token is deleted with
 * it, and a sync still reading from it is cancelled in the same transaction.
 */
export const disconnectAhachatAction = workspaceActionClientAllowExpired
  .bindArgsSchemas(workspaceIdAndIdRequestParams)
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, connectionId],
    }: {
      bindArgsParsedInputs: WorkspaceIdAndIdRequestParams
    }) => {
      const connection = await connectionStateService.getForWorkspace({
        id: connectionId,
        workspaceId,
      })
      if (connection?.provider !== "ahachat") {
        throw notFoundException("Connection not found")
      }
      await connectionService.disconnect({ connectionId, workspaceId })
    },
  )
