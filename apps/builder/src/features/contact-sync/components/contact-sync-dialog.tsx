"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Checkbox } from "@chatbotx.io/ui/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@chatbotx.io/ui/components/ui/dialog"
import { Label } from "@chatbotx.io/ui/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@chatbotx.io/ui/components/ui/select"
import { Switch } from "@chatbotx.io/ui/components/ui/switch"
import { useQuery } from "@tanstack/react-query"
import { Loader2Icon } from "lucide-react"
import Link from "next/link"
import { useFormatter, useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { type ReactElement, useState } from "react"
import { toast } from "sonner"
import type { z } from "zod"
import { useInvalidateContacts } from "@/features/contacts/hooks/use-contacts"
import { useInvalidateCustomFields } from "@/features/custom-fields/provider/custom-field-hook"
import { useInvalidateTags } from "@/features/tags/provider/tag-hook"
import { orpc } from "@/lib/orpc/query"
import { startContactSyncAction } from "../actions/contact-sync.action"
import { useContactSyncLabels } from "../hooks/use-contact-sync-labels"
import { useInvalidateContactSyncs } from "../hooks/use-invalidate-contact-syncs"
import type { contactSyncSourceResource } from "../schema/public"
import { ContactSyncMapping } from "./contact-sync-mapping"
import { ContactSyncProgress } from "./contact-sync-progress"

type ContactSyncSource = z.infer<typeof contactSyncSourceResource>

type Options = {
  syncTags: boolean
  syncCustomFields: boolean
  overwriteExisting: boolean
}

const OPTION_KEYS = {
  syncTags: "contactSync.options.syncTags",
  syncCustomFields: "contactSync.options.syncCustomFields",
  overwriteExisting: "contactSync.options.overwriteExisting",
} as const satisfies Record<keyof Options, string>

const DEFAULT_OPTIONS: Options = {
  syncTags: true,
  syncCustomFields: true,
  overwriteExisting: false,
}

function SourceRow({
  source,
  selected,
  inboxId,
  onToggle,
  onInboxChange,
}: {
  source: ContactSyncSource
  selected: boolean
  inboxId: string | undefined
  onToggle: (selected: boolean) => void
  onInboxChange: (inboxId: string) => void
}) {
  const t = useTranslations()
  const labels = useContactSyncLabels()
  const checkboxId = `contact-sync-source-${source.connectionId}`
  const [onlyInbox] = source.matchedInboxes
  const needsInboxChoice = source.matchedInboxes.length > 1
  const inboxLabel = needsInboxChoice
    ? t("contactSync.source.chooseInbox")
    : onlyInbox?.name
  const targetLabel = source.ineligibleReason
    ? labels.ineligibleReason(source.ineligibleReason)
    : inboxLabel

  return (
    <li className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex items-start gap-3">
        <Checkbox
          checked={selected}
          disabled={!source.eligible}
          id={checkboxId}
          onCheckedChange={(checked) => onToggle(checked === true)}
        />
        <Label
          className="flex min-w-0 flex-col items-start gap-1"
          htmlFor={checkboxId}
        >
          <span className="truncate">
            {source.account.name ?? source.account.accountId}
          </span>
          <span className="font-normal text-muted-foreground text-xs">
            {source.account.channel &&
              `${labels.channel(source.account.channel)} → `}
            {targetLabel}
          </span>
        </Label>
      </div>
      {selected && needsInboxChoice && (
        <Select
          items={source.matchedInboxes.map((inbox) => ({
            value: inbox.id,
            label: inbox.name,
          }))}
          onValueChange={(next) => next && onInboxChange(String(next))}
          value={inboxId ?? ""}
        >
          <SelectTrigger
            aria-label={t("contactSync.source.chooseInbox")}
            className="w-full"
          >
            <SelectValue placeholder={t("contactSync.source.chooseInbox")} />
          </SelectTrigger>
          <SelectContent>
            {source.matchedInboxes.map((inbox) => (
              <SelectItem key={inbox.id} value={inbox.id}>
                {inbox.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </li>
  )
}

function SyncForm({
  workspaceId,
  sources,
  onStarted,
}: {
  workspaceId: string
  sources: ContactSyncSource[]
  onStarted: (runId: string) => void
}) {
  const t = useTranslations()
  const [selected, setSelected] = useState<Record<string, string | undefined>>(
    {},
  )
  const [options, setOptions] = useState<Options>(DEFAULT_OPTIONS)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const start = useAction(startContactSyncAction.bind(null, workspaceId), {
    onSuccess: ({ data }) => data && onStarted(data.runId),
    onError: ({ error }) => {
      toast.error(
        error.validationErrors?._errors?.[0] ??
          error.serverError ??
          t("contactSync.errors.generic"),
      )
    },
  })

  const sourceById = new Map(
    sources.map((source) => [source.connectionId, source] as const),
  )
  const selectedIds = Object.keys(selected)
  const missingInbox = selectedIds.some(
    (connectionId) =>
      (sourceById.get(connectionId)?.matchedInboxes.length ?? 0) > 1 &&
      !selected[connectionId],
  )

  const toggle = (connectionId: string, isSelected: boolean) =>
    setSelected((current) => {
      const { [connectionId]: _removed, ...rest } = current
      return isSelected ? { ...current, [connectionId]: undefined } : rest
    })

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto">
        {sources.map((source) => (
          <SourceRow
            inboxId={selected[source.connectionId]}
            key={source.connectionId}
            onInboxChange={(inboxId) =>
              setSelected((current) => ({
                ...current,
                [source.connectionId]: inboxId,
              }))
            }
            onToggle={(isSelected) => toggle(source.connectionId, isSelected)}
            selected={source.connectionId in selected}
            source={source}
          />
        ))}
      </ul>

      <div className="flex flex-col gap-3">
        {(Object.keys(OPTION_KEYS) as (keyof Options)[]).map((key) => (
          <div className="flex items-center justify-between gap-3" key={key}>
            <Label htmlFor={`contact-sync-${key}`}>{t(OPTION_KEYS[key])}</Label>
            <Switch
              checked={options[key]}
              id={`contact-sync-${key}`}
              onCheckedChange={(checked) =>
                setOptions((current) => ({ ...current, [key]: checked }))
              }
            />
          </div>
        ))}
        <p className="text-muted-foreground text-xs">
          {t("contactSync.options.hint")}
        </p>
      </div>

      {selectedIds.length > 0 &&
        (options.syncTags || options.syncCustomFields) && (
          <div className="flex flex-col gap-3">
            <button
              className="self-start text-primary text-sm underline-offset-4 hover:underline"
              onClick={() => setShowAdvanced((value) => !value)}
              type="button"
            >
              {t(
                showAdvanced
                  ? "contactSync.advanced.hide"
                  : "contactSync.advanced.show",
              )}
            </button>
            {showAdvanced &&
              selectedIds.map((connectionId) => {
                const source = sourceById.get(connectionId)
                return (
                  <section className="rounded-md border p-3" key={connectionId}>
                    <h3 className="mb-3 font-medium text-sm">
                      {source?.account.name ?? source?.account.accountId}
                    </h3>
                    <ContactSyncMapping
                      connectionId={connectionId}
                      workspaceId={workspaceId}
                    />
                  </section>
                )
              })}
          </div>
        )}

      <div className="flex justify-end">
        <Button
          disabled={selectedIds.length === 0 || missingInbox || start.isPending}
          onClick={() =>
            start.execute({
              ...options,
              sources: selectedIds.map((connectionId) => ({
                connectionId,
                ...(selected[connectionId] && {
                  inboxId: selected[connectionId],
                }),
              })),
            })
          }
        >
          {start.isPending && <Loader2Icon className="animate-spin" />}
          {t("contactSync.start")}
        </Button>
      </div>
    </div>
  )
}

/** "Sync with AhaChat" from the contacts Import menu. */
export function ContactSyncDialog({
  workspaceId,
  trigger,
}: {
  workspaceId: string
  trigger: ReactElement
}) {
  const t = useTranslations()
  const format = useFormatter()
  const refresh = useInvalidateContactSyncs()
  const invalidateContacts = useInvalidateContacts()
  const invalidateTags = useInvalidateTags()
  const invalidateCustomFields = useInvalidateCustomFields()
  const [open, setOpen] = useState(false)
  const [runId, setRunId] = useState<string | null>(null)

  const availability = useQuery(
    orpc.contactSyncAPIs.getAvailability.queryOptions({
      input: { workspaceId },
      enabled: open,
    }),
  )
  const sources = useQuery(
    orpc.contactSyncAPIs.listSources.queryOptions({
      input: { workspaceId },
      enabled: open,
    }),
  )

  const activeRunId = runId ?? availability.data?.activeRunId ?? null
  const isLoading = availability.isPending || sources.isPending
  const isError = availability.isError || sources.isError

  const renderBody = () => {
    if (isLoading) {
      return (
        <div className="flex justify-center py-8">
          <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
        </div>
      )
    }
    if (isError) {
      return (
        <div className="flex flex-col items-start gap-2 text-sm">
          <p className="text-destructive">{t("contactSync.errors.generic")}</p>
          <Button onClick={refresh} size="sm" variant="outline">
            {t("actions.retry")}
          </Button>
        </div>
      )
    }
    if (activeRunId) {
      return (
        <ContactSyncProgress
          onSettled={() => {
            setRunId(null)
            setOpen(false)
            // A sync may have created tags and custom fields as well.
            invalidateContacts()
            invalidateTags()
            invalidateCustomFields()
            refresh()
          }}
          runId={activeRunId}
          workspaceId={workspaceId}
        />
      )
    }
    if (
      availability.data?.blockedReason === "cooldown" &&
      availability.data.nextSyncAt
    ) {
      return (
        <p className="text-sm">
          {t("contactSync.cooldown", {
            time: format.dateTime(availability.data.nextSyncAt, {
              dateStyle: "medium",
              timeStyle: "short",
            }),
          })}
        </p>
      )
    }
    if ((sources.data?.data.length ?? 0) === 0) {
      return (
        <div className="flex flex-col items-start gap-3 text-sm">
          <p className="text-muted-foreground">{t("contactSync.empty")}</p>
          <Button
            render={
              <Link
                href={`/space/${workspaceId}/settings/integrations/ahachat`}
              >
                {t("contactSync.goToSettings")}
              </Link>
            }
            size="sm"
            variant="outline"
          />
        </div>
      )
    }
    return (
      <SyncForm
        onStarted={(id) => {
          setRunId(id)
          refresh()
        }}
        sources={sources.data?.data ?? []}
        workspaceId={workspaceId}
      />
    )
  }

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={trigger} />
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("contactSync.title")}</DialogTitle>
          <DialogDescription>{t("contactSync.description")}</DialogDescription>
        </DialogHeader>
        {renderBody()}
      </DialogContent>
    </Dialog>
  )
}
