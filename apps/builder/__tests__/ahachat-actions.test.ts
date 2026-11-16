// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest"

const connectionService = vi.hoisted(() => ({
  connectFromCredentials: vi.fn(),
  disconnect: vi.fn(),
}))
const getForWorkspace = vi.hoisted(() => vi.fn())
const loggerWarn = vi.hoisted(() => vi.fn())
const registrations = vi.hoisted(() => [] as { client: string; fn: unknown }[])

const validationErrorSignal = vi.hoisted(
  () =>
    class ValidationErrorSignal extends Error {
      validationErrors: unknown
      constructor(validationErrors: unknown) {
        super("validation errors")
        this.validationErrors = validationErrors
      }
    },
)

class FakeChatbotXException extends Error {
  code: string
  httpStatusCode: number
  constructor(message: string, code = "systemError", httpStatusCode = 400) {
    super(message)
    this.code = code
    this.httpStatusCode = httpStatusCode
  }
}

vi.mock("@chatbotx.io/business/errors", () => ({
  ChatbotXException: FakeChatbotXException,
  notFoundException: (message: string) =>
    new FakeChatbotXException(message, "notFound", 404),
}))
vi.mock("@chatbotx.io/business/connection", () => ({
  connectionStateService: { getForWorkspace },
}))
vi.mock("@chatbotx.io/connections", () => ({ connectionService }))
vi.mock("@chatbotx.io/logger", () => ({
  getChildLogger: () => ({ warn: loggerWarn }),
}))
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}))
vi.mock("next-safe-action", () => ({
  returnValidationErrors: (_schema: unknown, errors: unknown) => {
    throw new validationErrorSignal(errors)
  },
}))
vi.mock("@/features/common/schema", () => ({
  workspaceIdrequestParams: [],
  workspaceIdAndIdRequestParams: [],
}))
vi.mock("@/lib/safe-action", () => {
  const client = (name: string) => ({
    bindArgsSchemas: () => ({
      inputSchema: () => ({
        action: (fn: unknown) => {
          registrations.push({ client: name, fn })
          return fn
        },
      }),
      action: (fn: unknown) => {
        registrations.push({ client: name, fn })
        return fn
      },
    }),
  })
  return {
    workspaceActionClient: client("plain"),
    workspaceActionClientAllowExpired: client("allowExpired"),
  }
})

const { connectAhachatAction } = await import(
  "@/features/integration-ahachat/actions/connect.action"
)
const { disconnectAhachatAction } = await import(
  "@/features/integration-ahachat/actions/disconnect.action"
)
const { connectAhachatSchema } = await import(
  "@/features/integration-ahachat/schema/request"
)

const connect = connectAhachatAction as unknown as (
  props: unknown,
) => Promise<unknown>
const disconnect = disconnectAhachatAction as unknown as (
  props: unknown,
) => Promise<unknown>

const SECRET_TOKEN = "super-secret-token-123"
const connectInput = {
  bindArgsParsedInputs: ["ws-1"],
  parsedInput: { token: SECRET_TOKEN },
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("connectAhachatSchema", () => {
  test("trims the token and rejects a blank one", () => {
    expect(connectAhachatSchema.parse({ token: "  abc  " })).toEqual({
      token: "abc",
    })
    expect(connectAhachatSchema.safeParse({ token: "   " }).success).toBe(false)
  })
})

describe("connectAhachatAction", () => {
  test("is built on the plain workspace client", () => {
    expect(
      registrations.find((r) => r.fn === connectAhachatAction)?.client,
    ).toBe("plain")
  })

  test("connects the ahachat provider with the token in the workspace", async () => {
    connectionService.connectFromCredentials.mockResolvedValue(undefined)

    await expect(connect(connectInput)).resolves.toBeUndefined()

    expect(connectionService.connectFromCredentials).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      provider: "ahachat",
      config: { token: SECRET_TOKEN },
    })
  })

  test.each([
    ["connectionCredentialsRejected", "ahachat.errors.tokenInvalid"],
    ["connectionAlreadyConnected", "ahachat.errors.alreadyConnected"],
  ])("maps %s to a token field error", async (code, key) => {
    connectionService.connectFromCredentials.mockRejectedValue(
      new FakeChatbotXException("x", code, 422),
    )

    await expect(connect(connectInput)).rejects.toMatchObject({
      validationErrors: { token: { _errors: [key] } },
    })
    expect(loggerWarn).not.toHaveBeenCalled()
  })

  test("an unexpected error becomes ahachatUnreachable (502) without leaking the token", async () => {
    connectionService.connectFromCredentials.mockRejectedValue(
      Object.assign(new Error(`request failed for token ${SECRET_TOKEN}`), {
        code: "ECONNRESET",
      }),
    )

    const thrown = await connect(connectInput).catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(FakeChatbotXException)
    expect(thrown).toMatchObject({
      message: "ahachat.errors.unreachable",
      code: "ahachatUnreachable",
      httpStatusCode: 502,
    })
    expect(JSON.stringify(thrown)).not.toContain(SECRET_TOKEN)
    expect((thrown as Error).message).not.toContain(SECRET_TOKEN)
    expect(loggerWarn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(loggerWarn.mock.calls)).not.toContain(SECRET_TOKEN)
    expect(loggerWarn.mock.calls[0]?.[0]).toMatchObject({
      errorName: "Error",
      errorCode: "ECONNRESET",
      workspaceId: "ws-1",
    })
  })

  test("an unknown ChatbotXException code is also reported as unreachable", async () => {
    connectionService.connectFromCredentials.mockRejectedValue(
      new FakeChatbotXException(`leak ${SECRET_TOKEN}`, "somethingElse", 500),
    )

    await expect(connect(connectInput)).rejects.toMatchObject({
      code: "ahachatUnreachable",
      message: "ahachat.errors.unreachable",
    })
  })
})

describe("disconnectAhachatAction", () => {
  const input = { bindArgsParsedInputs: ["ws-1", "conn-1"] }

  test("is built on the allow-expired client", () => {
    expect(
      registrations.find((r) => r.fn === disconnectAhachatAction)?.client,
    ).toBe("allowExpired")
  })

  test("disconnects an ahachat connection of the workspace", async () => {
    getForWorkspace.mockResolvedValue({ provider: "ahachat" })
    connectionService.disconnect.mockResolvedValue(undefined)

    await disconnect(input)

    expect(getForWorkspace).toHaveBeenCalledWith({
      id: "conn-1",
      workspaceId: "ws-1",
    })
    expect(connectionService.disconnect).toHaveBeenCalledWith({
      connectionId: "conn-1",
      workspaceId: "ws-1",
    })
  })

  test.each([
    ["another provider", { provider: "shopify" }],
    ["a missing connection", null],
  ])("refuses %s with not found and disconnects nothing", async (_label, row) => {
    getForWorkspace.mockResolvedValue(row)

    await expect(disconnect(input)).rejects.toMatchObject({
      code: "notFound",
      httpStatusCode: 404,
    })
    expect(connectionService.disconnect).not.toHaveBeenCalled()
  })
})
