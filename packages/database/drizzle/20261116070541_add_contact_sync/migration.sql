CREATE TYPE "contactSyncMappingKind" AS ENUM('tag', 'customField');--> statement-breakpoint
CREATE TYPE "contactSyncMappingOrigin" AS ENUM('manual', 'auto');--> statement-breakpoint
CREATE TYPE "contactSyncProvider" AS ENUM('ahachat');--> statement-breakpoint
CREATE TYPE "contactSyncRunItemStatus" AS ENUM('pending', 'running', 'succeeded', 'partial', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "contactSyncRunStatus" AS ENUM('pending', 'running', 'cancelling', 'succeeded', 'partial', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "contactSyncTriggerSource" AS ENUM('app', 'api');--> statement-breakpoint
CREATE TYPE "ahachatChannel" AS ENUM('messenger', 'instagram', 'zalo', 'google_business_message', 'whatsapp', 'telegram');--> statement-breakpoint
CREATE TABLE "ContactSyncMapping" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"integrationId" bigint NOT NULL,
	"kind" "contactSyncMappingKind" NOT NULL,
	"externalId" text NOT NULL,
	"externalName" text NOT NULL,
	"tagId" bigint,
	"customFieldId" bigint,
	"origin" "contactSyncMappingOrigin" NOT NULL,
	CONSTRAINT "ContactSyncMapping_target_check" CHECK (("kind" = 'tag' AND "tagId" IS NOT NULL AND "customFieldId" IS NULL) OR ("kind" = 'customField' AND "customFieldId" IS NOT NULL AND "tagId" IS NULL)),
	CONSTRAINT "ContactSyncMapping_external_check" CHECK (btrim("externalId") <> '' AND btrim("externalName") <> '')
);
--> statement-breakpoint
CREATE TABLE "ContactSyncRunItem" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"runId" bigint NOT NULL,
	"workspaceId" bigint NOT NULL,
	"integrationId" bigint,
	"inboxId" bigint,
	"sourceAccountName" text,
	"position" integer NOT NULL,
	"status" "contactSyncRunItemStatus" NOT NULL,
	"cursor" text,
	"upperBoundId" text,
	"createdCount" integer NOT NULL,
	"updatedCount" integer NOT NULL,
	"skippedCount" integer NOT NULL,
	"failedCount" integer NOT NULL,
	"skippedValueCount" integer NOT NULL,
	"currentError" text,
	"startedAt" timestamp(6) with time zone,
	"finishedAt" timestamp(6) with time zone
);
--> statement-breakpoint
CREATE TABLE "ContactSyncRun" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"provider" "contactSyncProvider" NOT NULL,
	"status" "contactSyncRunStatus" NOT NULL,
	"triggerSource" "contactSyncTriggerSource" NOT NULL,
	"requestedByUserId" bigint,
	"syncTags" boolean NOT NULL,
	"syncCustomFields" boolean NOT NULL,
	"overwriteExisting" boolean NOT NULL,
	"startedAt" timestamp(6) with time zone,
	"finishedAt" timestamp(6) with time zone,
	"lastHeartbeatAt" timestamp(6) with time zone,
	"pausedUntil" timestamp(6) with time zone,
	"claimToken" text,
	"attempts" integer NOT NULL,
	"chunkSeq" integer NOT NULL,
	"currentError" text
);
--> statement-breakpoint
CREATE TABLE "IntegrationAhachat" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"integrationId" bigint NOT NULL,
	"encryptedAuth" jsonb NOT NULL,
	"sourceChannel" "ahachatChannel" NOT NULL,
	"sourceAccountId" text NOT NULL,
	"sourceAccountName" text,
	"sourceAvatarUrl" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ContactSyncMapping_integration_kind_externalId_key" ON "ContactSyncMapping" ("integrationId","kind","externalId");--> statement-breakpoint
CREATE INDEX "ContactSyncMapping_workspaceId_idx" ON "ContactSyncMapping" ("workspaceId");--> statement-breakpoint
CREATE INDEX "ContactSyncMapping_tagId_idx" ON "ContactSyncMapping" ("tagId") WHERE "tagId" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ContactSyncMapping_customFieldId_idx" ON "ContactSyncMapping" ("customFieldId") WHERE "customFieldId" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ContactSyncRunItem_runId_position_key" ON "ContactSyncRunItem" ("runId","position");--> statement-breakpoint
CREATE INDEX "ContactSyncRunItem_workspaceId_idx" ON "ContactSyncRunItem" ("workspaceId");--> statement-breakpoint
CREATE INDEX "ContactSyncRunItem_integrationId_idx" ON "ContactSyncRunItem" ("integrationId") WHERE "integrationId" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ContactSyncRunItem_inboxId_idx" ON "ContactSyncRunItem" ("inboxId") WHERE "inboxId" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ContactSyncRun_workspace_live_uq" ON "ContactSyncRun" ("workspaceId") WHERE status IN ('pending', 'running', 'cancelling');--> statement-breakpoint
CREATE INDEX "ContactSyncRun_workspace_createdAt_idx" ON "ContactSyncRun" ("workspaceId","createdAt" DESC);--> statement-breakpoint
CREATE INDEX "ContactSyncRun_live_idx" ON "ContactSyncRun" ("status","lastHeartbeatAt") WHERE status IN ('pending', 'running', 'cancelling');--> statement-breakpoint
CREATE INDEX "ContactSyncRun_requestedByUserId_idx" ON "ContactSyncRun" ("requestedByUserId") WHERE "requestedByUserId" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "IntegrationAhachat_integrationId_key" ON "IntegrationAhachat" ("integrationId");--> statement-breakpoint
CREATE INDEX "IntegrationAhachat_workspaceId_idx" ON "IntegrationAhachat" ("workspaceId");--> statement-breakpoint
ALTER TABLE "ContactSyncMapping" ADD CONSTRAINT "ContactSyncMapping_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ContactSyncMapping" ADD CONSTRAINT "ContactSyncMapping_integrationId_Integration_id_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ContactSyncMapping" ADD CONSTRAINT "ContactSyncMapping_tagId_Tag_id_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ContactSyncMapping" ADD CONSTRAINT "ContactSyncMapping_customFieldId_CustomField_id_fkey" FOREIGN KEY ("customFieldId") REFERENCES "CustomField"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ContactSyncRunItem" ADD CONSTRAINT "ContactSyncRunItem_runId_ContactSyncRun_id_fkey" FOREIGN KEY ("runId") REFERENCES "ContactSyncRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ContactSyncRunItem" ADD CONSTRAINT "ContactSyncRunItem_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ContactSyncRunItem" ADD CONSTRAINT "ContactSyncRunItem_integrationId_Integration_id_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE SET NULL ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ContactSyncRunItem" ADD CONSTRAINT "ContactSyncRunItem_inboxId_Inbox_id_fkey" FOREIGN KEY ("inboxId") REFERENCES "Inbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ContactSyncRun" ADD CONSTRAINT "ContactSyncRun_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ContactSyncRun" ADD CONSTRAINT "ContactSyncRun_requestedByUserId_User_id_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "IntegrationAhachat" ADD CONSTRAINT "IntegrationAhachat_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "IntegrationAhachat" ADD CONSTRAINT "IntegrationAhachat_integrationId_Integration_id_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;