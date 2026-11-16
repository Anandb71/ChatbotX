# Contact Sync

Imports contacts — with their tags and custom fields — from an external
system into a workspace, in the background. The first source is **AhaChat**
(one page per broadcast API token). The engine and its tables are
provider-neutral: a new source is one adapter, not a new pipeline.

Entry points: Contacts › Actions › Import › **Sync with AhaChat** (dialog),
Settings › Integrations › **AhaChat** (tokens), and the public API
`contactSyncs.*` (scope `contacts`).

## Guarantees

- **Silent**: nothing a sync creates or changes runs a trigger, flow,
  webhook, tag sync, ads conversion, profile snapshot or any event. New
  contacts are created with `ContactInbox.source = imported`.
- **One live run per workspace** (all providers together), enforced by the
  partial unique index `ContactSyncRun_workspace_live_uq`; at most one chunk
  of a run executes at a time (claim lease).
- **Cooldown**: a new sync may start 4 hours after the latest run that reached
  its source. `schedule` re-reads availability under a per-workspace
  transaction advisory lock, so two requests right after the cooldown cannot
  both start one.
- **Merge rules**: with `overwriteExisting = false` an existing contact only
  gets values it is missing; with `true` source values replace existing ones.
  An empty source value never clears data, and tags are only ever added.
- **Never written**: `lastIncomingMessageAt`, `lastMessageAt`,
  `broadcastSubscribedAt`, `blockedAt` — an import is not an interaction.

## Where it lives

| Layer | Path |
|---|---|
| Tables | `packages/database/src/schema/contact-sync.ts`, `schema/integration-ahachat.ts` |
| Repositories | `packages/database/src/repositories/contact-sync/` (runs, items, mappings); `contactRepository.mergeProfiles` / `linkTags`; `contactCustomFieldRepository.bulkUpsertValues` |
| Service | `packages/business/src/contact-sync/service.ts` (`contactSyncService`) |
| Page importer (worker only) | `@chatbotx.io/business/contact-sync/import` (`importContactSyncPage`) — a separate subpath because it reaches Node-only CSV parsers (invariant 25) |
| Adapters | `packages/business/src/contact-sync/providers/` |
| Engine / sweeper | `apps/worker/src/integration/handlers/contact-sync/engine.ts`, `apps/worker/src/schedule/handlers/scan-contact-sync-runs.ts` |
| Public API | `apps/builder/src/features/contact-sync/api/public.ts` |
| UI | `apps/builder/src/features/contact-sync/`, `features/integration-ahachat/` |
| Integration client | `integrations/ahachat/` |

## Data model

- **`ContactSyncRun`** — one sync: options (`syncTags`, `syncCustomFields`,
  `overwriteExisting`), the lease (`claimToken`, `lastHeartbeatAt`,
  `pausedUntil`), `attempts` and `chunkSeq`. No `.default()`: every insert
  writes every column.
- **`ContactSyncRunItem`** — one source of a run, imported into one inbox,
  processed in `position` order. `cursor` is the source's opaque resume
  point; `upperBoundId` is the snapshot bound fixed when the item starts, so
  each item is a finite set (contacts that appear later wait for the next
  sync). Contact counters: created / updated (existing contacts matched) /
  skipped (no usable identity, or duplicate in a page) / failed.
  `skippedValueCount` counts custom-field values that were not written (a
  mapping to an incompatible type, a value the target type rejects, a field
  deleted during the write, or a second value for a field one contact
  already got — the first one wins); it is per value, not per contact.
- **`ContactSyncMapping`** — source tag/field id → workspace tag/field.
  `manual` rows come from the user; `auto` rows are written by a run with
  `ON CONFLICT DO NOTHING` (never over a manual row) so later runs reuse the
  same target. A deleted field cascades its mapping away; a mapping to a
  soft-deleted tag is removed when read. Either way the next run resolves the
  source id again.
- **`IntegrationAhachat`** — one row per connected token: `encryptedAuth`
  (AES-GCM, AAD `ahachat:{workspaceId}`, via the store binding's
  `authCodec`) and a display snapshot of the page.

## State machine

```
pending ──claim──▶ running ──yield──▶ running (released, chunkSeq+1) ──claim──▶ …
   │                  │  └─ rate limited ─▶ running + pausedUntil (delayed job)
   │                  ├─ all items done ─▶ succeeded | partial | failed
   │                  └─ cancel ─▶ cancelling ─▶ cancelled
   └─ cancel (nobody holds it) ─▶ cancelled
```

A run ends `succeeded` when every item succeeded, `failed` when none made any
progress, otherwise `partial`.

## Chunk contract

- Job: `IntegrationJobAction.contactSync` `{ runId, workspaceId }`, job id
  `contact-sync-<runId>-chunk-<chunkSeq>`. The payload carries no
  instructions; everything is read from the claimed row.
- A chunk reads at most `CONTACT_SYNC_PAGES_PER_CHUNK` pages or
  `CONTACT_SYNC_CHUNK_BUDGET_MS`, then yields and enqueues the next chunk.
- Before every source call the lease is renewed with a fenced write; a lost
  claim stops the worker at once. After each page, cursor and counters are
  written in one fenced write. Once a run is `cancelling`, that write keeps
  the page in flight (its data is already committed) but adds no counters
  and moves no cursor; the worker then settles the run `cancelled`. The
  terminal write reads the row's own status, so a cancel that lands after
  the worker computed its outcome still ends the run `cancelled`.
- Writes lock what they reference until commit: contacts `FOR KEY SHARE`,
  then tags `FOR SHARE` (a soft delete is an update) or fields
  `FOR KEY SHARE`. A contact, tag or field deleted meanwhile is skipped
  instead of failing a foreign key. Tag links and field values are inserted
  in chunks, below Postgres' bind-parameter limit.
- Each source call has one deadline covering the connection, the headers
  and the body.
- Error handling (adapter `classifyError`): `rateLimited` → park with
  `pausedUntil` and a delayed job (`Retry-After` in whole seconds, else one
  minute; capped); `retryable` (timeout, network, 5xx) → the job fails and the
  sweeper retries after the lease goes stale, at most
  `CONTACT_SYNC_MAX_ATTEMPTS` times (an outage: 3 failed tries in a row in
  all), then the run ends `failed`. A re-dispatch of a lost enqueue also
  counts; a chunk still waiting in the queue (or running) does not, and is
  never failed before it runs; nor is a run whose queue cannot be read. Recorded progress and a rate-limit pause reset the count; `tokenInvalid` → the item fails and the connection
  moves to `needs_reauth`; `fatal` → the item fails. Other items continue.
  An item whose pages had rows breaking the source contract ends `partial`.
- A page must keep the paging contract: "more" comes with rows and a next
  cursor, which moves forward without passing the snapshot bound; otherwise the
  response is invalid (`fatal`). With tag and field sync both off, the source
  schema is not fetched.
- **Replay** (crash, takeover, cancel mid-chunk) is safe: contact creation,
  profile merges, tag links, field values and mappings all converge.
  Quota/usage grow only by contacts actually created. Accepted risk: a
  worker dying between committing contacts and incrementing the counters
  leaves the informational `contacts` counter short by at most one page (same
  window as file import and contact scan).
- Sweeper (`scanContactSyncRuns`, every minute): fails runs out of attempts,
  re-dispatches a `pending` run whose enqueue was lost, a stale lease, or a
  released continuation never re-claimed; a chunk still queued gets its
  attempt refunded.
- Disconnecting a source cancels the live run reading from it, inside the
  disconnect transaction (`contactSyncConnectionTeardownHook`, in
  `@chatbotx.io/connections`).

## Fields

Basic contact fields go to `Contact` columns through one table,
`contactSyncProfileFields` (`profile-fields.ts`): first/last name (full name
when there is no split name, max 100), gender, phone (E.164 with the
workspace country), email, avatar (https only), locale, timezone (`±HH:MM`),
ref, country, state, city, location (valid coordinates). Identity
(`ContactInbox.sourceId` / `sourceUserId`) is resolved separately per
channel (`resolveContactSyncIdentity`); a WhatsApp user without a phone is
keyed by the BSUID, as manual creation does.

Custom fields: an unmapped source field reuses a workspace field of the same
name and default type, or gets a new `<name> copy` field when the name is
taken by another type (`resolveByNameAndType({ renameStyle: "copy" })`).
A `<name> copy` (or `copy N`) of the same type that already exists is
reused, so a second source or a later run never adds `copy 2`.
`externalFieldTypeTargets` (`field-type.ts`) lists the compatible types; a
mapping to an incompatible type is shown with a warning and its values are
skipped (counted in `skippedValueCount`, as are values the target type
rejects — they are never truncated or coerced). Values go through the same
normalizers as file import.

## Adding a provider

1. Add its value to `contactSyncProviders` and a migration for the enum.
2. Implement `ContactSyncAdapter` (`types.ts`) in `providers/<name>.ts` —
   `listAccounts`, `listSchema`, `readSnapshotBound`, `listRecords`,
   `classifyError` — and register it in `providers/index.ts` (a missing one
   is a compile error).
3. Connect its credentials through the Connection engine (an
   `integrations/<name>` package with a `connection` block, an
   `integrationTypes` value, a store binding with an `authCodec` for
   secrets) and wire `contactSyncConnectionTeardownHook` as its teardown.

## Adding a channel

Map the source's channel to a `ChannelType` in the adapter, add an identity
rule to `IDENTITY_RESOLVERS` (`profile-fields.ts`) and, when the inbox is
not found by `Inbox.sourceId`, an entry in `INBOX_MATCHERS`
(`inbox-match.ts`). Verify with real data that the source's user ids equal
the workspace's `ContactInbox.sourceId` before enabling it.

## Configuration

`AHACHAT_API_BASE_URL` (builder and worker, optional): the https base URL of
the AhaChat contact API, path included, set by the operator. Unset, the
AhaChat integration in Settings and "Sync with AhaChat" in Contacts are hidden,
and tokens cannot be connected or synced.

## Public API

| Operation | Route |
|---|---|
| `contactSyncs.listSources` | `GET /v1/contact-syncs/sources` |
| `contactSyncs.getSchema` | `GET /v1/contact-syncs/sources/{connectionId}/schema` |
| `contactSyncs.saveMappings` | `PUT /v1/contact-syncs/sources/{connectionId}/mappings` |
| `contactSyncs.getAvailability` | `GET /v1/contact-syncs/availability` |
| `contactSyncs.create` | `POST /v1/contact-syncs` (202) |
| `contactSyncs.list` | `GET /v1/contact-syncs` |
| `contactSyncs.get` | `GET /v1/contact-syncs/{runId}` |
| `contactSyncs.cancel` | `POST /v1/contact-syncs/{runId}/cancel` |

Tokens are connected with `connections.create` (`provider: "ahachat"`,
`config: { token }`) and removed with `connections.delete`.

Errors carry machine-readable `data`:

| Code | Status | `data` |
|---|---|---|
| `contactSyncMappingInvalid` | 422 | every refused row, `{"tag:12": "targetNotFound"}` |
| `contactSyncAlreadyRunning` | 409 | `{ runId }` of the live run |
| `contactSyncCooldown` | 409 | `{ nextSyncAt }` (ISO 8601) |

Cancelling stays allowed on a trial-expired workspace, like the builder's
cancel action; a `read_only` token still cannot call it.
