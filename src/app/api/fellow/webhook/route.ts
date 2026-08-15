import { NextResponse } from "next/server";
import {
  createFellowClient,
  TranscriptUnavailableError,
} from "@/lib/fellow/client";
import { upsertMeeting } from "@/lib/fellow/normalize";
import {
  FellowWebhookError,
  parseEvent,
  verifySignature,
} from "@/lib/fellow/webhook";
import { getIntegrationActor, INTEGRATION_ACTORS } from "@/lib/provenance/actors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Fellow meeting-event receiver.
 *
 * The payload is used for exactly one thing: which meeting to go read. Every
 * field that lands in the database — title, participants, transcript — is
 * fetched from the API afterwards. That way a forged body cannot write
 * conversation content even in the case where the signature scheme turns out to
 * be wrong; the worst it can do is make us re-read a meeting we already have,
 * which ingest treats as a no-op.
 */
export async function POST(request: Request) {
  const secret = process.env.FELLOW_WEBHOOK_SECRET ?? "";

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return NextResponse.json({ error: "Unreadable body" }, { status: 400 });
  }

  let meetingId: string;
  let eventType: string | null;
  try {
    verifySignature(raw, request.headers, secret);
    ({ meetingId, eventType } = parseEvent(JSON.parse(raw)));
  } catch (err) {
    if (err instanceof FellowWebhookError || err instanceof SyntaxError) {
      // Specific in our logs, vague to the caller: a prober should not learn
      // whether it got the secret or the shape wrong.
      console.warn(`[fellow-webhook] rejected: ${err.message}`);
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
    throw err;
  }

  const client = createFellowClient();
  const meeting = await client.getMeeting(meetingId);
  if (!meeting) {
    // Not an error worth retrying at Fellow: a meeting we cannot read is one we
    // cannot ingest, and a 4xx here would make Fellow redeliver forever.
    console.warn(`[fellow-webhook] meeting ${meetingId} not readable; skipping`);
    return NextResponse.json({ ok: true, ignored: "meeting-not-found" });
  }

  // Transcription finishes after the meeting does, so an early event usually
  // has nothing to read yet. Ingest the meeting anyway and let the nightly
  // backfill attach the transcript when it exists.
  let transcript = null;
  let transcriptUnavailable = false;
  try {
    transcript = await client.getTranscript(meetingId);
  } catch (err) {
    if (err instanceof TranscriptUnavailableError) {
      transcriptUnavailable = true;
    } else {
      console.warn(
        `[fellow-webhook] transcript fetch failed for ${meetingId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const actor = await getIntegrationActor(INTEGRATION_ACTORS.fellowWebhook);
  const result = await upsertMeeting({
    meeting,
    transcript,
    // Only claim "unavailable" on a definite answer; an errored fetch stays
    // pending so the backfill retries it.
    transcriptUnavailable: transcriptUnavailable && !transcript,
    actorId: actor.id,
  });

  return NextResponse.json({
    ok: true,
    eventType,
    conversationId: result.conversationId,
    created: result.created,
    transcriptWritten: result.transcriptWritten,
    skippedInternal: result.skippedInternal,
  });
}
