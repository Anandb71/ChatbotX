import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { ContactSyncProgress } from "@/features/contact-sync/components/contact-sync-progress"

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
vi.mock("sonner", () => ({ toast }))

vi.mock("@/features/inboxes/provider/inbox-hook", () => ({
  allInboxConfigs: {},
}))

type RunQuery = {
  isPending?: boolean
  isError?: boolean
  data?: unknown
  refetch: () => void
}
const refetch = vi.hoisted(() => vi.fn())
const queryState = vi.hoisted(() => ({
  current: {} as Partial<RunQuery>,
  options: {} as {
    input?: unknown
    refetchInterval?: (query: {
      state: { data?: { status: string } }
    }) => number | false
  },
}))

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: typeof queryState.options) => {
    queryState.options = options
    return { refetch, ...queryState.current }
  },
}))
vi.mock("@/lib/orpc/query", () => ({
  orpc: {
    contactSyncAPIs: {
      getRun: { queryOptions: (options: unknown) => options },
    },
  },
}))

type ActionOptions = {
  onSuccess?: () => void
  onError?: (args: { error: { serverError?: string } }) => void
}
const execute = vi.hoisted(() => vi.fn())
const bind = vi.hoisted(() => vi.fn(() => ({})))
const actionState = vi.hoisted(() => ({
  options: {} as ActionOptions,
  isPending: false,
}))
vi.mock("@/features/contact-sync/actions/contact-sync.action", () => ({
  cancelContactSyncAction: { bind },
}))
vi.mock("next-safe-action/hooks", () => ({
  useAction: (_action: unknown, options: ActionOptions) => {
    actionState.options = options
    return { execute, isPending: actionState.isPending }
  },
}))

vi.mock("@chatbotx.io/ui/components/ui/button", () => ({
  Button: ({
    children,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...rest}>{children}</button>
  ),
}))
vi.mock("@chatbotx.io/ui/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => (
    <span data-badge>{children}</span>
  ),
}))

const item = (overrides: Record<string, unknown> = {}) => ({
  id: "item-1",
  position: 0,
  integrationId: null,
  inboxId: "i1",
  sourceAccountName: "Shop Page",
  status: "running",
  createdCount: 3,
  updatedCount: 2,
  skippedCount: 1,
  failedCount: 0,
  skippedValueCount: 0,
  currentError: null,
  startedAt: null,
  finishedAt: null,
  ...overrides,
})

const setRun = (status: string, items: unknown[] = [item()]) => {
  queryState.current = { data: { id: "run-1", status, items } }
}

let container: HTMLDivElement | null = null
let root: Root | null = null
const onSettled = vi.fn()

function renderProgress() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <ContactSyncProgress
        onSettled={onSettled}
        runId="run-1"
        workspaceId="ws-1"
      />,
    )
  })
  // biome-ignore lint/style/noNonNullAssertion: assigned synchronously above
  return container!
}

const buttonWithText = (el: HTMLElement, text: string) =>
  Array.from(el.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(text),
  ) as HTMLButtonElement | undefined

beforeEach(() => {
  setRun("running")
})

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  container = null
  root = null
  actionState.isPending = false
  vi.clearAllMocks()
})

describe("ContactSyncProgress", () => {
  test("polls the run of the workspace and binds cancel to workspace and run", () => {
    renderProgress()

    expect(queryState.options.input).toEqual({
      workspaceId: "ws-1",
      runId: "run-1",
    })
    expect(bind).toHaveBeenCalledWith(null, "ws-1", "run-1")
  })

  test("keeps polling while live and stops once settled", () => {
    renderProgress()
    const poll = queryState.options.refetchInterval

    expect(poll?.({ state: { data: { status: "running" } } })).toEqual(
      expect.any(Number),
    )
    expect(poll?.({ state: { data: { status: "cancelling" } } })).toEqual(
      expect.any(Number),
    )
    for (const status of ["succeeded", "partial", "failed", "cancelled"]) {
      expect(poll?.({ state: { data: { status } } })).toBe(false)
    }
  })

  test("shows a spinner while loading", () => {
    queryState.current = { isPending: true }

    const el = renderProgress()

    expect(el.querySelector("svg.animate-spin")).not.toBeNull()
  })

  test("shows an error with a Retry that refetches", () => {
    queryState.current = { isError: true }

    const el = renderProgress()
    expect(el.textContent).toContain("contactSync.errors.generic")
    act(() => {
      buttonWithText(el, "actions.retry")?.click()
    })

    expect(refetch).toHaveBeenCalledTimes(1)
  })

  test("renders per-source name, status and counts", () => {
    setRun("running", [
      item(),
      item({
        id: "item-2",
        sourceAccountName: null,
        status: "pending",
        createdCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        failedCount: 4,
      }),
    ])

    const el = renderProgress()

    expect(el.textContent).toContain("Shop Page")
    expect(el.textContent).toContain(
      `contactSync.progress.counts:${JSON.stringify({ created: 3, updated: 2, skipped: 1, failed: 0 })}`,
    )
    expect(el.textContent).toContain("contactSync.progress.source")
    expect(el.textContent).toContain(
      `contactSync.progress.counts:${JSON.stringify({ created: 0, updated: 0, skipped: 0, failed: 4 })}`,
    )
    expect(el.textContent).toContain("contactSync.status.running")
    expect(el.textContent).toContain("contactSync.status.pending")
  })

  test("shows the skipped-values line only when some values were skipped", () => {
    setRun("running", [
      item({ skippedValueCount: 0 }),
      item({ id: "item-2", skippedValueCount: 7 }),
    ])

    const el = renderProgress()
    const text = el.textContent ?? ""

    expect(text).toContain(
      `contactSync.progress.skippedValues:${JSON.stringify({ count: 7 })}`,
    )
    expect(text.match(/contactSync\.progress\.skippedValues/g)).toHaveLength(1)
  })

  test("localizes a known item error and shows an unknown one verbatim", () => {
    setRun("failed", [
      item({ currentError: "tokenInvalid" }),
      item({ id: "item-2", currentError: "something odd" }),
    ])

    const el = renderProgress()

    expect(el.textContent).toContain("contactSync.runErrors.tokenInvalid")
    expect(el.textContent).toContain("something odd")
  })

  test("a live run offers Cancel, which runs the cancel action", () => {
    const el = renderProgress()

    act(() => {
      buttonWithText(el, "contactSync.progress.cancel")?.click()
    })

    expect(execute).toHaveBeenCalledTimes(1)
    expect(buttonWithText(el, "contactSync.progress.done")).toBeUndefined()
  })

  test("Cancel is disabled while the request is pending", () => {
    actionState.isPending = true

    const el = renderProgress()

    expect(buttonWithText(el, "contactSync.progress.cancel")?.disabled).toBe(
      true,
    )
  })

  test("Cancel is disabled while the run is already cancelling", () => {
    setRun("cancelling")

    const el = renderProgress()

    expect(buttonWithText(el, "contactSync.progress.cancel")?.disabled).toBe(
      true,
    )
  })

  test("a successful cancel refetches the run; a failure toasts the server error or a generic one", () => {
    renderProgress()

    act(() => {
      actionState.options.onSuccess?.()
      actionState.options.onError?.({ error: { serverError: "nope" } })
      actionState.options.onError?.({ error: {} })
    })

    expect(refetch).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenNthCalledWith(1, "nope")
    expect(toast.error).toHaveBeenNthCalledWith(2, "contactSync.errors.generic")
  })

  test.each([
    "succeeded",
    "partial",
    "failed",
    "cancelled",
  ])("a %s run drops Cancel and Done calls onSettled", (status) => {
    setRun(status)

    const el = renderProgress()

    expect(buttonWithText(el, "contactSync.progress.cancel")).toBeUndefined()
    expect(el.querySelector("svg.animate-spin")).toBeNull()
    expect(onSettled).not.toHaveBeenCalled()
    act(() => {
      buttonWithText(el, "contactSync.progress.done")?.click()
    })
    expect(onSettled).toHaveBeenCalledTimes(1)
  })
})
