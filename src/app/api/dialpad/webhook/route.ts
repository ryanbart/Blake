import { NextResponse } from "next/server";
import { callEventToCall } from "@/lib/dialpad/types";
import {
  verifyCallEvent,
  WebhookVerificationError,
} from "@/lib/dialpad/webhook";
import { createDialpadClient, TranscriptUnavailableError } from "@/lib/dialpad/client";
import { upsertConversation } from "@/lib/ingest/conversations";
import { getIntegrationActor, INTEGRATION_ACTORS } from "@/lib/provenance/actors";
import { ConversationSource } from "@/generated/prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Dialpad call-event receiver.
 *
 * Nothing reaches the database before the signature verifies. Because this is a
 * public endpoint, an unverifiable body is treated as hostile rather than as a
 * configuration hiccup.
 */
export async function POST(request: Request) {
  const secret = process.env.DIALPAD_WEBHOOK_SECRET ?? "";

  let raw: string;
  try {
    raw = (await request.text()).trim();
  } catch {
    return NextResponse.json({ error: "Unreadable body" }, { status: 400 });
  }

  let event;
  try {
    event = await verifyCallEvent(raw, secret);
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      // Deliberately vague to the caller, specific in our logs: a probing
      // client should not learn whether it got the secret or the shape wrong.
      console.warn(`[dialpad-webhook] rejected: ${err.message}`);
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
    throw err;
  }

  // Dialpad emits several states per call. Ingest on terminal states only —
  // a "ringing" event has no duration, no recording, and no transcript.
  const state = (event.state ?? "").toLowerCase();
  if (state && !["hangup", "completed", "recording"].includes(state)) {
    return NextResponse.json({ ok: true, ignored: state });
  }

  const actor = await getIntegrationActor(INTEGRATION_ACTORS.dialpadWebhook);
  const call = callEventToCall(event);

  // Transcripts are generated asynchronously, so they are usually not ready at
  // hangup. Try, and let the nightly backfill fill the gap when it is not.
  let transcript = null;
  let transcriptUnavailable = false;
  try {
    transcript = await createDialpadClient().getTranscript(call.sourceId);
  } catch (err) {
    if (err instanceof TranscriptUnavailableError) {
      transcriptUnavailable = true;
    } else {
      console.warn(
        `[dialpad-webhook] transcript fetch failed for ${call.sourceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const result = await upsertConversation({
    source: ConversationSource.dialpad,
    call,
    transcript,
    // Only claim "unavailable" on a definite answer; an errored fetch stays
    // pending so the backfill retries it.
    transcriptUnavailable: transcriptUnavailable && !transcript,
    actorId: actor.id,
  });

  return NextResponse.json({
    ok: true,
    conversationId: result.conversationId,
    created: result.created,
    transcriptWritten: result.transcriptWritten,
  });
}
