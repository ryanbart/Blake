import "dotenv/config";
import { prisma } from "@/lib/db";
import { seedReferenceData } from "@/lib/seed-reference";
import { generateConversations, timedSegments } from "@/lib/seed/generate";
import { SEED_AGENTS, SEED_CONTACTS } from "@/lib/seed/people";
import { runRules } from "@/lib/analysis/rules";
import {
  getIntegrationActor,
  getHumanActor,
  INTEGRATION_ACTORS,
} from "@/lib/provenance/actors";
import { AUDIT, recordAudit } from "@/lib/provenance/audit";
import {
  AnalysisStatus,
  ConversationSource,
  TranscriptStatus,
} from "@/generated/prisma/client";

/**
 * Seed a full working dataset.
 *
 * Ingest here goes through the same attribution path as production: every
 * conversation is written with an `integration` actor and an audit row, so the
 * seeded database is a realistic subject for the provenance views rather than a
 * pile of rows that appeared from nowhere.
 */
async function main() {
  const t0 = Date.now();
  console.log("→ reference data");
  await seedReferenceData();

  console.log("→ agents");
  for (const seed of SEED_AGENTS) {
    const agent = await prisma.agent.upsert({
      where: { email: seed.email },
      create: {
        name: seed.name,
        email: seed.email,
        team: seed.team,
        dialpadUserId: seed.dialpadUserId,
      },
      update: { name: seed.name, team: seed.team, dialpadUserId: seed.dialpadUserId },
    });
    // Every rep needs a human actor before they can approve anything.
    await getHumanActor(agent.id);
  }

  const agentsByEmail = new Map(
    (await prisma.agent.findMany()).map((a) => [a.email, a]),
  );

  const ingestActor = await getIntegrationActor(INTEGRATION_ACTORS.dialpadBackfill);
  const rules = await prisma.rule.findMany();

  console.log("→ conversations");
  const conversations = generateConversations({ days: 90, target: 400 });

  const run = await prisma.ingestRun.create({
    data: {
      source: ConversationSource.dialpad,
      windowStart: conversations[0]?.startedAt,
      windowEnd: conversations[conversations.length - 1]?.startedAt,
    },
  });

  let added = 0;
  let flagsWritten = 0;

  for (const conv of conversations) {
    const agent = agentsByEmail.get(conv.agent.email);
    if (!agent) continue;

    const hasTranscript = conv.lines.length > 0;

    const created = await prisma.conversation.upsert({
      where: {
        source_sourceId: {
          source: ConversationSource.dialpad,
          sourceId: conv.sourceId,
        },
      },
      create: {
        source: ConversationSource.dialpad,
        sourceId: conv.sourceId,
        title: `${conv.contact.company} — ${conv.contact.name}`,
        direction: conv.direction,
        agentId: agent.id,
        startedAt: conv.startedAt,
        durationSec: conv.durationSec,
        recordingUrl: conv.recordingUrl,
        externalUrl: `https://dialpad.com/calls/${conv.sourceId}`,
        disposition: conv.disposition,
        dispositionNotes: conv.dispositionNotes || null,
        transcriptStatus: hasTranscript
          ? TranscriptStatus.available
          : TranscriptStatus.unavailable,
        analysisStatus: hasTranscript
          ? AnalysisStatus.pending
          : AnalysisStatus.skipped,
        participants: {
          create: [
            {
              name: conv.agent.name,
              email: conv.agent.email,
              isExternal: false,
              role: "agent",
            },
            {
              name: conv.contact.name,
              email: conv.contact.email,
              phone: conv.contact.phone,
              isExternal: true,
              role: "customer",
            },
          ],
        },
        segments: {
          create: timedSegments(conv.lines, conv.durationSec),
        },
      },
      update: {},
      include: { segments: true },
    });

    added += 1;

    await recordAudit({
      eventType: AUDIT.conversationIngested,
      executedByActorId: ingestActor.id,
      targetType: "Conversation",
      targetId: created.id,
      summary: `Seeded ${conv.archetypeSlug} call from ${conv.contact.company}`,
    });

    // Rule findings are deterministic, so they are seeded directly rather than
    // waiting on `npm run analyze`. The dashboard has flags on first boot.
    if (created.segments.length > 0) {
      const matches = runRules(
        created.segments.map((s) => ({
          id: s.id,
          speakerRole: s.speakerRole,
          text: s.text,
        })),
        rules,
      );
      for (const match of matches) {
        await prisma.flag.create({
          data: {
            conversationId: created.id,
            producedByActorId: (await ruleActorId()) ?? ingestActor.id,
            severity: match.severity,
            category: match.category,
            title: match.title,
            detail: match.detail,
            quote: match.quote,
            segmentId: match.segmentId,
            ruleId: match.ruleId,
          },
        });
        flagsWritten += 1;
      }
    }
  }

  await prisma.ingestRun.update({
    where: { id: run.id },
    data: { finishedAt: new Date(), seen: conversations.length, added },
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nSeeded in ${elapsed}s`);
  console.table({
    agents: await prisma.agent.count(),
    conversations: await prisma.conversation.count(),
    segments: await prisma.transcriptSegment.count(),
    flags: flagsWritten,
    contacts: SEED_CONTACTS.length,
    auditEvents: await prisma.auditEvent.count(),
  });

  await selfCheck();
}

/** Cache the rules-engine actor id across the loop. */
let cachedRuleActorId: string | null = null;
async function ruleActorId(): Promise<string | null> {
  if (cachedRuleActorId) return cachedRuleActorId;
  const actor = await prisma.actor.findFirst({
    where: { kind: "system", displayName: "Rules Engine" },
  });
  cachedRuleActorId = actor?.id ?? null;
  return cachedRuleActorId;
}

/**
 * Assert the dataset actually exercises what the UI needs to show.
 *
 * A seed that silently produces zero critical flags leaves a screen looking
 * "finished" while being untested, so this fails loudly instead.
 */
async function selfCheck() {
  const problems: string[] = [];

  const critical = await prisma.flag.count({ where: { severity: "critical" } });
  if (critical === 0) problems.push("no critical flags — compliance view would be empty");

  const unavailable = await prisma.conversation.count({
    where: { transcriptStatus: TranscriptStatus.unavailable },
  });
  if (unavailable === 0)
    problems.push("no transcript-unavailable calls — degraded path untested");

  const distinctCategories = await prisma.flag.groupBy({ by: ["category"] });
  if (distinctCategories.length < 4)
    problems.push(`only ${distinctCategories.length} flag categories`);

  const agentsWithCalls = await prisma.conversation.groupBy({ by: ["agentId"] });
  if (agentsWithCalls.length < SEED_AGENTS.length)
    problems.push(
      `${agentsWithCalls.length}/${SEED_AGENTS.length} agents have calls — leaderboard would be sparse`,
    );

  if (problems.length > 0) {
    console.error("\nSeed self-check failed:");
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nSelf-check passed: critical flags, degraded calls, and full roster present.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
