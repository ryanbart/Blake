import "dotenv/config";
import { prisma } from "@/lib/db";
import {
  createDialpadClient,
  TranscriptUnavailableError as DialpadTranscriptUnavailable,
} from "@/lib/dialpad/client";
import {
  createFellowClient,
  TranscriptUnavailableError as FellowTranscriptUnavailable,
} from "@/lib/fellow/client";
import { upsertConversation } from "@/lib/ingest/conversations";
import { upsertMeeting } from "@/lib/fellow/normalize";
import { getIntegrationActor, INTEGRATION_ACTORS } from "@/lib/provenance/actors";
import { ConversationSource } from "@/generated/prisma/client";

/**
 * Backfill conversations from Dialpad and Fellow.
 *
 *   npm run sync                        both sources, last 2 days
 *   npm run sync -- --days 30           wider window
 *   npm run sync -- --source fellow     one source only
 *   npm run sync -- --no-transcripts
 *
 * The window deliberately overlaps what webhooks already delivered. Ingest is
 * idempotent on (source, sourceId), so re-covering a day is free and is how
 * dropped webhook deliveries heal.
 */
const SOURCES = ["dialpad", "fellow"] as const;
type Source = (typeof SOURCES)[number];

interface Args {
  days: number;
  transcripts: boolean;
  sources: Source[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { days: 2, transcripts: true, sources: [...SOURCES] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--days") {
      const raw = argv[++i];
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`--days needs a non-negative number, got "${raw}"`);
      }
      args.days = value;
    } else if (argv[i] === "--no-transcripts") {
      args.transcripts = false;
    } else if (argv[i] === "--source") {
      const raw = argv[++i];
      if (!SOURCES.includes(raw as Source)) {
        throw new Error(`--source must be one of ${SOURCES.join(", ")}, got "${raw}"`);
      }
      args.sources = [raw as Source];
    }
  }
  return args;
}

interface SyncResult {
  seen: number;
  added: number;
  transcripts: number;
  unavailable: number;
  extra?: Record<string, number>;
}

/**
 * Wrap a source sync in an IngestRun so a failure is recorded rather than only
 * printed, and so one source failing does not abort the other.
 */
async function withIngestRun(
  source: ConversationSource,
  run: () => Promise<SyncResult>,
): Promise<{ result: SyncResult; error: string | null }> {
  const record = await prisma.ingestRun.create({ data: { source } });
  let result: SyncResult = { seen: 0, added: 0, transcripts: 0, unavailable: 0 };
  let error: string | null = null;

  try {
    result = await run();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  await prisma.ingestRun.update({
    where: { id: record.id },
    data: {
      finishedAt: new Date(),
      seen: result.seen,
      added: result.added,
      error,
    },
  });

  return { result, error };
}

async function syncDialpad(args: Args): Promise<SyncResult> {
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

  const calls = await client.listCalls({ daysAgoStart: 0, daysAgoEnd: args.days });
  const result: SyncResult = {
    seen: calls.length,
    added: 0,
    transcripts: 0,
    unavailable: 0,
    extra: { agents: agentsTouched },
  };

  for (const call of calls) {
    let transcript = null;
    let transcriptUnavailable = false;

    if (args.transcripts && call.durationSec > 0) {
      try {
        transcript = await client.getTranscript(call.sourceId);
        result.transcripts += 1;
      } catch (err) {
        if (err instanceof DialpadTranscriptUnavailable) {
          transcriptUnavailable = true;
          result.unavailable += 1;
        } else {
          console.warn(
            `  ! transcript ${call.sourceId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    const upserted = await upsertConversation({
      source: ConversationSource.dialpad,
      call,
      transcript,
      transcriptUnavailable,
      actorId: actor.id,
    });
    if (upserted.created) result.added += 1;
  }

  return result;
}

async function syncFellow(args: Args): Promise<SyncResult> {
  const client = createFellowClient();
  const actor = await getIntegrationActor(INTEGRATION_ACTORS.fellowBackfill);

  const toDate = new Date();
  const fromDate = new Date(toDate.getTime() - args.days * 86_400_000);

  const meetings = await client.listMeetings({ fromDate, toDate });
  const result: SyncResult = {
    seen: meetings.length,
    added: 0,
    transcripts: 0,
    unavailable: 0,
    extra: { internal: 0, unattributed: 0 },
  };

  /**
   * Internal attendees with no Agent row.
   *
   * Deliberately *not* auto-created. Dialpad has a rep roster to sync from;
   * Fellow has whoever was on the invite, so minting an Agent per internal
   * attendee would fill the coaching leaderboard with engineers and finance
   * staff who sat in on one call. But an unmatched rep means the meeting is
   * invisible on every agent view, so the gap gets named instead of swallowed.
   */
  const unmatchedInternal = new Set<string>();

  for (const meeting of meetings) {
    let transcript = null;
    let transcriptUnavailable = false;

    if (args.transcripts) {
      try {
        transcript = await client.getTranscript(meeting.meetingId);
        result.transcripts += 1;
      } catch (err) {
        if (err instanceof FellowTranscriptUnavailable) {
          transcriptUnavailable = true;
          result.unavailable += 1;
        } else {
          console.warn(
            `  ! transcript ${meeting.meetingId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    const upserted = await upsertMeeting({
      meeting,
      transcript,
      transcriptUnavailable,
      actorId: actor.id,
    });
    if (upserted.created) result.added += 1;
    if (upserted.skippedInternal) result.extra!.internal += 1;

    // Only worth reporting for customer meetings: an internal meeting nobody
    // owns is not a coaching gap.
    if (!upserted.agentMatched && upserted.isCustomerFacing) {
      result.extra!.unattributed += 1;
      for (const p of meeting.participants) {
        if (!p.isExternal) unmatchedInternal.add(p.email);
      }
    }
  }

  if (unmatchedInternal.size > 0) {
    console.warn(
      `  ! ${result.extra!.unattributed} customer meeting(s) have no rep on the roster. ` +
        `These will not appear on any agent view until an Agent exists with a ` +
        `matching email: ${[...unmatchedInternal].sort().join(", ")}`,
    );
  }

  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const failures: string[] = [];
  const summary: Record<string, Record<string, number>> = {};

  for (const source of args.sources) {
    const transport = (
      process.env[`${source.toUpperCase()}_TRANSPORT`] ?? "mock"
    ).toLowerCase();
    console.log(`→ ${source} sync (${transport}), last ${args.days} day(s)`);

    const { result, error } = await withIngestRun(
      source as ConversationSource,
      source === "dialpad" ? () => syncDialpad(args) : () => syncFellow(args),
    );

    summary[source] = {
      seen: result.seen,
      new: result.added,
      alreadyPresent: result.seen - result.added,
      transcripts: result.transcripts,
      noTranscript: result.unavailable,
      ...(result.extra ?? {}),
    };

    if (error) {
      failures.push(`${source}: ${error}`);
      console.error(`  ✗ ${error}`);
    }
  }

  console.log();
  console.table(summary);

  // A source that saw calls but got no transcript at all is the signature of a
  // plan or scope problem, not a transient failure — say which one it is.
  const dialpad = summary.dialpad;
  if (dialpad && dialpad.noTranscript > 0 && dialpad.transcripts === 0) {
    console.warn(
      "\n⚠ No Dialpad transcripts were available. If this is a live run, Dialpad Ai " +
        "is probably not enabled on the plan — calls still ingest with metadata and " +
        "recording links, but coaching analysis needs transcripts.",
    );
  }
  const fellow = summary.fellow;
  if (fellow && fellow.noTranscript > 0 && fellow.transcripts === 0) {
    console.warn(
      "\n⚠ No Fellow transcripts were available. Check that the API key's workspace " +
        "has recording enabled and that the meetings in this window were recorded.",
    );
  }
  if (fellow && fellow.internal > 0) {
    console.log(
      `\nℹ ${fellow.internal} internal meeting(s) stored but not queued for scoring — ` +
        "a standup on a sales rubric produces numbers that mean nothing.",
    );
  }

  if (failures.length > 0) {
    console.error(`\nSync failed for ${failures.length} source(s):`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nNext: npm run analyze");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
