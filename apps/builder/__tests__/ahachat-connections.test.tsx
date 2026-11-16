import { zodResolver } from "@hookform/resolvers/zod"
import { act, cloneElement, createContext, useContext } from "react"
import { createRoot, type Root } from "react-dom/client"
import { useForm } from "react-hook-form"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { AhachatConnections } from "@/features/integration-ahachat/components/ahachat-connections"
import { connectAhachatSchema } from "@/features/integration-ahachat/schema/request"

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
vi.mock("sonner", () => ({ toast }))

const routerRefresh = vi.hoisted(() => vi.fn())
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh }),
}))
vi.mock("@/hooks/routing", () => ({ useWorkspaceId: () => "ws-1" }))

const invalidateContactSyncs = vi.hoisted(() => vi.fn())
vi.mock("@/features/contact-sync/hooks/use-invalidate-contact-syncs", () => ({
  useInvalidateContactSyncs: () => invalidateContactSyncs,
}))
vi.mock("@/features/inboxes/provider/inbox-hook", () => ({
  allInboxConfigs: {
    messenger: { label: "Messenger" },
    whatsapp: { label: "WhatsApp" },
  },
}))

vi.mock("@/components/setting-row", () => ({
  SettingRow: ({
    label,
    description,
    children,
  }: {
    label: string
    description: string
    children: React.ReactNode
  }) => (
    <div>
      <span>{label}</span>
      <span>{description}</span>
      {children}
    </div>
  ),
}))

const connectAction = vi.hoisted(() => vi.fn())
const connectBind = vi.hoisted(() => vi.fn((..._args: unknown[]) => ({})))
const disconnectExecute = vi.hoisted(() => vi.fn())
const disconnectBind = vi.hoisted(() =>
  vi.fn((...args: unknown[]) => ({ boundArgs: args })),
)
const disconnectState = vi.hoisted(() => ({ isPending: false }))
type ActionHandlers = {
  onSuccess?: () => void
  onError?: (args: { error: { serverError?: string } }) => void
}
const disconnectHandlers = vi.hoisted(() => ({
  current: {} as ActionHandlers,
}))

vi.mock("@/features/integration-ahachat/actions/connect.action", () => ({
  connectAhachatAction: { bind: connectBind },
}))
vi.mock("@/features/integration-ahachat/actions/disconnect.action", () => ({
  disconnectAhachatAction: { bind: disconnectBind },
}))

// Real react-hook-form with the real zod resolver, wired like the adapter.
vi.mock("@next-safe-action/adapter-react-hook-form/hooks", () => ({
  useHookFormAction: (
    _action: unknown,
    _resolver: unknown,
    props: {
      actionProps: ActionHandlers
      formProps: { defaultValues: { token: string } }
    },
  ) => {
    const form = useForm({
      resolver: zodResolver(connectAhachatSchema),
      defaultValues: props.formProps.defaultValues,
    })
    formSlot.register = (name) => form.register(name)
    return {
      form,
      handleSubmitWithAction: form.handleSubmit(async (values) => {
        try {
          await connectAction(values)
          props.actionProps.onSuccess?.()
        } catch (error) {
          props.actionProps.onError?.({
            error: {
              serverError: error instanceof Error ? error.message : undefined,
            },
          })
        }
      }),
      resetFormAndAction: () => form.reset(),
    }
  },
}))
vi.mock("next-safe-action/hooks", () => ({
  useAction: (action: { boundArgs: unknown[] }, options: ActionHandlers) => {
    disconnectHandlers.current = options
    return {
      execute: () => disconnectExecute(action.boundArgs),
      isPending: disconnectState.isPending,
    }
  },
}))

const DialogContext = createContext<{
  open: boolean
  setOpen: (open: boolean) => void
}>({ open: false, setOpen: () => undefined })

vi.mock("@chatbotx.io/ui/components/ui/dialog", () => ({
  Dialog: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    children: React.ReactNode
  }) => (
    <DialogContext.Provider value={{ open, setOpen: onOpenChange }}>
      {children}
    </DialogContext.Provider>
  ),
  DialogTrigger: ({
    render,
  }: {
    render: React.ReactElement<{ onClick?: () => void }>
  }) => {
    const { setOpen } = useContext(DialogContext)
    return cloneElement(render, { onClick: () => setOpen(true) })
  },
  DialogContent: ({ children }: { children: React.ReactNode }) =>
    useContext(DialogContext).open ? (
      <div data-testid="dialog-content">{children}</div>
    ) : null,
  DialogClose: ({ render }: { render: React.ReactElement }) => render,
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}))

vi.mock("@/features/common/components/disconnect-integration-dialog", () => ({
  DisconnectIntegrationDialog: ({
    featureLabel,
    onConfirm,
    isPending,
    translationKey,
  }: {
    featureLabel: string
    onConfirm: () => void
    isPending: boolean
    translationKey: string
  }) => (
    <div data-key={translationKey} data-testid="disconnect">
      <span>{featureLabel}</span>
      <button disabled={isPending} onClick={onConfirm} type="button">
        confirm-disconnect
      </button>
    </div>
  ),
}))

vi.mock("@chatbotx.io/ui/components/form/input-field", () => ({
  InputField: ({ name, label }: { name: "token"; label: string }) => (
    <FieldProbe label={label} name={name} />
  ),
}))
vi.mock("@chatbotx.io/ui/components/ui/form", () => ({
  Form: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock("@chatbotx.io/ui/components/ui/avatar", () => ({
  Avatar: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AvatarImage: ({ src }: { src: string }) => <span data-src={src} />,
  AvatarFallback: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="avatar-fallback">{children}</span>
  ),
}))
vi.mock("@chatbotx.io/ui/components/ui/badge", () => ({
  Badge: ({
    children,
    variant,
  }: {
    children: React.ReactNode
    variant: string
  }) => (
    <span data-badge data-variant={variant}>
      {children}
    </span>
  ),
}))
vi.mock("@chatbotx.io/ui/components/ui/button", () => ({
  Button: ({
    children,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...rest}>{children}</button>
  ),
  buttonVariants: () => "",
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

// A plain input bound to the form held in this module-level slot: the mocked
// `InputField` needs the same `useForm` the mocked adapter created.
const formSlot = vi.hoisted(() => ({
  register: null as null | ((name: "token") => object),
}))

function FieldProbe({ name, label }: { name: "token"; label: string }) {
  return (
    <input
      aria-label={label}
      data-testid="token-input"
      {...formSlot.register?.(name)}
    />
  )
}

const source = (overrides: Record<string, unknown> = {}) => ({
  connectionId: "c1",
  provider: "ahachat",
  connectionStatus: "connected",
  account: {
    accountId: "page-1",
    channel: "messenger",
    name: "Shop Page",
    avatarUrl: null,
  },
  matchedInboxes: [],
  eligible: true,
  ineligibleReason: null,
  ...overrides,
})

let container: HTMLDivElement | null = null
let root: Root | null = null

function renderConnections(sources: unknown[]) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root?.render(<AhachatConnections sources={sources as never} />)
  })
  // biome-ignore lint/style/noNonNullAssertion: assigned synchronously above
  return container!
}

const buttonWithText = (el: HTMLElement, text: string) =>
  Array.from(el.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(text),
  ) as HTMLButtonElement | undefined

beforeEach(() => {
  connectAction.mockResolvedValue(undefined)
})

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  container = null
  root = null
  disconnectState.isPending = false
  vi.clearAllMocks()
})

describe("AhachatConnections list", () => {
  test("shows the empty state when no page is connected", () => {
    const el = renderConnections([])

    expect(el.textContent).toContain("ahachat.empty")
    expect(el.querySelector('[data-testid="disconnect"]')).toBeNull()
  })

  test("links to the sync history of the workspace", () => {
    const el = renderConnections([])

    const link = el.querySelector('a[href$="/contacts/sync/histories"]')
    expect(link?.textContent).toContain("contactSync.history.open")
    expect(link?.getAttribute("href")).toBe(
      "/space/ws-1/contacts/sync/histories",
    )
  })

  test("a row shows the page name, its channel badge and no reason badge when eligible", () => {
    const el = renderConnections([source()])

    expect(el.textContent).toContain("Shop Page")
    expect(el.textContent).not.toContain("ahachat.empty")
    const badges = Array.from(el.querySelectorAll("[data-badge]"))
    expect(
      badges.map((b) => [b.getAttribute("data-variant"), b.textContent]),
    ).toEqual([["outline", "Messenger"]])
  })

  test("a row with no channel has no channel badge, only the ineligible reason", () => {
    const el = renderConnections([
      source({
        account: {
          accountId: "page-9",
          channel: null,
          name: null,
          avatarUrl: null,
        },
        eligible: false,
        ineligibleReason: "channelUnsupported",
      }),
    ])

    const badges = Array.from(el.querySelectorAll("[data-badge]"))
    expect(
      badges.map((b) => [b.getAttribute("data-variant"), b.textContent]),
    ).toEqual([["secondary", "contactSync.ineligible.channelUnsupported"]])
    // falls back to the account id for the name and its initial for the avatar
    expect(el.textContent).toContain("page-9")
    expect(
      el.querySelector('[data-testid="avatar-fallback"]')?.textContent,
    ).toBe("P")
  })

  test("a row can show both the channel and an ineligible reason badge", () => {
    const el = renderConnections([
      source({
        account: {
          accountId: "waba",
          channel: "whatsapp",
          name: "WA",
          avatarUrl: null,
        },
        eligible: false,
        ineligibleReason: "noMatchingInbox",
      }),
    ])

    const badges = Array.from(el.querySelectorAll("[data-badge]"))
    expect(badges.map((b) => b.textContent)).toEqual([
      "WhatsApp",
      "contactSync.ineligible.noMatchingInbox",
    ])
  })

  test("confirming delete on a row disconnects that row's connection", () => {
    const el = renderConnections([
      source({ connectionId: "c1" }),
      source({
        connectionId: "c2",
        account: {
          accountId: "page-2",
          channel: "messenger",
          name: "Second",
          avatarUrl: null,
        },
      }),
    ])
    const rows = Array.from(el.querySelectorAll('[data-testid="disconnect"]'))
    expect(rows).toHaveLength(2)
    expect(rows[1]?.getAttribute("data-key")).toBe("delete")
    expect(rows[1]?.textContent).toContain("ahachat.title: Second")

    act(() => {
      ;(rows[1]?.querySelector("button") as HTMLButtonElement).click()
    })

    expect(disconnectBind).toHaveBeenCalledWith(null, "ws-1", "c2")
    expect(disconnectExecute).toHaveBeenCalledTimes(1)
    expect(disconnectExecute).toHaveBeenCalledWith([null, "ws-1", "c2"])
  })

  test("a successful disconnect refreshes the sync queries and the page", () => {
    renderConnections([source()])

    act(() => {
      disconnectHandlers.current.onSuccess?.()
    })

    expect(invalidateContactSyncs).toHaveBeenCalledTimes(1)
    expect(routerRefresh).toHaveBeenCalledTimes(1)
  })

  test("a failed disconnect toasts the server error, else the unreachable message", () => {
    renderConnections([source()])

    act(() => {
      disconnectHandlers.current.onError?.({ error: { serverError: "nope" } })
      disconnectHandlers.current.onError?.({ error: {} })
    })

    expect(toast.error).toHaveBeenNthCalledWith(1, "nope")
    expect(toast.error).toHaveBeenNthCalledWith(2, "ahachat.errors.unreachable")
  })

  test("the disconnect button is disabled while the request is pending", () => {
    disconnectState.isPending = true
    const el = renderConnections([source()])

    expect(buttonWithText(el, "confirm-disconnect")?.disabled).toBe(true)
  })
})

describe("Add token dialog", () => {
  const open = (el: HTMLElement) => {
    act(() => {
      buttonWithText(el, "ahachat.addToken")?.click()
    })
  }
  const submit = (el: HTMLElement) =>
    act(async () => {
      buttonWithText(el, "actions.add")?.click()
      await Promise.resolve()
    })
  const type = (el: HTMLElement, value: string) => {
    const input = el.querySelector(
      '[data-testid="token-input"]',
    ) as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set
    act(() => {
      setter?.call(input, value)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
  }

  test("is closed until the Add button is used", () => {
    const el = renderConnections([])

    expect(el.querySelector('[data-testid="dialog-content"]')).toBeNull()
    open(el)
    expect(el.querySelector('[data-testid="dialog-content"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="token-input"]')).not.toBeNull()
  })

  test("a blank token is rejected by validation and nothing is connected", async () => {
    const el = renderConnections([])
    open(el)

    await submit(el)
    type(el, "   ")
    await submit(el)

    expect(connectAction).not.toHaveBeenCalled()
    expect(el.querySelector('[data-testid="dialog-content"]')).not.toBeNull()
  })

  test("a successful add toasts, closes the dialog, refreshes the page and the sync queries", async () => {
    const el = renderConnections([])
    open(el)
    type(el, "  my-token  ")

    await submit(el)

    expect(connectAction).toHaveBeenCalledWith({ token: "my-token" })
    expect(toast.success).toHaveBeenCalledWith(
      `messages.connectedSuccess:${JSON.stringify({ feature: "ahachat.title" })}`,
    )
    expect(el.querySelector('[data-testid="dialog-content"]')).toBeNull()
    expect(invalidateContactSyncs).toHaveBeenCalledTimes(1)
    expect(routerRefresh).toHaveBeenCalledTimes(1)
  })

  test("the dialog can be opened again for another token, starting empty", async () => {
    const el = renderConnections([])
    open(el)
    type(el, "first-token")
    await submit(el)
    expect(el.querySelector('[data-testid="dialog-content"]')).toBeNull()

    open(el)
    const input = el.querySelector(
      '[data-testid="token-input"]',
    ) as HTMLInputElement
    expect(input.value).toBe("")
    type(el, "second-token")
    await submit(el)

    expect(connectAction).toHaveBeenNthCalledWith(1, { token: "first-token" })
    expect(connectAction).toHaveBeenNthCalledWith(2, { token: "second-token" })
    expect(invalidateContactSyncs).toHaveBeenCalledTimes(2)
    expect(routerRefresh).toHaveBeenCalledTimes(2)
  })

  test("a server error toasts it and keeps the dialog open without refreshing", async () => {
    connectAction.mockRejectedValue(new Error("AhaChat is unreachable"))
    const el = renderConnections([])
    open(el)
    type(el, "bad")

    await submit(el)

    expect(toast.error).toHaveBeenCalledWith("AhaChat is unreachable")
    expect(el.querySelector('[data-testid="dialog-content"]')).not.toBeNull()
    expect(routerRefresh).not.toHaveBeenCalled()
    expect(invalidateContactSyncs).not.toHaveBeenCalled()
  })

  test("binds the connect action to the workspace", () => {
    renderConnections([])

    expect(connectBind).toHaveBeenCalledWith(null, "ws-1")
  })
})
