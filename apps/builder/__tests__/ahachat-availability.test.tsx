// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from "vitest"

vi.mock("server-only", () => ({}))

const configured = vi.hoisted(() => ({ value: true }))
vi.mock("@chatbotx.io/integration-ahachat", () => ({
  isAhachatConfigured: () => configured.value,
}))

const mockNotFound = vi.fn(() => {
  throw new Error("notFound")
})
vi.mock("next/navigation", () => ({ notFound: mockNotFound }))

const listSources = vi.hoisted(() => vi.fn())
vi.mock("@chatbotx.io/business", () => ({
  contactSyncService: { listSources },
}))
vi.mock(
  "@/features/integration-ahachat/components/ahachat-connections",
  () => ({ AhachatConnections: () => null }),
)

const { listUnavailableIntegrationSlugs } = await import(
  "@/features/integrations/settings-availability"
)
const { default: SettingsIntegrationAhachatPage } = await import(
  "@/app/space/[workspaceId]/(settings)/settings/integrations/ahachat/page"
)

beforeEach(() => {
  listSources.mockReset().mockResolvedValue([])
  mockNotFound.mockClear()
})

describe("AhaChat availability", () => {
  test("a configured deployment shows every integration row", () => {
    configured.value = true

    expect(listUnavailableIntegrationSlugs()).toEqual([])
  })

  test("without the AhaChat setting its row is hidden", () => {
    configured.value = false

    expect(listUnavailableIntegrationSlugs()).toEqual(["ahachat"])
  })

  test("the AhaChat settings page is a 404 when not configured, before any read", async () => {
    configured.value = false

    await expect(
      SettingsIntegrationAhachatPage({
        params: Promise.resolve({ workspaceId: "1" }),
      }),
    ).rejects.toThrow("notFound")
    expect(listSources).not.toHaveBeenCalled()
  })

  test("the AhaChat settings page lists the sources when configured", async () => {
    configured.value = true

    await SettingsIntegrationAhachatPage({
      params: Promise.resolve({ workspaceId: "1" }),
    })

    expect(listSources).toHaveBeenCalledWith({
      workspaceId: "1",
      provider: "ahachat",
    })
  })
})
