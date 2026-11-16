"use client"

import type { ContactSyncSource } from "@chatbotx.io/business/contact-sync"
import { InputField } from "@chatbotx.io/ui/components/form/input-field"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@chatbotx.io/ui/components/ui/avatar"
import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { Button, buttonVariants } from "@chatbotx.io/ui/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@chatbotx.io/ui/components/ui/dialog"
import { Form } from "@chatbotx.io/ui/components/ui/form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useHookFormAction } from "@next-safe-action/adapter-react-hook-form/hooks"
import { HistoryIcon, Loader2Icon, PlusIcon } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { useState } from "react"
import { toast } from "sonner"
import { SettingRow } from "@/components/setting-row"
import { DisconnectIntegrationDialog } from "@/features/common/components/disconnect-integration-dialog"
import { useContactSyncLabels } from "@/features/contact-sync/hooks/use-contact-sync-labels"
import { useInvalidateContactSyncs } from "@/features/contact-sync/hooks/use-invalidate-contact-syncs"
import { contactSyncHistoryPath } from "@/features/contact-sync/lib/routes"
import { useWorkspaceId } from "@/hooks/routing"
import { connectAhachatAction } from "../actions/connect.action"
import { disconnectAhachatAction } from "../actions/disconnect.action"
import { connectAhachatSchema } from "../schema/request"

export function AhachatConnections({
  sources,
}: {
  sources: ContactSyncSource[]
}) {
  const t = useTranslations()
  const workspaceId = useWorkspaceId()

  return (
    <div className="flex flex-col gap-4">
      <SettingRow
        description={t("ahachat.connect.description")}
        label={t("ahachat.connect.label")}
      >
        <div className="flex flex-wrap gap-2">
          <AddAhachatTokenDialog />
          <Link
            className={buttonVariants({ size: "sm", variant: "outline" })}
            href={contactSyncHistoryPath(workspaceId)}
          >
            <HistoryIcon />
            {t("contactSync.history.open")}
          </Link>
        </div>
      </SettingRow>

      <div className="flex flex-col gap-3">
        {sources.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("ahachat.empty")}</p>
        ) : (
          sources.map((source) => (
            <AhachatSourceRow key={source.connectionId} source={source} />
          ))
        )}
      </div>
    </div>
  )
}

function AddAhachatTokenDialog() {
  const [open, setOpen] = useState(false)
  const workspaceId = useWorkspaceId()
  const router = useRouter()
  const t = useTranslations()
  const invalidateContactSyncs = useInvalidateContactSyncs()

  const { form, handleSubmitWithAction, resetFormAndAction } =
    useHookFormAction(
      connectAhachatAction.bind(null, workspaceId),
      zodResolver(connectAhachatSchema),
      {
        actionProps: {
          onSuccess: () => {
            toast.success(
              t("messages.connectedSuccess", { feature: t("ahachat.title") }),
            )
            setOpen(false)
            resetFormAndAction()
            invalidateContactSyncs()
            router.refresh()
          },
          onError: ({ error }) => {
            if (error.serverError) {
              toast.error(error.serverError)
            }
          },
        },
        formProps: { mode: "onSubmit", defaultValues: { token: "" } },
      },
    )
  const isPending = form.formState.isSubmitting

  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          resetFormAndAction()
        }
      }}
      open={open}
    >
      <DialogTrigger
        render={
          <Button size="sm">
            <PlusIcon />
            {t("ahachat.addToken")}
          </Button>
        }
      />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("ahachat.addToken")}</DialogTitle>
          <DialogDescription>{t("ahachat.tokenHint")}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form className="space-y-4" onSubmit={handleSubmitWithAction}>
            <InputField
              autoComplete="off"
              label={t("ahachat.fields.token")}
              name="token"
              required
              type="password"
            />
            <DialogFooter>
              <DialogClose
                render={
                  <Button disabled={isPending} type="button" variant="outline">
                    {t("actions.cancel")}
                  </Button>
                }
              />
              <Button disabled={isPending} type="submit">
                {isPending && <Loader2Icon className="animate-spin" />}
                {t("actions.add")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}

function AhachatSourceRow({ source }: { source: ContactSyncSource }) {
  const [open, setOpen] = useState(false)
  const workspaceId = useWorkspaceId()
  const router = useRouter()
  const t = useTranslations()
  const invalidateContactSyncs = useInvalidateContactSyncs()
  const labels = useContactSyncLabels()
  const name = source.account.name ?? source.account.accountId

  const { execute, isPending } = useAction(
    disconnectAhachatAction.bind(null, workspaceId, source.connectionId),
    {
      onSuccess: () => {
        setOpen(false)
        invalidateContactSyncs()
        router.refresh()
      },
      onError: ({ error }) => {
        toast.error(error.serverError ?? t("ahachat.errors.unreachable"))
      },
    },
  )

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <Avatar className="size-9 shrink-0">
          {source.account.avatarUrl && (
            <AvatarImage alt={name} src={source.account.avatarUrl} />
          )}
          <AvatarFallback>{name.slice(0, 1).toUpperCase()}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate font-medium text-sm">{name}</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {source.account.channel && (
              <Badge variant="outline">
                {labels.channel(source.account.channel)}
              </Badge>
            )}
            {source.ineligibleReason && (
              <Badge variant="secondary">
                {labels.ineligibleReason(source.ineligibleReason)}
              </Badge>
            )}
          </div>
        </div>
      </div>
      <DisconnectIntegrationDialog
        featureLabel={`${t("ahachat.title")}: ${name}`}
        isPending={isPending}
        onConfirm={() => execute()}
        onOpenChange={setOpen}
        open={open}
        translationKey="delete"
      />
    </div>
  )
}
