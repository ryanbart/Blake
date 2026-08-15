import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { resetDb, disconnect } from "./helpers/db";
import {
  getAiActor,
  getHumanActor,
  getSystemActor,
  isFullyAutonomous,
  SYSTEM_ACTORS,
} from "@/lib/provenance/actors";
import {
  approveAction,
  executeAction,
  proposeAction,
  rejectAction,
} from "@/lib/provenance/actions";
import { AUDIT } from "@/lib/provenance/audit";
import { defaultPolicies, evaluateGate } from "@/lib/provenance/policy";
import {
  ActionStatus,
  ActionType,
  ActorKind,
  PolicyDecision,
} from "@/generated/prisma/client";

async function seedAgent(name = "Test Rep", email = "rep@example.com") {
  return prisma.agent.create({ data: { name, email } });
}

async function seedPolicies() {
  await prisma.autonomyPolicy.createMany({ data: defaultPolicies() });
}

const payload = { sObject: "Opportunity", field: "NextStep", value: "Send quote" };

beforeAll(() => {
  // Every test in this file asserts the shipped-safe default.
  process.env.AUTOMATION_KILL_SWITCH = "true";
});

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await disconnect();
});

describe("actor identity", () => {
  it("mints a distinct AI actor per model and prompt version", async () => {
    const v1 = await getAiActor("claude-opus-5", "analysis-v1");
    const v2 = await getAiActor("claude-opus-5", "analysis-v2");
    const v1Again = await getAiActor("claude-opus-5", "analysis-v1");

    // A prompt change must not retroactively relabel past proposals.
    expect(v1.id).not.toBe(v2.id);
    expect(v1Again.id).toBe(v1.id);
    expect(v1.kind).toBe(ActorKind.ai_agent);
    expect(v1.model).toBe("claude-opus-5");
  });

  it("separates system actors from AI actors", async () => {
    const rules = await getSystemActor(SYSTEM_ACTORS.rulesEngine);
    expect(rules.kind).toBe(ActorKind.system);
    expect(rules.model).toBeNull();
  });

  it("flags a chain as autonomous only when no human appears in it", () => {
    const ai = { kind: ActorKind.ai_agent };
    const human = { kind: ActorKind.human };

    expect(
      isFullyAutonomous({ proposedBy: ai, authorizedBy: ai, executedBy: ai }),
    ).toBe(true);
    expect(
      isFullyAutonomous({ proposedBy: ai, authorizedBy: human, executedBy: ai }),
    ).toBe(false);
    expect(isFullyAutonomous({})).toBe(false);
  });
});

describe("provenance is recorded on every transition", () => {
  it("records three distinct actors across propose -> approve -> execute", async () => {
    await seedPolicies();
    const agent = await seedAgent();
    const aiActor = await getAiActor("claude-opus-5");
    const humanActor = await getHumanActor(agent.id);
    const systemActor = await getSystemActor(SYSTEM_ACTORS.policyEngine);

    const proposed = await proposeAction({
      actionType: ActionType.crm_field_update,
      payload,
      proposedByActorId: aiActor.id,
      confidence: 0.9,
      sourceQuote: "I'll get you a quote by Thursday.",
    });
    expect(proposed.status).toBe(ActionStatus.pending_approval);
    expect(proposed.authorizedByActorId).toBeNull();

    await approveAction(proposed.id, humanActor.id);
    const executed = await executeAction(proposed.id, systemActor.id, async () => ({
      ok: true,
      externalId: "006XX",
    }));

    expect(executed.status).toBe(ActionStatus.succeeded);
    expect(executed.proposedByActorId).toBe(aiActor.id);
    expect(executed.authorizedByActorId).toBe(humanActor.id);
    expect(executed.executedByActorId).toBe(systemActor.id);

    // Three different answers to three different questions.
    const distinct = new Set([
      executed.proposedByActorId,
      executed.authorizedByActorId,
      executed.executedByActorId,
    ]);
    expect(distinct.size).toBe(3);
  });

  it("never lets an action reach a terminal state without an audit event", async () => {
    await seedPolicies();
    const agent = await seedAgent();
    const ai = await getAiActor("claude-opus-5");
    const human = await getHumanActor(agent.id);

    const a = await proposeAction({
      actionType: ActionType.crm_task,
      payload,
      proposedByActorId: ai.id,
    });
    await approveAction(a.id, human.id);
    await executeAction(a.id, human.id, async () => ({ ok: true }));

    const b = await proposeAction({
      actionType: ActionType.crm_task,
      payload,
      proposedByActorId: ai.id,
    });
    await rejectAction(b.id, human.id, "Wrong opportunity");

    const terminal: ActionStatus[] = [
      ActionStatus.succeeded,
      ActionStatus.failed,
      ActionStatus.rejected,
      ActionStatus.cancelled,
      ActionStatus.reverted,
    ];
    const terminalActions = await prisma.action.findMany({
      where: { status: { in: terminal } },
    });
    expect(terminalActions.length).toBeGreaterThan(0);

    for (const action of terminalActions) {
      const events = await prisma.auditEvent.count({
        where: { actionId: action.id },
      });
      expect(events).toBeGreaterThan(0);
    }
  });

  it("captures the rejection reason in the audit trail", async () => {
    const agent = await seedAgent();
    const ai = await getAiActor("claude-opus-5");
    const human = await getHumanActor(agent.id);

    const action = await proposeAction({
      actionType: ActionType.crm_field_update,
      payload,
      proposedByActorId: ai.id,
    });
    await rejectAction(action.id, human.id, "Competitor was misheard");

    const event = await prisma.auditEvent.findFirst({
      where: { actionId: action.id, eventType: AUDIT.actionRejected },
    });
    expect(event?.summary).toContain("Competitor was misheard");
    expect(event?.authorizedByActorId).toBe(human.id);
  });
});

describe("audit log is append-only", () => {
  it("rejects UPDATE at the database level", async () => {
    const ai = await getAiActor("claude-opus-5");
    await proposeAction({
      actionType: ActionType.crm_task,
      payload,
      proposedByActorId: ai.id,
    });
    const event = await prisma.auditEvent.findFirstOrThrow();

    await expect(
      prisma.auditEvent.update({
        where: { id: event.id },
        data: { summary: "tampered" },
      }),
    ).rejects.toThrow(/append-only/i);
  });

  it("rejects DELETE at the database level", async () => {
    const ai = await getAiActor("claude-opus-5");
    await proposeAction({
      actionType: ActionType.crm_task,
      payload,
      proposedByActorId: ai.id,
    });
    const event = await prisma.auditEvent.findFirstOrThrow();

    await expect(
      prisma.auditEvent.delete({ where: { id: event.id } }),
    ).rejects.toThrow(/append-only/i);
  });
});

describe("autonomy gate fails closed", () => {
  it("refuses to execute an unapproved action under default policy", async () => {
    await seedPolicies();
    const ai = await getAiActor("claude-opus-5");
    const system = await getSystemActor(SYSTEM_ACTORS.policyEngine);

    const action = await proposeAction({
      actionType: ActionType.crm_field_update,
      payload,
      proposedByActorId: ai.id,
      confidence: 0.99,
    });

    let executorRan = false;
    const result = await executeAction(action.id, system.id, async () => {
      executorRan = true;
      return { ok: true };
    });

    expect(executorRan).toBe(false);
    expect(result.status).not.toBe(ActionStatus.succeeded);
    expect(result.authorizedByActorId).toBeNull();

    const blocked = await prisma.auditEvent.findFirst({
      where: { actionId: action.id, eventType: AUDIT.actionBlockedByPolicy },
    });
    expect(blocked).not.toBeNull();
  });

  it("blocks autonomous execution while the kill switch is engaged", async () => {
    process.env.AUTOMATION_KILL_SWITCH = "true";
    await prisma.autonomyPolicy.createMany({
      data: defaultPolicies().map((p) =>
        p.actionType === ActionType.crm_field_update
          ? { ...p, decision: PolicyDecision.auto_execute }
          : p,
      ),
    });
    const ai = await getAiActor("claude-opus-5");

    const action = await proposeAction({
      actionType: ActionType.crm_field_update,
      payload,
      proposedByActorId: ai.id,
      confidence: 1,
    });

    const gate = await evaluateGate(action);
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) expect(gate.reason).toMatch(/kill switch/i);
  });

  it("leaves blocked work queued rather than failed", async () => {
    await seedPolicies();
    const ai = await getAiActor("claude-opus-5");
    const system = await getSystemActor(SYSTEM_ACTORS.policyEngine);

    const action = await proposeAction({
      actionType: ActionType.crm_field_update,
      payload,
      proposedByActorId: ai.id,
    });
    await executeAction(action.id, system.id, async () => ({ ok: true }));

    const after = await prisma.action.findUniqueOrThrow({
      where: { id: action.id },
    });
    // Not permitted yet is not the same as failed; the work is still valid.
    expect(after.status).toBe(ActionStatus.pending_approval);
  });

  it("allows execution once a human has authorized it, even with the kill switch on", async () => {
    process.env.AUTOMATION_KILL_SWITCH = "true";
    await seedPolicies();
    const agent = await seedAgent();
    const ai = await getAiActor("claude-opus-5");
    const human = await getHumanActor(agent.id);

    const action = await proposeAction({
      actionType: ActionType.crm_field_update,
      payload,
      proposedByActorId: ai.id,
    });
    await approveAction(action.id, human.id);
    const done = await executeAction(action.id, human.id, async () => ({ ok: true }));

    // The kill switch governs autonomous action, not a person clicking approve.
    expect(done.status).toBe(ActionStatus.succeeded);
  });

  it("honours the minimum-confidence threshold", async () => {
    process.env.AUTOMATION_KILL_SWITCH = "false";
    await prisma.autonomyPolicy.createMany({
      data: defaultPolicies().map((p) =>
        p.actionType === ActionType.crm_task
          ? { ...p, decision: PolicyDecision.auto_execute, minConfidence: 0.8 }
          : p,
      ),
    });
    const ai = await getAiActor("claude-opus-5");

    const low = await proposeAction({
      actionType: ActionType.crm_task,
      payload,
      proposedByActorId: ai.id,
      confidence: 0.5,
    });
    const lowGate = await evaluateGate(low);
    expect(lowGate.allowed).toBe(false);

    const high = await proposeAction({
      actionType: ActionType.crm_task,
      payload,
      proposedByActorId: ai.id,
      confidence: 0.95,
    });
    const highGate = await evaluateGate(high);
    expect(highGate.allowed).toBe(true);

    process.env.AUTOMATION_KILL_SWITCH = "true";
  });
});
