import "server-only"

import { isAhachatConfigured } from "@chatbotx.io/integration-ahachat"

/**
 * Integration rows that exist only when the operator configured them, by
 * `INTEGRATION_SETTINGS_REGISTRY` slug. Read on the server (environment), so
 * the client never sees the configuration itself, only which rows to hide.
 */
const OPERATOR_CONFIGURED_INTEGRATIONS: Readonly<
  Record<string, () => boolean>
> = {
  ahachat: isAhachatConfigured,
}

/** Slugs of the registry rows to hide because their configuration is missing. */
export const listUnavailableIntegrationSlugs = (): string[] =>
  Object.entries(OPERATOR_CONFIGURED_INTEGRATIONS).flatMap(
    ([slug, isConfigured]) => (isConfigured() ? [] : [slug]),
  )
