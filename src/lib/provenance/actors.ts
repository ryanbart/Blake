import { prisma } from "@/lib/db";
import { ActorKind, type Actor } from "@/generated/prisma/client";

/**
 * Stable identifiers for the non-human actors the system creates for itself.
 * Using constants rather than string literals at call sites means a rename is a
 * compile error instead of a silently orphaned audit trail.
 */
export const SYSTEM_ACTORS = {
  rulesEngine: "Rules Engine",
  heuristicAnalyzer: "Heuristic Analyzer",
  seed: "Seed Data",
  policyEngine: "Autonomy Policy Engine",
} as const;

export const INTEGRATION_ACTORS = {
  dialpadWebhook: "dialpad_webhook",
  dialpadBackfill: "dialpad_backfill",
  fellowWebhook: "fellow_webhook",
  fellowBackfill: "fellow_backfill",
} as const;

/** The prompt revision baked into the analysis system prompt. Bump on edit. */
export const PROMPT_VERSION = "analysis-v1";

/**
 * Find-or-create a `system` actor by name.
 *
 * These are deliberately distinct from `ai_agent`: a deterministic rules pass
 * and a model inference are both non-human, but only one of them can be wrong
 * in a way that needs a model and prompt version to explain.
 */
export async function getSystemActor(
  displayName: (typeof SYSTEM_ACTORS)[keyof typeof SYSTEM_ACTORS],
): Promise<Actor> {
  const existing = await prisma.actor.findFirst({
    where: { kind: ActorKind.system, displayName },
  });
  if (existing) return existing;
  return prisma.actor.create({
    data: { kind: ActorKind.system, displayName },
  });
}

/** Find-or-create an `integration` actor, so even automated ingest is attributed. */
export async function getIntegrationActor(
  integration: (typeof INTEGRATION_ACTORS)[keyof typeof INTEGRATION_ACTORS],
): Promise<Actor> {
  const existing = await prisma.actor.findFirst({
    where: { kind: ActorKind.integration, integration },
  });
  if (existing) return existing;
  return prisma.actor.create({
    data: {
      kind: ActorKind.integration,
      integration,
      displayName: integration,
    },
  });
}

/**
 * Find-or-create the AI actor for a given model + prompt version.
 *
 * A new row per (model, promptVersion) pair is the point: when a prompt changes
 * or a model is upgraded, past proposals keep pointing at the actor that
 * actually produced them. Reusing one row would erase exactly the information
 * you need to explain a year-old suggestion.
 */
export async function getAiActor(
  model: string,
  promptVersion: string = PROMPT_VERSION,
  displayName = "Conversation Analyst",
): Promise<Actor> {
  const existing = await prisma.actor.findFirst({
    where: { kind: ActorKind.ai_agent, model, promptVersion },
  });
  if (existing) return existing;
  return prisma.actor.create({
    data: {
      kind: ActorKind.ai_agent,
      model,
      promptVersion,
      displayName: `${displayName} (${model} · ${promptVersion})`,
    },
  });
}

/** Find-or-create the `human` actor backing a rep. */
export async function getHumanActor(agentId: string): Promise<Actor> {
  const existing = await prisma.actor.findUnique({ where: { agentId } });
  if (existing) return existing;

  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent) throw new Error(`No agent with id ${agentId}`);

  return prisma.actor.create({
    data: {
      kind: ActorKind.human,
      agentId,
      displayName: agent.name,
    },
  });
}

/**
 * True when every provenance slot is non-human — i.e. nothing with a pulse
 * touched this. The UI renders that case distinctly because it is the one a
 * reviewer most needs to notice.
 */
export function isFullyAutonomous(actors: {
  proposedBy?: { kind: ActorKind } | null;
  authorizedBy?: { kind: ActorKind } | null;
  executedBy?: { kind: ActorKind } | null;
}): boolean {
  const slots = [actors.proposedBy, actors.authorizedBy, actors.executedBy];
  const present = slots.filter(Boolean) as { kind: ActorKind }[];
  if (present.length === 0) return false;
  return present.every((a) => a.kind !== ActorKind.human);
}
