// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest"

const service = vi.hoisted(() => ({
  schedule: vi.fn(),
  cancel: vi.fn(),
  saveMappings: vi.fn(),
}))
const mockRequireUnrestrictedContactsScope = vi.hoisted(() => vi.fn())
const mockGetCurrentUser = vi.hoisted(() => vi.fn())

/** Mirrors the real `returnValidationErrors`, which throws. */
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
const mockReturnValidationErrors = vi.hoisted(() =>
  vi.fn((_schema: unknown, errors: unknown) => {
    throw new validationErrorSignal(errors)
  }),
)

// Which client each action was built on, in registration order.
const registrations = vi.hoisted(
  () => [] as { client: string; fn: unknown; hasInputSchema: boolean }[],
)

vi.mock("@chatbotx.io/business", () => ({ contactSyncService: service }))

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
}))

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}))
vi.mock("next-safe-action", () => ({
  returnValidationErrors: mockReturnValidationErrors,
}))
vi.mock("@/features/common/schema", () => ({
  workspaceIdrequestParams: [],
  workspaceIdAndIdRequestParams: [],
}))
vi.mock("@/lib/auth/utils", () => ({ getCurrentUser: mockGetCurrentUser }))
vi.mock("@/lib/safe-action", () => {
  const client = (name: string) => ({
    bindArgsSchemas: () => ({
      inputSchema: () => ({
        action: (fn: unknown) => {
          registrations.push({ client: name, fn, hasInputSchema: true })
          return fn
        },
      }),
      action: (fn: unknown) => {
        registrations.push({ client: name, fn, hasInputSchema: false })
        return fn
      },
    }),
  })
  return {
    workspaceActionClient: client("plain"),
    workspaceActionClientAllowExpired: client("allowExpired"),
  }
})
vi.mock(
  "@/features/contact-scan/lib/require-unrestricted-contacts-scope",
  () => ({
    requireUnrestrictedContactsScope: mockRequireUnrestrictedContactsScope,
  }),
)

const actions = await import(
  "@/features/contact-sync/actions/contact-sync.action"
)
const start = actions.startContactSyncAction as unknown as (
  props: unknown,
) => Promise<unknown>
const cancel = actions.cancelContactSyncAction as unknown as (
  props: unknown,
) => Promise<unknown>
const saveMappings = actions.saveContactSyncMappingsAction as unknown as (
  props: unknown,
) => Promise<unknown>

const clientOf = (action: unknown) =>
  registrations.find((r) => r.fn === action)?.client

const startInput = {
  bindArgsParsedInputs: ["ws-1"],
  parsedInput: {
    sources: [{ connectionId: "c1", inboxId: "i1" }, { connectionId: "c2" }],
    syncTags: true,
    syncCustomFields: false,
    overwriteExisting: true,
  },
}

const saveInput = {
  bindArgsParsedInputs: ["ws-1"],
  parsedInput: {
    connectionId: "c1",
    tags: [{ externalId: "a", target: { tagName: "VIP" } }],
    fields: [{ externalId: "x", target: null }],
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireUnrestrictedContactsScope.mockResolvedValue(undefined)
  mockGetCurrentUser.mockResolvedValue({ id: "user-1" })
})

describe("client wiring", () => {
  test("start and saveMappings use the plain workspace client (blocked after trial expiry)", () => {
    expect(clientOf(actions.startContactSyncAction)).toBe("plain")
    expect(clientOf(actions.saveContactSyncMappingsAction)).toBe("plain")
  })

  test("cancel uses the allow-expired client", () => {
    expect(clientOf(actions.cancelContactSyncAction)).toBe("allowExpired")
  })
})

describe("startContactSyncAction", () => {
  test("checks the contacts scope, then schedules for the workspace as the app user", async () => {
    service.schedule.mockResolvedValue({ id: "run-1" })

    await expect(start(startInput)).resolves.toEqual({ runId: "run-1" })

    expect(mockRequireUnrestrictedContactsScope).toHaveBeenCalledWith("ws-1")
    expect(service.schedule).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      requestedByUserId: "user-1",
      triggerSource: "app",
      sources: startInput.parsedInput.sources,
      syncTags: true,
      syncCustomFields: false,
      overwriteExisting: true,
    })
  })

  test("records no requester when there is no session user", async () => {
    mockGetCurrentUser.mockResolvedValue(null)
    service.schedule.mockResolvedValue({ id: "run-1" })

    await start(startInput)

    expect(service.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ requestedByUserId: null }),
    )
  })

  test("an assigned-only member is denied: localized top-level error, nothing scheduled", async () => {
    mockRequireUnrestrictedContactsScope.mockRejectedValue(
      new FakeChatbotXException("denied", "contactScanForbidden", 403),
    )

    await expect(start(startInput)).rejects.toMatchObject({
      validationErrors: { _errors: ["contactSync.errors.forbidden"] },
    })
    expect(service.schedule).not.toHaveBeenCalled()
  })

  test.each([
    ["contactSyncAlreadyRunning", "alreadyRunning"],
    ["contactSyncCooldown", "cooldown"],
    ["contactSyncNoSources", "noSources"],
    ["contactSyncTooManySources", "tooManySources"],
    ["contactSyncDuplicateSource", "sourceNotEligible"],
    ["contactSyncSourceNotFound", "sourceNotEligible"],
    ["contactSyncSourceNotEligible", "sourceNotEligible"],
    ["contactSyncInboxRequired", "inboxRequired"],
    ["contactSyncInboxNotMatched", "inboxRequired"],
  ])("maps %s to the localized %s message", async (code, key) => {
    service.schedule.mockRejectedValue(
      new FakeChatbotXException("x", code, 409),
    )

    await expect(start(startInput)).rejects.toMatchObject({
      validationErrors: { _errors: [`contactSync.errors.${key}`] },
    })
  })

  test("rethrows an unknown ChatbotXException code unchanged", async () => {
    const error = new FakeChatbotXException("weird", "somethingElse")
    service.schedule.mockRejectedValue(error)

    await expect(start(startInput)).rejects.toBe(error)
    expect(mockReturnValidationErrors).not.toHaveBeenCalled()
  })

  test("rethrows a non-ChatbotX error unchanged", async () => {
    service.schedule.mockRejectedValue(new Error("boom"))

    await expect(start(startInput)).rejects.toThrow("boom")
    expect(mockReturnValidationErrors).not.toHaveBeenCalled()
  })
})

describe("cancelContactSyncAction", () => {
  test("checks the contacts scope and cancels the run in the workspace", async () => {
    service.cancel.mockResolvedValue({ cancelled: true })

    await expect(
      cancel({ bindArgsParsedInputs: ["ws-1", "run-1"] }),
    ).resolves.toEqual({ cancelled: true })

    expect(mockRequireUnrestrictedContactsScope).toHaveBeenCalledWith("ws-1")
    expect(service.cancel).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      runId: "run-1",
    })
  })

  test("a denied member cancels nothing", async () => {
    mockRequireUnrestrictedContactsScope.mockRejectedValue(
      new Error("contactScanForbidden"),
    )

    await expect(
      cancel({ bindArgsParsedInputs: ["ws-1", "run-1"] }),
    ).rejects.toThrow("contactScanForbidden")
    expect(service.cancel).not.toHaveBeenCalled()
  })

  test("passes cancelled:false through for a finished run", async () => {
    service.cancel.mockResolvedValue({ cancelled: false })

    await expect(
      cancel({ bindArgsParsedInputs: ["ws-1", "run-1"] }),
    ).resolves.toEqual({ cancelled: false })
  })
})

describe("saveContactSyncMappingsAction", () => {
  test("checks the contacts scope, then saves the parsed input for the workspace", async () => {
    service.saveMappings.mockResolvedValue(undefined)

    await expect(saveMappings(saveInput)).resolves.toBeUndefined()

    expect(mockRequireUnrestrictedContactsScope).toHaveBeenCalledWith("ws-1")
    expect(service.saveMappings).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      ...saveInput.parsedInput,
    })
  })

  test("a denied member saves nothing", async () => {
    mockRequireUnrestrictedContactsScope.mockRejectedValue(
      new FakeChatbotXException("denied", "contactScanForbidden", 403),
    )

    await expect(saveMappings(saveInput)).rejects.toMatchObject({
      validationErrors: { _errors: ["contactSync.errors.forbidden"] },
    })
    expect(service.saveMappings).not.toHaveBeenCalled()
  })

  test("maps contactSyncMappingInvalid to a localized top-level error", async () => {
    service.saveMappings.mockRejectedValue(
      new FakeChatbotXException("bad rows", "contactSyncMappingInvalid", 422),
    )

    await expect(saveMappings(saveInput)).rejects.toMatchObject({
      validationErrors: { _errors: ["contactSync.errors.mappingInvalid"] },
    })
  })

  test("rethrows an unexpected error unchanged", async () => {
    service.saveMappings.mockRejectedValue(new Error("db down"))

    await expect(saveMappings(saveInput)).rejects.toThrow("db down")
    expect(mockReturnValidationErrors).not.toHaveBeenCalled()
  })
})
