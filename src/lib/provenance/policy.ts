import { prisma } from "@/lib/db";
import {
  ActionStatus,
  ActionType,
  PolicyDecision,
  type Action,
  type AutonomyPolicy,
} from "@/generated/prisma/client";

/** Which action types reach a customer. Drives the extra guardrails below. */
export const CUSTOMER_FACING: ReadonlySet<ActionType> = new Set([
  ActionType.email_followup,
]);

export type GateResult =
  | { allowed: true; decision: PolicyDecision; runAt: Date }
  | { allowed: false; reason: string; decision: PolicyDecision | null };

/**
 * The global kill switch. Reads the env var on every call rather than caching,
 * so flipping it takes effect immediately instead of at the next deploy.
 */
export function killSwitchEngaged(): boolean {
  return (process.env.AUTOMATION_KILL_SWITCH ?? "true").toLowerCase() !== "false";
}

/** Default policies: require_approval for everything, per the shipped config. */
export function defaultPolicies(): Array<
  Pick<
    AutonomyPolicy,
    | "actionType"
    | "decision"
    | "delaySeconds"
    | "enabled"
    | "minConfidence"
    | "customerFacing"
    | "maxPerHour"
  >
> {
  return Object.values(ActionType).map((actionType) => ({
    actionType,
    decision: PolicyDecision.require_approval,
    delaySeconds: 0,
    enabled: true,
    minConfidence: null,
    customerFacing: CUSTOMER_FACING.has(actionType),
    maxPerHour: 60,
  }));
}

/**
 * Decide whether an action may execute right now.
 *
 * Deliberately fail-closed: an unknown action type, a disabled policy, a missing
 * approval, or an engaged kill switch all deny. The only path to `allowed` is an
 * explicit policy that permits it, or a human in the `authorizedBy` slot.
 */
export async function evaluateGate(action: Action): Promise<GateResult> {
  // A human approval is the strongest signal there is; it satisfies the gate
  // regardless of policy, since a person has taken responsibility for it.
  if (action.authorizedByActorId) {
    return {
      allowed: true,
      decision: action.policyDecision ?? PolicyDecision.require_approval,
      runAt: new Date(),
    };
  }

  if (killSwitchEngaged()) {
    return {
      allowed: false,
      reason:
        "Automation kill switch is engaged. Action stays queued; no work is lost.",
      decision: null,
    };
  }

  const policy = await prisma.autonomyPolicy.findUnique({
    where: { actionType: action.actionType },
  });

  if (!policy || !policy.enabled) {
    return {
      allowed: false,
      reason: `No enabled autonomy policy for ${action.actionType}; a human must approve.`,
      decision: null,
    };
  }

  if (policy.decision === PolicyDecision.require_approval) {
    return {
      allowed: false,
      reason: `Policy for ${action.actionType} requires human approval.`,
      decision: policy.decision,
    };
  }

  if (
    policy.minConfidence !== null &&
    (action.confidence ?? 0) < policy.minConfidence
  ) {
    return {
      allowed: false,
      reason: `Confidence ${action.confidence ?? 0} is below the ${policy.minConfidence} threshold for ${action.actionType}.`,
      decision: policy.decision,
    };
  }

  const executedLastHour = await prisma.action.count({
    where: {
      actionType: action.actionType,
      status: ActionStatus.succeeded,
      authorizedByActorId: null, // autonomous executions only
      executedAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
    },
  });
  if (executedLastHour >= policy.maxPerHour) {
    return {
      allowed: false,
      reason: `Rate limit reached: ${executedLastHour}/${policy.maxPerHour} autonomous ${action.actionType} executions in the last hour.`,
      decision: policy.decision,
    };
  }

  if (policy.customerFacing && !withinBusinessHours(new Date())) {
    return {
      allowed: false,
      reason:
        "Customer-facing actions are restricted to business hours; queued until the window opens.",
      decision: policy.decision,
    };
  }

  const runAt =
    policy.decision === PolicyDecision.auto_execute_after_delay
      ? new Date(Date.now() + policy.delaySeconds * 1000)
      : new Date();

  return { allowed: true, decision: policy.decision, runAt };
}

/** Mon-Fri, 08:00-18:00 local. Coarse on purpose; refine when it matters. */
export function withinBusinessHours(at: Date): boolean {
  const day = at.getDay();
  const hour = at.getHours();
  return day >= 1 && day <= 5 && hour >= 8 && hour < 18;
}
