import {
  AuthType,
  type ConnectionProvider,
  ConnectionProviderRejectedError,
  Integration,
  type IntegrationDefinition,
  SdkException,
} from "@chatbotx.io/sdk"
import { getAhachatPage } from "./apis"
import { isAhachatUnauthorizedError } from "./error"
import {
  type AhachatActions,
  type AhachatAuthValue,
  type AhachatConfig,
  type AhachatCredentialValue,
  ahachatAuthSchema,
  ahachatCredentialSchema,
} from "./schemas"

/** `<channel>:<page id>`: the same page can be connected once per workspace. */
export const ahachatSourceId = (page: AhachatAuthValue["page"]) =>
  `${page.channel}:${page.id}`

const buildAuth = async (
  credentials: AhachatCredentialValue,
): Promise<AhachatAuthValue> => {
  const { token } = ahachatCredentialSchema.parse(credentials)
  try {
    const page = await getAhachatPage(token)
    return ahachatAuthSchema.parse({
      authType: AuthType.custom,
      token,
      page: {
        id: page.id,
        channel: page.channel,
        name: page.name,
        avatarUrl: page.avatarUrl,
      },
    })
  } catch (error) {
    if (isAhachatUnauthorizedError(error)) {
      throw new ConnectionProviderRejectedError(
        "Invalid AhaChat broadcast API token",
        error,
        "credentials_invalid",
      )
    }
    throw error
  }
}

/**
 * One AhaChat page per connection, connected with its broadcast API token.
 * `multiInstance`: a workspace adds one token at a time, as many as it has
 * pages; the same page twice collides on `sourceId`.
 */
const connection: ConnectionProvider<AhachatAuthValue, AhachatCredentialValue> =
  {
    kind: "integration",
    strategy: "token",
    multiAccount: false,
    multiInstance: true,
    configFields: [
      {
        name: "token",
        type: "secret",
        required: true,
        labelKey: "integrations.ahachat.fields.token",
      },
    ],
    describe: (auth) => ({
      sourceId: ahachatSourceId(auth.page),
      displayName: auth.page.name ?? auth.page.id,
      avatarUrl: auth.page.avatarUrl ?? undefined,
    }),
    fromCredentials: buildAuth,
    verify: async ({ auth }) => {
      try {
        await getAhachatPage(auth.token)
        return { ok: true }
      } catch (error) {
        const revoked = isAhachatUnauthorizedError(error)
        return {
          ok: false,
          revoked,
          error: revoked
            ? "The AhaChat broadcast API token is no longer valid"
            : "Unable to reach AhaChat",
        }
      }
    },
    isRevokedTokenError: isAhachatUnauthorizedError,
  }

const config: IntegrationDefinition<
  AhachatConfig,
  AhachatAuthValue,
  AhachatActions
> = {
  name: "ahachat",
  connection,
  actions: {
    validateCredentials: ({ props }) => buildAuth(props),
  },
  disconnect: async () => undefined,
  handleRequest: () =>
    Promise.reject(
      new SdkException("AhaChat does not expose request handlers"),
    ),
}

export const integration = new Integration(config)
