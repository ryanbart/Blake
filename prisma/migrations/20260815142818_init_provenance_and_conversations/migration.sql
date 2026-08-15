-- CreateEnum
CREATE TYPE "ActorKind" AS ENUM ('human', 'ai_agent', 'system', 'integration');

-- CreateEnum
CREATE TYPE "ActionType" AS ENUM ('crm_field_update', 'crm_task', 'crm_activity_log', 'email_followup', 'internal_notification');

-- CreateEnum
CREATE TYPE "ActionStatus" AS ENUM ('draft', 'pending_approval', 'approved', 'scheduled', 'executing', 'succeeded', 'failed', 'rejected', 'cancelled', 'reverted');

-- CreateEnum
CREATE TYPE "PolicyDecision" AS ENUM ('require_approval', 'auto_execute', 'auto_execute_after_delay');

-- CreateEnum
CREATE TYPE "ConversationSource" AS ENUM ('dialpad', 'fellow');

-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('inbound', 'outbound', 'internal');

-- CreateEnum
CREATE TYPE "TranscriptStatus" AS ENUM ('pending', 'available', 'unavailable', 'failed');

-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('pending', 'skipped', 'analyzed', 'failed');

-- CreateEnum
CREATE TYPE "SpeakerRole" AS ENUM ('agent', 'customer', 'unknown');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('low', 'medium', 'high', 'critical');

-- CreateEnum
CREATE TYPE "RuleTarget" AS ENUM ('agent', 'customer', 'any');

-- CreateEnum
CREATE TYPE "MatchMethod" AS ENUM ('email', 'phone', 'domain', 'manual');

-- CreateEnum
CREATE TYPE "WritePolicy" AS ENUM ('suggest_only', 'never');

-- CreateTable
CREATE TABLE "Actor" (
    "id" TEXT NOT NULL,
    "kind" "ActorKind" NOT NULL,
    "displayName" TEXT NOT NULL,
    "agentId" TEXT,
    "model" TEXT,
    "promptVersion" TEXT,
    "integration" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Actor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Action" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT,
    "actionType" "ActionType" NOT NULL,
    "status" "ActionStatus" NOT NULL DEFAULT 'pending_approval',
    "payload" JSONB NOT NULL,
    "proposedByActorId" TEXT NOT NULL,
    "authorizedByActorId" TEXT,
    "executedByActorId" TEXT,
    "policyDecision" "PolicyDecision",
    "confidence" DOUBLE PRECISION,
    "sourceQuote" TEXT,
    "rationale" TEXT,
    "scheduledFor" TIMESTAMP(3),
    "externalId" TEXT,
    "error" TEXT,
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "reviewedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),

    CONSTRAINT "Action_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutonomyPolicy" (
    "id" TEXT NOT NULL,
    "actionType" "ActionType" NOT NULL,
    "decision" "PolicyDecision" NOT NULL DEFAULT 'require_approval',
    "delaySeconds" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "minConfidence" DOUBLE PRECISION,
    "customerFacing" BOOLEAN NOT NULL DEFAULT false,
    "maxPerHour" INTEGER NOT NULL DEFAULT 60,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutonomyPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "actionId" TEXT,
    "proposedByActorId" TEXT,
    "authorizedByActorId" TEXT,
    "executedByActorId" TEXT,
    "eventType" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "beforeValue" JSONB,
    "afterValue" JSONB,
    "policyDecision" "PolicyDecision",
    "correlationId" TEXT,
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "team" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "dialpadUserId" TEXT,
    "fellowUserId" TEXT,
    "salesforceUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "source" "ConversationSource" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "title" TEXT,
    "direction" "Direction" NOT NULL DEFAULT 'outbound',
    "agentId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "durationSec" INTEGER NOT NULL DEFAULT 0,
    "recordingUrl" TEXT,
    "externalUrl" TEXT,
    "disposition" TEXT,
    "dispositionNotes" TEXT,
    "transcriptStatus" "TranscriptStatus" NOT NULL DEFAULT 'pending',
    "analysisStatus" "AnalysisStatus" NOT NULL DEFAULT 'pending',
    "providerSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Participant" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "isExternal" BOOLEAN NOT NULL DEFAULT false,
    "role" TEXT,

    CONSTRAINT "Participant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TranscriptSegment" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "speakerRole" "SpeakerRole" NOT NULL DEFAULT 'unknown',
    "speakerName" TEXT,
    "startMs" INTEGER NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "TranscriptSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Analysis" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "producedByActorId" TEXT NOT NULL,
    "overallScore" DOUBLE PRECISION,
    "sentiment" TEXT,
    "summary" TEXT,
    "tokensUsed" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Analysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RubricDimension" (
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "RubricDimension_pkey" PRIMARY KEY ("slug")
);

-- CreateTable
CREATE TABLE "ScoreItem" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "dimensionSlug" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "evidenceQuote" TEXT,
    "rationale" TEXT,

    CONSTRAINT "ScoreItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Flag" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "producedByActorId" TEXT NOT NULL,
    "severity" "Severity" NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "quote" TEXT,
    "segmentId" TEXT,
    "ruleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Flag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingOpportunity" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "agentId" TEXT,
    "skillSlug" TEXT NOT NULL,
    "priority" "Severity" NOT NULL DEFAULT 'medium',
    "suggestion" TEXT NOT NULL,
    "exampleQuote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrainingOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Theme" (
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Theme_pkey" PRIMARY KEY ("slug")
);

-- CreateTable
CREATE TABLE "ConversationTheme" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "themeSlug" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "sentiment" TEXT,
    "quote" TEXT,

    CONSTRAINT "ConversationTheme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "pattern" TEXT NOT NULL,
    "isRegex" BOOLEAN NOT NULL DEFAULT false,
    "caseSensitive" BOOLEAN NOT NULL DEFAULT false,
    "appliesTo" "RuleTarget" NOT NULL DEFAULT 'any',
    "category" TEXT NOT NULL,
    "severity" "Severity" NOT NULL DEFAULT 'medium',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngestRun" (
    "id" TEXT NOT NULL,
    "source" "ConversationSource" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "windowStart" TIMESTAMP(3),
    "windowEnd" TIMESTAMP(3),
    "seen" INTEGER NOT NULL DEFAULT 0,
    "added" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "IngestRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesforceConnection" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "instanceUrl" TEXT NOT NULL,
    "encryptedRefreshToken" TEXT NOT NULL,
    "scopes" TEXT,
    "sfUserId" TEXT,
    "sfOrgId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesforceConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmLink" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "contactId" TEXT,
    "leadId" TEXT,
    "accountId" TEXT,
    "opportunityId" TEXT,
    "matchMethod" "MatchMethod",
    "confidence" DOUBLE PRECISION,
    "resolvedByActorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmFieldMapping" (
    "id" TEXT NOT NULL,
    "attributeKey" TEXT NOT NULL,
    "sObject" TEXT NOT NULL,
    "fieldName" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "writePolicy" "WritePolicy" NOT NULL DEFAULT 'suggest_only',
    "sensitive" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmFieldMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Actor_agentId_key" ON "Actor"("agentId");

-- CreateIndex
CREATE INDEX "Actor_kind_idx" ON "Actor"("kind");

-- CreateIndex
CREATE INDEX "Actor_model_promptVersion_idx" ON "Actor"("model", "promptVersion");

-- CreateIndex
CREATE INDEX "Action_status_actionType_idx" ON "Action"("status", "actionType");

-- CreateIndex
CREATE INDEX "Action_conversationId_idx" ON "Action"("conversationId");

-- CreateIndex
CREATE INDEX "Action_proposedByActorId_idx" ON "Action"("proposedByActorId");

-- CreateIndex
CREATE INDEX "Action_createdAt_idx" ON "Action"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AutonomyPolicy_actionType_key" ON "AutonomyPolicy"("actionType");

-- CreateIndex
CREATE INDEX "AuditEvent_createdAt_idx" ON "AuditEvent"("createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_eventType_idx" ON "AuditEvent"("eventType");

-- CreateIndex
CREATE INDEX "AuditEvent_correlationId_idx" ON "AuditEvent"("correlationId");

-- CreateIndex
CREATE INDEX "AuditEvent_actionId_idx" ON "AuditEvent"("actionId");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_email_key" ON "Agent"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_dialpadUserId_key" ON "Agent"("dialpadUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_fellowUserId_key" ON "Agent"("fellowUserId");

-- CreateIndex
CREATE INDEX "Conversation_startedAt_idx" ON "Conversation"("startedAt");

-- CreateIndex
CREATE INDEX "Conversation_agentId_startedAt_idx" ON "Conversation"("agentId", "startedAt");

-- CreateIndex
CREATE INDEX "Conversation_analysisStatus_idx" ON "Conversation"("analysisStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_source_sourceId_key" ON "Conversation"("source", "sourceId");

-- CreateIndex
CREATE INDEX "Participant_conversationId_idx" ON "Participant"("conversationId");

-- CreateIndex
CREATE INDEX "Participant_email_idx" ON "Participant"("email");

-- CreateIndex
CREATE INDEX "Participant_phone_idx" ON "Participant"("phone");

-- CreateIndex
CREATE INDEX "TranscriptSegment_conversationId_startMs_idx" ON "TranscriptSegment"("conversationId", "startMs");

-- CreateIndex
CREATE UNIQUE INDEX "Analysis_conversationId_key" ON "Analysis"("conversationId");

-- CreateIndex
CREATE INDEX "Analysis_producedByActorId_idx" ON "Analysis"("producedByActorId");

-- CreateIndex
CREATE UNIQUE INDEX "ScoreItem_analysisId_dimensionSlug_key" ON "ScoreItem"("analysisId", "dimensionSlug");

-- CreateIndex
CREATE INDEX "Flag_conversationId_idx" ON "Flag"("conversationId");

-- CreateIndex
CREATE INDEX "Flag_severity_idx" ON "Flag"("severity");

-- CreateIndex
CREATE INDEX "Flag_category_idx" ON "Flag"("category");

-- CreateIndex
CREATE INDEX "TrainingOpportunity_agentId_idx" ON "TrainingOpportunity"("agentId");

-- CreateIndex
CREATE INDEX "TrainingOpportunity_skillSlug_idx" ON "TrainingOpportunity"("skillSlug");

-- CreateIndex
CREATE INDEX "ConversationTheme_themeSlug_idx" ON "ConversationTheme"("themeSlug");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationTheme_conversationId_themeSlug_key" ON "ConversationTheme"("conversationId", "themeSlug");

-- CreateIndex
CREATE INDEX "IngestRun_source_startedAt_idx" ON "IngestRun"("source", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SalesforceConnection_agentId_key" ON "SalesforceConnection"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmLink_conversationId_key" ON "CrmLink"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmFieldMapping_attributeKey_sObject_key" ON "CrmFieldMapping"("attributeKey", "sObject");

-- AddForeignKey
ALTER TABLE "Actor" ADD CONSTRAINT "Actor_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Action" ADD CONSTRAINT "Action_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Action" ADD CONSTRAINT "Action_proposedByActorId_fkey" FOREIGN KEY ("proposedByActorId") REFERENCES "Actor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Action" ADD CONSTRAINT "Action_authorizedByActorId_fkey" FOREIGN KEY ("authorizedByActorId") REFERENCES "Actor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Action" ADD CONSTRAINT "Action_executedByActorId_fkey" FOREIGN KEY ("executedByActorId") REFERENCES "Actor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "Action"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_proposedByActorId_fkey" FOREIGN KEY ("proposedByActorId") REFERENCES "Actor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_authorizedByActorId_fkey" FOREIGN KEY ("authorizedByActorId") REFERENCES "Actor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_executedByActorId_fkey" FOREIGN KEY ("executedByActorId") REFERENCES "Actor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Participant" ADD CONSTRAINT "Participant_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TranscriptSegment" ADD CONSTRAINT "TranscriptSegment_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Analysis" ADD CONSTRAINT "Analysis_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Analysis" ADD CONSTRAINT "Analysis_producedByActorId_fkey" FOREIGN KEY ("producedByActorId") REFERENCES "Actor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoreItem" ADD CONSTRAINT "ScoreItem_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoreItem" ADD CONSTRAINT "ScoreItem_dimensionSlug_fkey" FOREIGN KEY ("dimensionSlug") REFERENCES "RubricDimension"("slug") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Flag" ADD CONSTRAINT "Flag_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Flag" ADD CONSTRAINT "Flag_producedByActorId_fkey" FOREIGN KEY ("producedByActorId") REFERENCES "Actor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Flag" ADD CONSTRAINT "Flag_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "TranscriptSegment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Flag" ADD CONSTRAINT "Flag_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "Rule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingOpportunity" ADD CONSTRAINT "TrainingOpportunity_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingOpportunity" ADD CONSTRAINT "TrainingOpportunity_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationTheme" ADD CONSTRAINT "ConversationTheme_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationTheme" ADD CONSTRAINT "ConversationTheme_themeSlug_fkey" FOREIGN KEY ("themeSlug") REFERENCES "Theme"("slug") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesforceConnection" ADD CONSTRAINT "SalesforceConnection_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmLink" ADD CONSTRAINT "CrmLink_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmLink" ADD CONSTRAINT "CrmLink_resolvedByActorId_fkey" FOREIGN KEY ("resolvedByActorId") REFERENCES "Actor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
