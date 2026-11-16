"use server"

import { ChatbotXException } from "@chatbotx.io/business/errors"
import { connectionService } from "@chatbotx.io/connections"
import { getChildLogger } from "@chatbotx.io/logger"
import { getTranslations } from "next-intl/server"
import { returnValidationErrors } from "next-safe-action"
import {
  type WorkspaceIdRequestParams,
  workspaceIdrequestParams,
} from "@/features/common/schema"
import { workspaceActionClient } from "@/lib/safe-action"
import {
  type ConnectAhachatSchema,
  connectAhachatSchema,
} from "../schema/request"

const logger = getChildLogger("integration-ahachat")

/** Connection-engine error codes shown on the token field, by message key. */
const TOKEN_FIELD_ERRORS = {
  connectionCredentialsRejected: "ahachat.errors.tokenInvalid",
  connectionAlreadyConnected: "ahachat.errors.alreadyConnected",
} as const

const tokenFieldErrorKey = (error: unknown) =>
  error instanceof ChatbotXException && error.code in TOKEN_FIELD_ERRORS
    ? TOKEN_FIELD_ERRORS[error.code as keyof typeof TOKEN_FIELD_ERRORS]
    : null

/**
 * Connects one AhaChat page by its broadcast API token. The token is checked
 * against AhaChat (which also returns the page shown in the list) and stored
 * encrypted; the same page twice is refused on the token field.
 */
export const connectAhachatAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(connectAhachatSchema)
  .action(
    async ({
      parsedInput,
      bindArgsParsedInputs: [workspaceId],
    }: {
      parsedInput: ConnectAhachatSchema
      bindArgsParsedInputs: WorkspaceIdRequestParams
    }) => {
      const t = await getTranslations()
      try {
        await connectionService.connectFromCredentials({
          workspaceId,
          provider: "ahachat",
          config: { token: parsedInput.token },
        })
      } catch (error) {
        const tokenErrorKey = tokenFieldErrorKey(error)
        if (tokenErrorKey) {
          return returnValidationErrors(connectAhachatSchema, {
            token: { _errors: [t(tokenErrorKey)] },
          })
        }
        // Only the error's identity: a transport error could carry the request.
        logger.warn(
          {
            errorName: error instanceof Error ? error.name : typeof error,
            errorCode:
              error instanceof Error && "code" in error
                ? String(error.code)
                : null,
            workspaceId,
          },
          "[ahachat] connect failed",
        )
        throw new ChatbotXException(
          t("ahachat.errors.unreachable"),
          "ahachatUnreachable",
          502,
        )
      }
    },
  )
