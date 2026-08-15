import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import type { Prisma, PolicyDecision } from "@/generated/prisma/client";

/**
 * Event names. A closed set rather than free strings, so `/audit` filters and
 * the tests that assert coverage cannot drift apart from the writers.
 */
export const AUDIT = {
  actionProposed: "action.proposed",
  actionApproved: "action.approved",
  actionRejected: "action.rejected",
  actionCancelled: "action.cancelled",
  actionExecutionStarted: "action.execution_started",
  actionSucceeded: "action.succeeded",
  actionFailed: "action.failed",
  actionReverted: "action.reverted",
  actionBlockedByPolicy: "action.blocked_by_policy",
  actionBlockedByKillSwitch: "action.blocked_by_kill_switch",

  conversationIngested: "conversation.ingested",
  conversationAnalyzed: "conversation.analyzed",
  analysisFailed: "conversation.analysis_failed",

  crmFieldWritten: "crm.field_written",
  crmRecordLinked: "crm.record_linked",
  crmWriteFailed: "crm.write_failed",

  policyChanged: "policy.changed",
  killSwitchToggled: "policy.kill_switch_toggled",
} as const;

export type AuditEventType = (typeof AUDIT)[keyof typeof AUDIT];

export interface AuditWrite {
  eventType: AuditEventType;
  actionId?: string | null;

  /** The three questions. Pass whichever are known at this point in the chain. */
  proposedByActorId?: string | null;
  authorizedByActorId?: string | null;
  executedByActorId?: string | null;

  targetType?: string | null;
  targetId?: string | null;

  /** Capture before writing. This is what makes undo real rather than aspirational. */
  beforeValue?: Prisma.InputJsonValue | null;
  afterValue?: Prisma.InputJsonValue | null;

  policyDecision?: PolicyDecision | null;
  correlationId?: string | null;
  summary?: string | null;
}

/** Mint an id tying a whole propose -> approve -> execute chain together. */
export function newCorrelationId(): string {
  return randomUUID();
}

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Write one audit row.
 *
 * Always pass `tx` when the caller is inside a transaction: an audit row that
 * commits while the change it describes rolls back is worse than no row at all,
 * because it reads as evidence of something that never happened.
 */
export async function recordAudit(
  event: AuditWrite,
  tx: Db = prisma,
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      eventType: event.eventType,
      actionId: event.actionId ?? null,
      proposedByActorId: event.proposedByActorId ?? null,
      authorizedByActorId: event.authorizedByActorId ?? null,
      executedByActorId: event.executedByActorId ?? null,
      targetType: event.targetType ?? null,
      targetId: event.targetId ?? null,
      beforeValue: event.beforeValue ?? undefined,
      afterValue: event.afterValue ?? undefined,
      policyDecision: event.policyDecision ?? null,
      correlationId: event.correlationId ?? null,
      summary: event.summary ?? null,
    },
  });
}

/**
 * Run `fn` inside a transaction and write an audit row in the same transaction.
 *
 * This is the intended way to mutate anything auditable — it makes "the change
 * and its record commit together" the default rather than something each call
 * site has to remember.
 */
export async function withAudit<T>(
  event: Omit<AuditWrite, "afterValue"> & {
    afterValue?: Prisma.InputJsonValue | null;
  },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const result = await fn(tx);
    await recordAudit(event, tx);
    return result;
  });
}
