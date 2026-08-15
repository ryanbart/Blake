import "dotenv/config";
import { prisma } from "@/lib/db";
import {
  createDialpadClient,
  TranscriptUnavailableError,
} from "@/lib/dialpad/client";
import { upsertConversation } from "@/lib/ingest/conversations";
import { getIntegrationActor, INTEGRATION_ACTORS } from "@/lib/provenance/actors";
import { ConversationSource } from "@/generated/prisma/client";

/**
 * Backfill conversations from Dialpad.
 *
 *   npm run sync                  last 2 days (the nightly default)
 *   npm run sync -- --days 30     wider window
 *   npm run sync -- --no-transcripts
 *
 * The window deliberately overlaps what webhooks already delivered. Ingest is
 * idempotent on (source, sourceId), so re-covering a day is free and is how
 * dropped webhook deliveries heal.
 */
function parseArgs(argv: string[]) {
  const args = { days: 2, transcripts: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--days") {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`--days needs a non-negative number, got "${argv[i]}"`);
      }
      args.days = value;
    } else if (argv[i] === "--no-transcripts") {
      args.transcripts = false;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const transport = (process.env.DIALPAD_TRANSPORT ?? "mock").toLowerCase();
  console.log(`→ Dialpad sync (${transport}), last ${args.days} day(s)\n`);

  const client = createDialpadClient();
  const actor = await getIntegrationActor(INTEGRATION_ACTORS.dialpadBackfill);

  // Keep the roster current first: a call whose rep is unknown cannot be
  // attributed, and an unattributed call is invisible on every agent view.
  const users = await client.listUsers();
  let agentsTouched = 0;
  for (const user of users) {
    if (!user.email) continue;
    await prisma.agent.upsert({
      where: { email: user.email },
      create: {
        name: user.name,
        email: user.email,
        dialpadUserId: user.id,
        active: user.active,
      },
      update: { name: user.name, dialpadUserId: user.id, active: user.active },
    });
    agentsTouched += 1;
  }

  const run = await prisma.ingestRun.create({
    data: { source: ConversationSource.dialpad },
  });

  let seen = 0;
  let added = 0;
  let transcripts = 0;
  let unavailable = 0;
  let error: string | null = null;

  try {
    const calls = await client.listCalls({
      daysAgoStart: 0,
      daysAgoEnd: args.days,
    });
    seen = calls.length;

    for (const call of calls) {
      let transcript = null;
      let transcriptUnavailable = false;

      if (args.transcripts && call.durationSec > 0) {
        try {
          transcript = await client.getTranscript(call.sourceId);
          transcripts += 1;
        } catch (err) {
          if (err instanceof TranscriptUnavailableError) {
            transcriptUnavailable = true;
            unavailable += 1;
          } else {
            console.warn(
              `  ! transcript ${call.sourceId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }

      const result = await upsertConversation({
        source: ConversationSource.dialpad,
        call,
        transcript,
        transcriptUnavailable,
        actorId: actor.id,
      });
      if (result.created) added += 1;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  await prisma.ingestRun.update({
    where: { id: run.id },
    data: { finishedAt: new Date(), seen, added, error },
  });

  console.table({
    agents: agentsTouched,
    callsSeen: seen,
    newConversations: added,
    alreadyPresent: seen - added,
    transcriptsFetched: transcripts,
    transcriptsUnavailable: unavailable,
  });

  if (error) {
    console.error(`\nSync failed: ${error}`);
    process.exitCode = 1;
    return;
  }
  if (unavailable > 0 && transcripts === 0) {
    console.warn(
      "\n⚠ No transcripts were available for any call. If this is a live run, " +
        "Dialpad Ai is probably not enabled on the plan — calls will still be " +
        "ingested with metadata and recording links, but coaching analysis needs " +
        "transcripts.",
    );
  }
  console.log("\nNext: npm run analyze");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
