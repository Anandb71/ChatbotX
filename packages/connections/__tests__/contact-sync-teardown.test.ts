import type { DatabaseClient } from "@chatbotx.io/database/client"
import { beforeEach, describe, expect, test, vi } from "vitest"

const cancelForIntegration = vi.hoisted(() => vi.fn())

vi.mock("@chatbotx.io/business", () => ({
  contactSyncService: { cancelForIntegration },
}))
vi.mock("@chatbotx.io/business/connection", () => ({}))

// Loaded after the mocks register (see messenger-teardown.test.ts).
const { contactSyncConnectionTeardownHook } = await import(
  "../src/contact-sync-teardown"
)

const tx = { marker: "tx" } as unknown as DatabaseClient

const teardownFor = (integrationId: string | null) =>
  contactSyncConnectionTeardownHook({
    connection: { id: "c1", workspaceId: "ws-1", integrationId },
    auth: {},
  } as never)

beforeEach(() => {
  cancelForIntegration.mockReset().mockResolvedValue(undefined)
})

describe("contactSyncConnectionTeardownHook", () => {
  test("cancels the source's live sync inside the disconnect transaction", async () => {
    const result = await teardownFor("int-1")

    expect(result.remoteErrors).toEqual([])
    expect(result.skipGenericRemoteTeardown).toBe(false)
    expect(cancelForIntegration).not.toHaveBeenCalled()

    await result.withinTransaction?.(tx)

    expect(cancelForIntegration).toHaveBeenCalledWith(
      { workspaceId: "ws-1", integrationId: "int-1" },
      tx,
    )
  })

  test("a connection without an integration has nothing to cancel", async () => {
    const result = await teardownFor(null)

    await result.withinTransaction?.(tx)

    expect(cancelForIntegration).not.toHaveBeenCalled()
  })
})
