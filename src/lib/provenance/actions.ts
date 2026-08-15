import { prisma } from "@/lib/db";
import {
  ActionStatus,
  type ActionType,
  type Action,
  type Prisma,
} from "@/generated/prisma/client";
import { AUDIT, newCorrelationId, recordAudit } from "./audit";
import { evaluateGate } from "./policy";

export interface ProposeInput {
  actionType: ActionType;
  payload: Prisma.InputJsonValue;
  proposedByActorId: string;
  conversationId?: string | null;
  confidence?: number | null;
  sourceQuote?: string | null;
  rationale?: string | null;
  correlationId?: string | null;
}

/**
 * Create an action in `pending_approval` and record who proposed it.
 *
 * Nothing else creates Action rows. Funnelling every proposal through one
 * function is what lets the provenance test assert that no action can exist
 * without a corresponding audit event.
 */
export async function proposeAction(input: ProposeInput): Promise<Action> {
  const correlationId = input.correlationId ?? newCorrelationId();

  return prisma.$transaction(async (tx) => {
    const action = await tx.action.create({
      data: {
        actionType: input.actionType,
        payload: input.payload,
        status: ActionStatus.pending_approval,
        proposedByActorId: input.proposedByActorId,
        conversationId: input.conversationId ?? null,
        confidence: input.confidence ?? null,
        sourceQuote: input.sourceQuote ?? null,
        rationale: input.rationale ?? null,
      },
    });

    await recordAudit(
      {
        eventType: AUDIT.actionProposed,
        actionId: action.id,
        proposedByActorId: input.proposedByActorId,
        targetType: "Action",
        targetId: action.id,
        afterValue: input.payload,
        correlationId,
        summary: `Proposed ${input.actionType}`,
      },
      tx,
    );

    return action;
  });
}

/** Record a human (or policy) authorizing an action. Does not execute it. */
export async function approveAction(
  actionId: string,
  authorizedByActorId: string,
): Promise<Action> {
  return prisma.$transaction(async (tx) => {
    const before = await tx.action.findUniqueOrThrow({ where: { id: actionId } });

    if (before.status !== ActionStatus.pending_approval) {
      throw new Error(
        `Cannot approve action ${actionId} in status ${before.status}`,
      );
    }

    const action = await tx.action.update({
      where: { id: actionId },
      data: {
        status: ActionStatus.approved,
        authorizedByActorId,
        reviewedAt: new Date(),
      },
    });

    await recordAudit(
      {
        eventType: AUDIT.actionApproved,
        actionId,
        proposedByActorId: before.proposedByActorId,
        authorizedByActorId,
        targetType: "Action",
        targetId: actionId,
        beforeValue: { status: before.status },
        afterValue: { status: action.status },
        summary: `Approved ${before.actionType}`,
      },
      tx,
    );

    return action;
  });
}

export async function rejectAction(
  actionId: string,
  authorizedByActorId: string,
  reason?: string,
): Promise<Action> {
  return prisma.$transaction(async (tx) => {
    const before = await tx.action.findUniqueOrThrow({ where: { id: actionId } });

    const action = await tx.action.update({
      where: { id: actionId },
      data: {
        status: ActionStatus.rejected,
        authorizedByActorId,
        reviewedAt: new Date(),
        rejectionReason: reason ?? null,
      },
    });

    await recordAudit(
      {
        eventType: AUDIT.actionRejected,
        actionId,
        proposedByActorId: before.proposedByActorId,
        authorizedByActorId,
        targetType: "Action",
        targetId: actionId,
        beforeValue: { status: before.status },
        afterValue: { status: action.status, reason: reason ?? null },
        summary: reason ? `Rejected: ${reason}` : "Rejected",
      },
      tx,
    );

    return action;
  });
}

export type ExecuteResult =
  | { ok: true; externalId?: string; before?: Prisma.InputJsonValue }
  | { ok: false; error: string };

/**
 * Run an approved (or policy-permitted) action through its executor.
 *
 * The gate is consulted here rather than at approval time, so a kill switch
 * flipped between approval and execution still stops the write.
 */
export async function executeAction(
  actionId: string,
  executedByActorId: string,
  executor: (action: Action) => Promise<ExecuteResult>,
): Promise<Action> {
  const action = await prisma.action.findUniqueOrThrow({
    where: { id: actionId },
  });

  const gate = await evaluateGate(action);
  if (!gate.allowed) {
    await recordAudit({
      eventType: AUDIT.actionBlockedByPolicy,
      actionId,
      proposedByActorId: action.proposedByActorId,
      targetType: "Action",
      targetId: actionId,
      policyDecision: gate.decision,
      summary: gate.reason,
    });
    // Deliberately left in its current status, not failed: the work is still
    // valid, it simply has not been permitted yet.
    return action;
  }

  await prisma.$transaction(async (tx) => {
    await tx.action.update({
      where: { id: actionId },
      data: { status: ActionStatus.executing, executedByActorId },
    });
    await recordAudit(
      {
        eventType: AUDIT.actionExecutionStarted,
        actionId,
        proposedByActorId: action.proposedByActorId,
        authorizedByActorId: action.authorizedByActorId,
        executedByActorId,
        targetType: "Action",
        targetId: actionId,
        policyDecision: gate.decision,
      },
      tx,
    );
  });

  let result: ExecuteResult;
  try {
    result = await executor(action);
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.action.update({
      where: { id: actionId },
      data: result.ok
        ? {
            status: ActionStatus.succeeded,
            executedAt: new Date(),
            externalId: result.externalId ?? null,
            error: null,
          }
        : { status: ActionStatus.failed, error: result.error },
    });

    await recordAudit(
      {
        eventType: result.ok ? AUDIT.actionSucceeded : AUDIT.actionFailed,
        actionId,
        proposedByActorId: action.proposedByActorId,
        authorizedByActorId: action.authorizedByActorId,
        executedByActorId,
        targetType: "Action",
        targetId: actionId,
        beforeValue: result.ok ? (result.before ?? undefined) : undefined,
        afterValue: result.ok ? action.payload : undefined,
        policyDecision: gate.decision,
        summary: result.ok
          ? `Executed ${action.actionType}`
          : `Failed: ${result.error}`,
      },
      tx,
    );

    return updated;
  });
}
