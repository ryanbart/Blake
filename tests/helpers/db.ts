import { prisma } from "@/lib/db";

/**
 * Reset all data between tests.
 *
 * TRUNCATE rather than deleteMany: the AuditEvent table has a row-level trigger
 * that blocks DELETE, so `prisma.auditEvent.deleteMany()` would throw. TRUNCATE
 * bypasses row triggers, which is the intended escape hatch — an operator can
 * reset a dev database, but no individual audit row can be quietly altered.
 */
export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AuditEvent", "Action", "AutonomyPolicy",
      "ScoreItem", "Analysis", "Flag", "TrainingOpportunity",
      "ConversationTheme", "TranscriptSegment", "Participant",
      "CrmLink", "Conversation", "SalesforceConnection",
      "Actor", "Agent", "Rule", "IngestRun",
      "RubricDimension", "Theme", "CrmFieldMapping"
    RESTART IDENTITY CASCADE
  `);
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
