import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { getAhachatPage } from "../src/apis"
import { AHACHAT_API_BASE_URL_ENV } from "../src/constants"
import { AhachatApiError } from "../src/error"

// A short deadline, so a stalled call fails within the test.
vi.mock("../src/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/constants")>()),
  AHACHAT_HTTP_TIMEOUT_MS: 50,
}))

const TOKEN = "broadcast-token-secret"

const captureError = async (promise: Promise<unknown>) => {
  const error = await promise.catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(AhachatApiError)
  return error as AhachatApiError
}

beforeEach(() => {
  vi.stubEnv(AHACHAT_API_BASE_URL_ENV, "https://chatbot.example.com/")
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("AhaChat client deadline and token safety", () => {
  test("a body that stalls after the headers ends at the deadline", async () => {
    // Like fetch: the body stream fails when the request's signal aborts.
    vi.stubGlobal(
      "fetch",
      vi.fn((request: Request) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"data":'))
            request.signal.addEventListener("abort", () =>
              controller.error(request.signal.reason),
            )
          },
        })
        return Promise.resolve(new Response(body, { status: 200 }))
      }),
    )

    const error = await captureError(getAhachatPage(TOKEN))

    expect(error.code).toBe("timeout")
  })

  test("a token that could never be valid is refused before any request, without echoing it", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const error = await captureError(getAhachatPage(`${TOKEN}\nX-Injected: 1`))

    expect(error.code).toBe("unauthorized")
    expect(error.message).not.toContain(TOKEN)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("an unexpected transport error is classified and its message dropped", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.reject(new TypeError(`invalid header value Bearer ${TOKEN}`)),
      ),
    )

    const error = await captureError(getAhachatPage(TOKEN))

    expect(error.code).toBe("network")
    expect(error.message).not.toContain(TOKEN)
    expect(error.cause).toBeUndefined()
  })
})
