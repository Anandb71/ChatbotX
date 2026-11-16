import { ConnectionProviderRejectedError } from "@chatbotx.io/sdk"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { AHACHAT_API_BASE_URL_ENV } from "../src/constants"
import { AhachatApiError } from "../src/error"
import { integration } from "../src/integration"
import type { AhachatAuthValue } from "../src/schemas"

const connection = integration.connection
if (connection?.strategy !== "token") {
  throw new Error("AhaChat must declare a token connection")
}

const page = {
  id: "1122334455",
  channel: "whatsapp",
  name: "My Shop",
  avatar: null,
  link: null,
  connected_page_id: null,
  latest_user_id: null,
}

const auth: AhachatAuthValue = {
  authType: "custom",
  token: "secret",
  page: {
    id: "1122334455",
    channel: "whatsapp",
    name: "My Shop",
    avatarUrl: null,
  },
}

const respond = (status: number, body: unknown = {}) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
    ),
  )

beforeEach(() => {
  vi.stubEnv(AHACHAT_API_BASE_URL_ENV, "https://chatbot.example.com")
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("AhaChat connection provider", () => {
  test("allows several connections per workspace, one token each", () => {
    expect(connection.kind).toBe("integration")
    expect(connection.multiInstance).toBe(true)
    expect(connection.multiAccount).toBe(false)
    expect(connection.configFields.map((field) => field.name)).toEqual([
      "token",
    ])
  })

  test("a token becomes an auth value carrying its page snapshot", async () => {
    respond(200, { data: page })

    const created = await connection.fromCredentials({ token: " secret " })

    expect(created).toEqual(auth)
    expect(connection.describe(created)).toEqual({
      sourceId: "whatsapp:1122334455",
      displayName: "My Shop",
      avatarUrl: undefined,
    })
  })

  test("the same page id on another channel is a different source", () => {
    expect(
      connection.describe({
        ...auth,
        page: { ...auth.page, channel: "messenger" },
      }).sourceId,
    ).toBe("messenger:1122334455")
  })

  test("a page without a name is shown by its id", () => {
    expect(
      connection.describe({ ...auth, page: { ...auth.page, name: null } })
        .displayName,
    ).toBe("1122334455")
  })

  test("an invalid token is rejected as invalid credentials", async () => {
    respond(401)

    const error = await connection
      .fromCredentials({ token: "wrong" })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ConnectionProviderRejectedError)
    expect((error as ConnectionProviderRejectedError).failureCause).toBe(
      "credentials_invalid",
    )
  })

  test("an outage is not a rejection, so the user can retry", async () => {
    respond(503)

    await expect(
      connection.fromCredentials({ token: "secret" }),
    ).rejects.toBeInstanceOf(AhachatApiError)
  })

  test("an empty token is refused before any request", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await expect(connection.fromCredentials({ token: "  " })).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test.each([
    [200, { ok: true }],
    [401, { ok: false, revoked: true }],
    [500, { ok: false, revoked: false }],
  ])("verify maps HTTP %i", async (status, expected) => {
    respond(status, status === 200 ? { data: page } : {})

    expect(await connection.verify({ auth })).toMatchObject(expected)
  })

  test("only an unauthorized error counts as a revoked token", () => {
    const isRevoked = connection.isRevokedTokenError
    expect(
      isRevoked?.(
        new AhachatApiError({ code: "unauthorized", statusCode: 401 }),
      ),
    ).toBe(true)
    expect(
      isRevoked?.(
        new AhachatApiError({ code: "rateLimited", statusCode: 429 }),
      ),
    ).toBe(false)
    expect(isRevoked?.(new Error("boom"))).toBe(false)
  })
})
