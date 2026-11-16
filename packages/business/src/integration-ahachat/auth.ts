import { encryptedDataSchema, encryptUtils } from "@chatbotx.io/encryption"
import { ahachatAuthSchema } from "@chatbotx.io/integration-ahachat"
import type { AuthValue } from "@chatbotx.io/sdk"
import type { WorkspaceAuthCodec } from "../connection/store-bindings"
import { ChatbotXException } from "../errors"

/** Ties the encrypted token to its workspace: copied elsewhere it does not decrypt. */
const authAad = (workspaceId: string) => `ahachat:${workspaceId}`

/** The stored token cannot be read back (wrong key or corrupt data): reconnect it. */
export const ahachatCredentialsUnreadableException = () =>
  new ChatbotXException(
    "The AhaChat connection could not be read. Remove it and add the broadcast API token again.",
    "ahachatCredentialsUnreadable",
  )

/** `IntegrationAhachat.encryptedAuth` never holds the plain token. */
export const ahachatAuthCodec: WorkspaceAuthCodec = {
  encode: (auth, workspaceId) =>
    encryptUtils.encryptObject(
      ahachatAuthSchema.parse(auth),
      authAad(workspaceId),
    ),
  decode: async (stored, workspaceId): Promise<AuthValue> => {
    const encrypted = encryptedDataSchema.safeParse(stored)
    if (!encrypted.success) {
      throw ahachatCredentialsUnreadableException()
    }
    try {
      return await encryptUtils.decryptObject(
        encrypted.data,
        ahachatAuthSchema,
        authAad(workspaceId),
      )
    } catch {
      // Neither the ciphertext nor the cause is logged or rethrown.
      throw ahachatCredentialsUnreadableException()
    }
  },
}
