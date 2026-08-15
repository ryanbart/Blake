import "dotenv/config";
import { prisma } from "@/lib/db";
import { createDialpadClient, TranscriptUnavailableError } from "@/lib/dialpad/client";
import {
  createFellowClient,
  TranscriptUnavailableError as FellowTranscriptUnavailable,
} from "@/lib/fellow/client";
import { hasAnthropicKey } from "@/lib/analysis/claude";

/**
 * Connectivity and credential check.
 *
 *   npm run verify                 check everything configured
 *   npm run verify -- --dialpad    just Dialpad
 *
 * This is the intended way to confirm the defensively-written API mappings
 * against a live account: it prints what came back next to what we expected, so
 * a field-name drift is visible rather than showing up later as a null column.
 */
type Check = { name: string; ok: boolean; detail: string; warn?: boolean };

async function checkDatabase(): Promise<Check> {
  try {
    const conversations = await prisma.conversation.count();
    const agents = await prisma.agent.count();
    return {
      name: "database",
      ok: true,
      detail: `connected — ${agents} agents, ${conversations} conversations`,
    };
  } catch (err) {
    return {
      name: "database",
      ok: false,
      detail: `${err instanceof Error ? err.message : String(err)}\n    Run \`npm run db:up\` and check DATABASE_URL in .env.`,
    };
  }
}

async function checkDialpad(): Promise<Check[]> {
  const transport = (process.env.DIALPAD_TRANSPORT ?? "mock").toLowerCase();
  const checks: Check[] = [];

  if (transport !== "live") {
    return [
      {
        name: "dialpad",
        ok: true,
        warn: true,
        detail: "transport is 'mock' — set DIALPAD_TRANSPORT=live to check credentials",
      },
    ];
  }
  if (!process.env.DIALPAD_API_KEY) {
    return [{ name: "dialpad", ok: false, detail: "DIALPAD_API_KEY is not set" }];
  }

  const client = createDialpadClient();

  try {
    const users = await client.listUsers();
    const withEmail = users.filter((u) => u.email).length;
    checks.push({
      name: "dialpad.users",
      ok: users.length > 0,
      detail:
        users.length === 0
          ? "authenticated but the roster is empty"
          : `${users.length} users, ${withEmail} with an email. Sample: ${users
              .slice(0, 3)
              .map((u) => `${u.name}<${u.email ?? "no-email"}>`)
              .join(", ")}`,
      warn: withEmail < users.length,
    });
  } catch (err) {
    return [
      ...checks,
      {
        name: "dialpad.users",
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      },
    ];
  }

  try {
    const calls = await client.listCalls({ daysAgoStart: 0, daysAgoEnd: 7 });
    checks.push({
      name: "dialpad.calls",
      ok: true,
      detail:
        calls.length === 0
          ? "stats export succeeded but returned no calls in the last 7 days"
          : `${calls.length} calls. Field check on the first row: ` +
            `startedAt=${calls[0].startedAt.toISOString()} duration=${calls[0].durationSec}s ` +
            `direction=${calls[0].direction} agent=${calls[0].dialpadUserId ?? "unmapped"}`,
      warn: calls.length === 0,
    });

    // Transcript availability is the single most consequential unknown: without
    // Dialpad Ai the whole coaching layer degrades, so say so plainly.
    const withDuration = calls.find((c) => c.durationSec > 30);
    if (withDuration) {
      try {
        const lines = await client.getTranscript(withDuration.sourceId);
        checks.push({
          name: "dialpad.transcripts",
          ok: true,
          detail: `available — ${lines.length} lines on call ${withDuration.sourceId}. ` +
            `Speaker labels seen: ${[...new Set(lines.map((l) => l.speakerLabel ?? "none"))].join(", ")}`,
        });
      } catch (err) {
        checks.push({
          name: "dialpad.transcripts",
          ok: false,
          warn: true,
          detail:
            err instanceof TranscriptUnavailableError
              ? "unavailable — Dialpad Ai is probably not enabled on this plan. " +
                "Calls will ingest with metadata and recording links, but coaching " +
                "analysis needs transcripts."
              : err instanceof Error
                ? err.message
                : String(err),
        });
      }
    }
  } catch (err) {
    checks.push({
      name: "dialpad.calls",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  return checks;
}

/**
 * Fellow's field names came from payloads captured against a live workspace, so
 * this check exists mainly to confirm the *envelope* — pagination and endpoint
 * paths — which is the part that could not be grounded.
 */
async function checkFellow(): Promise<Check[]> {
  const transport = (process.env.FELLOW_TRANSPORT ?? "mock").toLowerCase();
  const checks: Check[] = [];

  if (transport !== "live") {
    return [
      {
        name: "fellow",
        ok: true,
        warn: true,
        detail: "transport is 'mock' — set FELLOW_TRANSPORT=live to check credentials",
      },
    ];
  }
  if (!process.env.FELLOW_API_KEY) {
    return [{ name: "fellow", ok: false, detail: "FELLOW_API_KEY is not set" }];
  }

  const client = createFellowClient();
  const toDate = new Date();
  const fromDate = new Date(toDate.getTime() - 7 * 86_400_000);

  let meetings;
  try {
    meetings = await client.listMeetings({ fromDate, toDate });
    checks.push({
      name: "fellow.meetings",
      ok: true,
      warn: meetings.length === 0,
      detail:
        meetings.length === 0
          ? "authenticated but no meetings in the last 7 days"
          : `${meetings.length} meetings. Field check on the first row: ` +
            `startedAt=${meetings[0].startedAt.toISOString()} duration=${meetings[0].durationSec}s ` +
            `title=${JSON.stringify(meetings[0].title)} participants=${meetings[0].participants.length}`,
    });
  } catch (err) {
    return [
      ...checks,
      {
        name: "fellow.meetings",
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      },
    ];
  }

  if (meetings.length === 0) return checks;

  /**
   * The single most consequential field. Fellow gives transcript speakers as
   * display names, so `is_external` on the participant list is what decides
   * which side said what — and therefore whether a rep gets flagged for a
   * customer's words. If it is absent everywhere, everyone parses as internal
   * and every meeting is silently skipped as a standup.
   */
  const external = meetings.filter((m) => m.participants.some((p) => p.isExternal));
  checks.push({
    name: "fellow.participants",
    ok: true,
    warn: external.length === 0,
    detail:
      external.length === 0
        ? "no meeting has an external participant. If that is wrong, `is_external` is " +
          "missing or renamed — every meeting would be treated as internal and skipped."
        : `${external.length}/${meetings.length} meetings have an external participant`,
  });

  const withParticipants = meetings.find((m) => m.participants.length > 0) ?? meetings[0];
  try {
    const lines = await client.getTranscript(withParticipants.meetingId);
    const speakers = [...new Set(lines.map((l) => l.speakerName ?? "none"))];
    const matched = speakers.filter((s) =>
      withParticipants.participants.some(
        (p) => p.name === s || p.email.split("@")[0].toLowerCase() === s.toLowerCase(),
      ),
    );
    checks.push({
      name: "fellow.transcripts",
      ok: lines.length > 0,
      warn: speakers.length > 0 && matched.length === 0,
      detail:
        lines.length === 0
          ? "endpoint responded but returned no lines — check the transcript envelope key"
          : `${lines.length} lines on ${withParticipants.meetingId}. Speakers: ${speakers.join(", ")}` +
            (speakers.length > 0 && matched.length === 0
              ? " — none matched a participant by name or email, so every line would " +
                "be attributed to `unknown` and excluded from coaching."
              : ""),
    });
  } catch (err) {
    checks.push({
      name: "fellow.transcripts",
      ok: false,
      warn: err instanceof FellowTranscriptUnavailable,
      detail:
        err instanceof FellowTranscriptUnavailable
          ? `no transcript for ${withParticipants.meetingId} — it may simply not have been recorded`
          : err instanceof Error
            ? err.message
            : String(err),
    });
  }

  checks.push({
    name: "fellow.webhook",
    ok: true,
    warn: !process.env.FELLOW_WEBHOOK_SECRET,
    detail: process.env.FELLOW_WEBHOOK_SECRET
      ? "secret set — deliveries to POST /api/fellow/webhook will be verified"
      : "FELLOW_WEBHOOK_SECRET is not set, so the webhook route rejects every " +
        "delivery. Backfill still works; real-time ingest does not.",
  });

  return checks;
}

function checkAnalysis(): Check {
  if (!hasAnthropicKey()) {
    return {
      name: "analysis",
      ok: true,
      warn: true,
      detail:
        "no ANTHROPIC_API_KEY — the heuristic fallback will run. Results are " +
        "pattern matching, labelled 'heuristic' in the UI.",
    };
  }
  return {
    name: "analysis",
    ok: true,
    detail: `key present, model ${process.env.ANALYSIS_MODEL ?? "claude-opus-5"}`,
  };
}

function checkSafety(): Check {
  const engaged = (process.env.AUTOMATION_KILL_SWITCH ?? "true").toLowerCase() !== "false";
  return {
    name: "safety",
    ok: true,
    warn: !engaged,
    detail: engaged
      ? "automation kill switch is ENGAGED — no autonomous execution"
      : "automation kill switch is OFF — policy-permitted actions can execute without a human",
  };
}

async function main() {
  const args = process.argv.slice(2);
  const only = args.filter((a) => a.startsWith("--")).map((a) => a.slice(2));
  const wants = (name: string) => only.length === 0 || only.includes(name);

  const checks: Check[] = [];
  if (wants("database")) checks.push(await checkDatabase());
  if (wants("dialpad")) checks.push(...(await checkDialpad()));
  if (wants("fellow")) checks.push(...(await checkFellow()));
  if (wants("analysis")) checks.push(checkAnalysis());
  if (wants("safety")) checks.push(checkSafety());

  console.log();
  for (const check of checks) {
    const mark = !check.ok ? "✗" : check.warn ? "!" : "✓";
    console.log(`  ${mark}  ${check.name.padEnd(22)} ${check.detail}`);
  }
  console.log();

  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.error(`${failed.length} check(s) failed.\n`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
