import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { ContactSyncDialog } from "@/features/contact-sync/components/contact-sync-dialog"

/** Echoes the key (plus params) back so assertions never depend on copy. */
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
  useFormatter: () => ({ dateTime: (date: Date) => date.toISOString() }),
}))

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode
    href: string
  }) => <a href={href}>{children}</a>,
}))

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
vi.mock("sonner", () => ({ toast }))

const invalidators = vi.hoisted(() => ({
  contactSyncs: vi.fn(),
  contacts: vi.fn(),
  tags: vi.fn(),
  customFields: vi.fn(),
}))
vi.mock("@/features/contact-sync/hooks/use-invalidate-contact-syncs", () => ({
  useInvalidateContactSyncs: () => invalidators.contactSyncs,
}))
vi.mock("@/features/contacts/hooks/use-contacts", () => ({
  useInvalidateContacts: () => invalidators.contacts,
}))
vi.mock("@/features/tags/provider/tag-hook", () => ({
  useInvalidateTags: () => invalidators.tags,
}))
vi.mock("@/features/custom-fields/provider/custom-field-hook", () => ({
  useInvalidateCustomFields: () => invalidators.customFields,
}))

vi.mock("@/features/inboxes/provider/inbox-hook", () => ({
  allInboxConfigs: {
    messenger: { label: "Messenger" },
    whatsapp: { label: "WhatsApp" },
  },
}))

type QueryState = {
  isPending?: boolean
  isError?: boolean
  data?: unknown
}
const queryStates = vi.hoisted(
  () => ({}) as Record<"availability" | "sources", QueryState>,
)
const queryEnabled = vi.hoisted(
  () => ({}) as Record<string, boolean | undefined>,
)

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { __key: "availability" | "sources" }) =>
    queryStates[options.__key],
}))

vi.mock("@/lib/orpc/query", () => ({
  orpc: {
    contactSyncAPIs: {
      getAvailability: {
        queryOptions: (options: { enabled?: boolean }) => {
          queryEnabled.availability = options.enabled
          return { ...options, __key: "availability" }
        },
      },
      listSources: {
        queryOptions: (options: { enabled?: boolean }) => {
          queryEnabled.sources = options.enabled
          return { ...options, __key: "sources" }
        },
      },
    },
  },
}))

type StartOptions = {
  onSuccess?: (args: { data?: { runId: string } }) => void
  onError?: (args: {
    error: { serverError?: string; validationErrors?: { _errors?: string[] } }
  }) => void
}
const execute = vi.hoisted(() => vi.fn())
const actionState = vi.hoisted(() => ({
  options: {} as StartOptions,
  isPending: false,
}))
vi.mock("@/features/contact-sync/actions/contact-sync.action", () => ({
  startContactSyncAction: { bind: vi.fn(() => ({})) },
}))
vi.mock("next-safe-action/hooks", () => ({
  useAction: (_action: unknown, options: StartOptions) => {
    actionState.options = options
    return { execute, isPending: actionState.isPending }
  },
}))

vi.mock("@/features/contact-sync/components/contact-sync-progress", () => ({
  ContactSyncProgress: ({
    runId,
    onSettled,
  }: {
    runId: string
    onSettled: () => void
  }) => (
    <div data-run-id={runId} data-testid="progress">
      <button data-testid="settle" onClick={onSettled} type="button" />
    </div>
  ),
}))
vi.mock("@/features/contact-sync/components/contact-sync-mapping", () => ({
  ContactSyncMapping: ({ connectionId }: { connectionId: string }) => (
    <div data-connection-id={connectionId} data-testid="mapping" />
  ),
}))

vi.mock("@chatbotx.io/ui/components/ui/dialog", () => ({
  Dialog: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode
    open?: boolean
    onOpenChange?: (open: boolean) => void
  }) => (
    <div data-open={String(open)} data-testid="dialog">
      <button
        data-testid="open-dialog"
        onClick={() => onOpenChange?.(true)}
        type="button"
      />
      {children}
    </div>
  ),
  DialogTrigger: ({ render }: { render: React.ReactElement }) => render,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}))
vi.mock("@chatbotx.io/ui/components/ui/button", () => ({
  Button: ({
    render,
    children,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    render?: React.ReactElement
  }) => render ?? <button {...rest}>{children}</button>,
}))
vi.mock("@chatbotx.io/ui/components/ui/label", () => ({
  Label: ({
    children,
    htmlFor,
  }: {
    children: React.ReactNode
    htmlFor?: string
  }) => <label htmlFor={htmlFor}>{children}</label>,
}))
vi.mock("@chatbotx.io/ui/components/ui/checkbox", () => ({
  Checkbox: ({
    checked,
    disabled,
    id,
    onCheckedChange,
  }: {
    checked: boolean
    disabled?: boolean
    id: string
    onCheckedChange: (checked: boolean) => void
  }) => (
    <input
      checked={checked}
      disabled={disabled}
      id={id}
      onChange={(event) => onCheckedChange(event.target.checked)}
      type="checkbox"
    />
  ),
}))
vi.mock("@chatbotx.io/ui/components/ui/switch", () => ({
  Switch: ({
    checked,
    id,
    onCheckedChange,
  }: {
    checked: boolean
    id: string
    onCheckedChange: (checked: boolean) => void
  }) => (
    <input
      aria-checked={checked}
      checked={checked}
      id={id}
      onChange={(event) => onCheckedChange(event.target.checked)}
      role="switch"
      type="checkbox"
    />
  ),
}))
vi.mock("@chatbotx.io/ui/components/ui/select", () => ({
  Select: ({
    items,
    value,
    onValueChange,
  }: {
    items: { value: string; label: string }[]
    value: string
    onValueChange: (value: string) => void
  }) => (
    <select
      data-testid="inbox-select"
      onChange={(event) => onValueChange(event.target.value)}
      value={value}
    >
      <option value="">placeholder</option>
      {items.map((item) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      ))}
    </select>
  ),
  SelectContent: () => null,
  SelectItem: () => null,
  SelectTrigger: () => null,
  SelectValue: () => null,
}))

const eligibleSource = {
  connectionId: "c1",
  provider: "ahachat",
  connectionStatus: "connected",
  account: {
    accountId: "page-1",
    channel: "messenger",
    name: "Shop Page",
    avatarUrl: null,
  },
  matchedInboxes: [{ id: "i1", name: "Shop Inbox", channel: "messenger" }],
  eligible: true,
  ineligibleReason: null,
}
const noInboxSource = {
  ...eligibleSource,
  connectionId: "c2",
  account: { ...eligibleSource.account, accountId: "page-2", name: "Old Page" },
  matchedInboxes: [],
  eligible: false,
  ineligibleReason: "noMatchingInbox",
}
const noChannelSource = {
  ...eligibleSource,
  connectionId: "c3",
  account: {
    accountId: "page-3",
    channel: null,
    name: "Weird Page",
    avatarUrl: null,
  },
  matchedInboxes: [],
  eligible: false,
  ineligibleReason: "channelUnsupported",
}
const whatsappSource = {
  ...eligibleSource,
  connectionId: "c4",
  account: {
    accountId: "waba-1",
    channel: "whatsapp",
    name: "WA Business",
    avatarUrl: null,
  },
  matchedInboxes: [
    { id: "w1", name: "Number A", channel: "whatsapp" },
    { id: "w2", name: "Number B", channel: "whatsapp" },
  ],
}

const idleAvailability = {
  canSync: true,
  blockedReason: null,
  nextSyncAt: null,
  activeRunId: null,
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function renderDialog() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <ContactSyncDialog
        trigger={<button type="button">open</button>}
        workspaceId="ws-1"
      />,
    )
  })
  // biome-ignore lint/style/noNonNullAssertion: assigned synchronously above
  return container!
}

const setSources = (...sources: unknown[]) => {
  queryStates.availability = { data: idleAvailability }
  queryStates.sources = { data: { data: sources } }
}

const buttonWithText = (el: HTMLElement, text: string) =>
  Array.from(el.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(text),
  ) as HTMLButtonElement | undefined

const startButton = (el: HTMLElement) => buttonWithText(el, "contactSync.start")

const checkboxFor = (el: HTMLElement, connectionId: string) =>
  el.querySelector(`#contact-sync-source-${connectionId}`) as HTMLInputElement

const switchFor = (el: HTMLElement, key: string) =>
  el.querySelector(`#contact-sync-${key}`) as HTMLInputElement

const toggle = (input: HTMLInputElement) => {
  act(() => {
    input.click()
  })
}

const choose = (select: HTMLSelectElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value",
  )?.set
  act(() => {
    setter?.call(select, value)
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
}

beforeEach(() => {
  queryStates.availability = { data: idleAvailability }
  queryStates.sources = { data: { data: [] } }
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

describe("ContactSyncDialog states", () => {
  test("shows a spinner while availability or sources are loading", () => {
    queryStates.availability = { isPending: true }
    queryStates.sources = { isPending: true }

    const el = renderDialog()

    expect(el.querySelector("svg.animate-spin")).not.toBeNull()
    expect(startButton(el)).toBeUndefined()
  })

  test("shows the error with a Retry that refetches the contact sync queries", () => {
    queryStates.availability = { isError: true }
    queryStates.sources = { data: { data: [] } }

    const el = renderDialog()

    expect(el.textContent).toContain("contactSync.errors.generic")
    act(() => {
      buttonWithText(el, "actions.retry")?.click()
    })
    expect(invalidators.contactSyncs).toHaveBeenCalledTimes(1)
  })

  test("with no sources, explains and links to the AhaChat settings page", () => {
    setSources()

    const el = renderDialog()

    expect(el.textContent).toContain("contactSync.empty")
    const link = el.querySelector('a[href$="/settings/integrations/ahachat"]')
    expect(link?.getAttribute("href")).toBe(
      "/space/ws-1/settings/integrations/ahachat",
    )
    expect(link?.textContent).toBe("contactSync.goToSettings")
    expect(startButton(el)).toBeUndefined()
  })

  test.each([
    ["no source", () => setSources()],
    [
      "the cooldown",
      () => {
        queryStates.availability = {
          data: {
            canSync: false,
            blockedReason: "cooldown",
            nextSyncAt: new Date("2030-05-06T07:08:09.000Z"),
            activeRunId: null,
          },
        }
        queryStates.sources = { data: { data: [eligibleSource] } }
      },
    ],
    ["the form", () => setSources(eligibleSource)],
  ])("links to the sync history with %s", (_label, arrange) => {
    arrange()

    const el = renderDialog()

    const link = el.querySelector(
      'a[href="/space/ws-1/contacts/sync/histories"]',
    )
    expect(link?.textContent).toContain("contactSync.history.open")
  })

  test("during the cooldown shows the formatted next sync time instead of the form", () => {
    queryStates.availability = {
      data: {
        canSync: false,
        blockedReason: "cooldown",
        nextSyncAt: new Date("2030-05-06T07:08:09.000Z"),
        activeRunId: null,
      },
    }
    queryStates.sources = { data: { data: [eligibleSource] } }

    const el = renderDialog()

    expect(el.textContent).toContain(
      `contactSync.cooldown:${JSON.stringify({ time: "2030-05-06T07:08:09.000Z" })}`,
    )
    expect(startButton(el)).toBeUndefined()
  })

  test("with an active run shows its progress, not the form", () => {
    queryStates.availability = {
      data: {
        canSync: false,
        blockedReason: "running",
        nextSyncAt: null,
        activeRunId: "run-9",
      },
    }
    queryStates.sources = { data: { data: [eligibleSource] } }

    const el = renderDialog()

    expect(
      el.querySelector('[data-testid="progress"]')?.getAttribute("data-run-id"),
    ).toBe("run-9")
    expect(startButton(el)).toBeUndefined()
  })

  test("Done on a finished run closes the dialog", () => {
    queryStates.availability = {
      data: {
        canSync: false,
        blockedReason: "running",
        nextSyncAt: null,
        activeRunId: "run-9",
      },
    }
    queryStates.sources = { data: { data: [eligibleSource] } }
    const el = renderDialog()
    const dialog = () => el.querySelector('[data-testid="dialog"]')

    act(() => {
      ;(el.querySelector('[data-testid="open-dialog"]') as HTMLElement).click()
    })
    expect(dialog()?.getAttribute("data-open")).toBe("true")
    act(() => {
      ;(el.querySelector('[data-testid="settle"]') as HTMLElement).click()
    })

    expect(dialog()?.getAttribute("data-open")).toBe("false")
  })

  test("settling a run refreshes contacts, tags, custom fields and the sync queries", () => {
    queryStates.availability = {
      data: {
        canSync: false,
        blockedReason: "running",
        nextSyncAt: null,
        activeRunId: "run-9",
      },
    }
    queryStates.sources = { data: { data: [eligibleSource] } }
    const el = renderDialog()

    act(() => {
      ;(el.querySelector('[data-testid="settle"]') as HTMLElement).click()
    })

    expect(invalidators.contacts).toHaveBeenCalledTimes(1)
    expect(invalidators.tags).toHaveBeenCalledTimes(1)
    expect(invalidators.customFields).toHaveBeenCalledTimes(1)
    expect(invalidators.contactSyncs).toHaveBeenCalledTimes(1)
  })
})

describe("ContactSyncDialog form", () => {
  test("lists each source with its channel and target inbox", () => {
    setSources(eligibleSource)

    const el = renderDialog()

    expect(el.textContent).toContain("Shop Page")
    expect(el.textContent).toContain("Messenger → Shop Inbox")
    expect(checkboxFor(el, "c1").disabled).toBe(false)
  })

  test("an ineligible source is disabled and shows its reason", () => {
    setSources(noInboxSource)

    const el = renderDialog()

    expect(checkboxFor(el, "c2").disabled).toBe(true)
    expect(el.textContent).toContain(
      "Messenger → contactSync.ineligible.noMatchingInbox",
    )
  })

  test("a source with no channel shows only the reason, not 'unsupported → unsupported'", () => {
    setSources(noChannelSource)

    const el = renderDialog()
    const label = el.querySelector("label")

    expect(checkboxFor(el, "c3").disabled).toBe(true)
    expect(label?.textContent).toBe(
      "Weird PagecontactSync.ineligible.channelUnsupported",
    )
    expect(el.textContent).not.toContain("→")
  })

  test("Start is disabled while nothing is selected", () => {
    setSources(eligibleSource)

    const el = renderDialog()

    expect(startButton(el)?.disabled).toBe(true)
  })

  test("overwrite defaults OFF while tags and custom fields default ON", () => {
    setSources(eligibleSource)

    const el = renderDialog()

    expect(switchFor(el, "syncTags").checked).toBe(true)
    expect(switchFor(el, "syncCustomFields").checked).toBe(true)
    expect(switchFor(el, "overwriteExisting").checked).toBe(false)
  })

  test("the Advanced link shows only with a selected source and tags or fields on", () => {
    setSources(eligibleSource)
    const el = renderDialog()
    const advanced = () => buttonWithText(el, "contactSync.advanced.show")

    expect(advanced()).toBeUndefined()

    toggle(checkboxFor(el, "c1"))
    expect(advanced()).toBeDefined()

    toggle(switchFor(el, "syncTags"))
    expect(advanced()).toBeDefined()

    toggle(switchFor(el, "syncCustomFields"))
    expect(advanced()).toBeUndefined()

    toggle(switchFor(el, "syncTags"))
    expect(advanced()).toBeDefined()

    toggle(checkboxFor(el, "c1"))
    expect(advanced()).toBeUndefined()
  })

  test("Advanced reveals the mapping for each selected source", () => {
    setSources(eligibleSource)
    const el = renderDialog()
    toggle(checkboxFor(el, "c1"))
    expect(el.querySelector('[data-testid="mapping"]')).toBeNull()

    act(() => {
      buttonWithText(el, "contactSync.advanced.show")?.click()
    })

    expect(
      el
        .querySelector('[data-testid="mapping"]')
        ?.getAttribute("data-connection-id"),
    ).toBe("c1")
    expect(buttonWithText(el, "contactSync.advanced.hide")).toBeDefined()
  })

  test("a multi-inbox source asks for an inbox once checked and blocks Start until chosen", () => {
    setSources(whatsappSource)
    const el = renderDialog()

    expect(el.querySelector('[data-testid="inbox-select"]')).toBeNull()
    expect(el.textContent).toContain(
      "WhatsApp → contactSync.source.chooseInbox",
    )

    toggle(checkboxFor(el, "c4"))
    const select = el.querySelector(
      '[data-testid="inbox-select"]',
    ) as HTMLSelectElement
    expect(select).not.toBeNull()
    expect(startButton(el)?.disabled).toBe(true)

    choose(select, "w2")
    expect(startButton(el)?.disabled).toBe(false)
  })

  test("Start sends the selected sources (inboxId only when chosen) and the options", () => {
    setSources(eligibleSource, whatsappSource)
    const el = renderDialog()
    toggle(checkboxFor(el, "c1"))
    toggle(checkboxFor(el, "c4"))
    choose(
      el.querySelector('[data-testid="inbox-select"]') as HTMLSelectElement,
      "w1",
    )
    toggle(switchFor(el, "overwriteExisting"))
    toggle(switchFor(el, "syncCustomFields"))

    act(() => {
      startButton(el)?.click()
    })

    expect(execute).toHaveBeenCalledWith({
      syncTags: true,
      syncCustomFields: false,
      overwriteExisting: true,
      sources: [{ connectionId: "c1" }, { connectionId: "c4", inboxId: "w1" }],
    })
  })

  test("Start is disabled while the action is pending", () => {
    setSources(eligibleSource)
    actionState.isPending = true
    const el = renderDialog()
    toggle(checkboxFor(el, "c1"))

    expect(startButton(el)?.disabled).toBe(true)
  })

  test("a started sync switches to its progress and refreshes the sync queries", () => {
    setSources(eligibleSource)
    const el = renderDialog()

    act(() => {
      actionState.options.onSuccess?.({ data: { runId: "run-new" } })
    })

    expect(
      el.querySelector('[data-testid="progress"]')?.getAttribute("data-run-id"),
    ).toBe("run-new")
    expect(invalidators.contactSyncs).toHaveBeenCalledTimes(1)
  })

  test("a failed start toasts the validation message, else the server error, else a generic one", () => {
    setSources(eligibleSource)
    renderDialog()

    act(() => {
      actionState.options.onError?.({
        error: { validationErrors: { _errors: ["cooldown"] } },
      })
      actionState.options.onError?.({ error: { serverError: "server" } })
      actionState.options.onError?.({ error: {} })
    })

    expect(toast.error).toHaveBeenNthCalledWith(1, "cooldown")
    expect(toast.error).toHaveBeenNthCalledWith(2, "server")
    expect(toast.error).toHaveBeenNthCalledWith(3, "contactSync.errors.generic")
  })
})
