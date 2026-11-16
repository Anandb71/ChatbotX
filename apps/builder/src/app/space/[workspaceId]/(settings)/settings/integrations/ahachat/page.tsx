import { contactSyncService } from "@chatbotx.io/business"
import { isAhachatConfigured } from "@chatbotx.io/integration-ahachat"
import { getIdFromParams } from "@chatbotx.io/utils"
import { notFound } from "next/navigation"
import { AhachatConnections } from "@/features/integration-ahachat/components/ahachat-connections"

export default async function SettingsIntegrationAhachatPage(props: {
  params: Promise<{ workspaceId: string }>
}) {
  const workspaceId = getIdFromParams(await props.params, "workspaceId")
  // Not configured on this deployment: the integration does not exist here.
  if (!(workspaceId && isAhachatConfigured())) {
    return notFound()
  }

  const sources = await contactSyncService.listSources({
    workspaceId,
    provider: "ahachat",
  })

  return <AhachatConnections sources={sources} />
}
