import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { resetDb, disconnect } from "./helpers/db";
import { upsertConversation, toSpeakerRole } from "@/lib/ingest/conversations";
import { getIntegrationActor, INTEGRATION_ACTORS } from "@/lib/provenance/actors";
import { AUDIT } from "@/lib/provenance/audit";
import {
  AnalysisStatus,
  ConversationSource,
  SpeakerRole,
  TranscriptStatus,
} from "@/generated/prisma/client";
import type { NormalizedCall, TranscriptLine } from "@/lib/dialpad/types";

const call: NormalizedCall = {
  sourceId: "dp_test_1",
  startedAt: new Date("2026-08-14T14:30:00Z"),
  durationSec: 412,
  direction: "outbound",
  dialpadUserId: "5001",
  agentName: "Dana Whitfield",
  contactName: "Peter De Haan",
  contactPhone: "+15025550142",
  disposition: "Connected",
  dispositionNotes: "Wants pricing",
  recordingUrl: "https://recordings.example/dp_test_1",
};

const transcript: TranscriptLine[] = [
  { speakerName: "Dana", speakerLabel: "agent", startMs: 0, text: "Hi Peter." },
  { speakerName: "Peter", speakerLabel: "external", startMs: 4000, text: "Hello." },
];

async function actorId() {
  const actor = await getIntegrationActor(INTEGRATION_ACTORS.dialpadWebhook);
  return actor.id;
}

beforeEach(async () => {
  await resetDb();
  await prisma.agent.create({
    data: {
      name: "Dana Whitfield",
      email: "dana@example.com",
      dialpadUserId: "5001",
    },
  });
});

afterAll(disconnect);

describe("speaker role mapping", () => {
  it("maps the label vocabularies seen across Dialpad plans", () => {
    for (const label of ["agent", "internal", "operator", "user", "rep"]) {
      expect(toSpeakerRole(label)).toBe(SpeakerRole.agent);
    }
    for (const label of ["external", "customer", "contact", "caller"]) {
      expect(toSpeakerRole(label)).toBe(SpeakerRole.customer);
    }
  });

  it("falls back to unknown rather than guessing", () => {
    // Unknown speech is excluded from agent-targeted rules, which is the safe
    // direction: better a missed flag than blaming a rep for customer words.
    expect(toSpeakerRole(null)).toBe(SpeakerRole.unknown);
    expect(toSpeakerRole("participant_3")).toBe(SpeakerRole.unknown);
  });
});

describe("idempotent ingest", () => {
  it("creates one conversation for a replayed webhook", async () => {
    const id = await actorId();
    const first = await upsertConversation({
      source: ConversationSource.dialpad,
      call,
      transcript,
      actorId: id,
    });
    const second = await upsertConversation({
      source: ConversationSource.dialpad,
      call,
      transcript,
      actorId: id,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.conversationId).toBe(first.conversationId);
    expect(await prisma.conversation.count()).toBe(1);
  });

  it("does not duplicate transcript segments on replay", async () => {
    const id = await actorId();
    await upsertConversation({
      source: ConversationSource.dialpad,
      call,
      transcript,
      actorId: id,
    });
    await upsertConversation({
      source: ConversationSource.dialpad,
      call,
      transcript,
      actorId: id,
    });

    expect(await prisma.transcriptSegment.count()).toBe(transcript.length);
  });

  it("lets the backfill add a transcript the webhook did not have", async () => {
    // Transcripts generate asynchronously, so hangup usually arrives without
    // one and the nightly backfill fills the gap.
    const id = await actorId();
    const first = await upsertConversation({
      source: ConversationSource.dialpad,
      call,
      transcript: null,
      actorId: id,
    });

    let stored = await prisma.conversation.findUniqueOrThrow({
      where: { id: first.conversationId },
    });
    expect(stored.transcriptStatus).toBe(TranscriptStatus.pending);

    const second = await upsertConversation({
      source: ConversationSource.dialpad,
      call,
      transcript,
      actorId: id,
    });
    expect(second.created).toBe(false);
    expect(second.transcriptWritten).toBe(true);

    stored = await prisma.conversation.findUniqueOrThrow({
      where: { id: first.conversationId },
    });
    expect(stored.transcriptStatus).toBe(TranscriptStatus.available);
    expect(await prisma.transcriptSegment.count()).toBe(transcript.length);
  });

  it("never re-opens a completed analysis when a later delivery arrives", async () => {
    const id = await actorId();
    const first = await upsertConversation({
      source: ConversationSource.dialpad,
      call,
      transcript,
      actorId: id,
    });
    await prisma.conversation.update({
      where: { id: first.conversationId },
      data: { analysisStatus: AnalysisStatus.analyzed },
    });

    await upsertConversation({
      source: ConversationSource.dialpad,
      call,
      transcript,
      actorId: id,
    });

    const stored = await prisma.conversation.findUniqueOrThrow({
      where: { id: first.conversationId },
    });
    // Re-running analysis on every backfill pass would burn tokens and churn
    // the coaching history for no gain.
    expect(stored.analysisStatus).toBe(AnalysisStatus.analyzed);
  });

  it("takes the longer duration when a later delivery reports one", async () => {
    const id = await actorId();
    await upsertConversation({
      source: ConversationSource.dialpad,
      call: { ...call, durationSec: 30 },
      actorId: id,
    });
    await upsertConversation({
      source: ConversationSource.dialpad,
      call: { ...call, durationSec: 412 },
      actorId: id,
    });

    const stored = await prisma.conversation.findFirstOrThrow();
    // A "ringing" event reports a short duration; the final one is the truth.
    expect(stored.durationSec).toBe(412);
  });

  it("keeps sourceIds distinct across sources", async () => {
    const id = await actorId();
    await upsertConversation({
      source: ConversationSource.dialpad,
      call,
      actorId: id,
    });
    await upsertConversation({
      source: ConversationSource.fellow,
      call,
      actorId: id,
    });
    // Same id from two providers is two conversations, not a collision.
    expect(await prisma.conversation.count()).toBe(2);
  });
});

describe("ingest attribution", () => {
  it("attributes ingestion to an integration actor with an audit row", async () => {
    const id = await actorId();
    const result = await upsertConversation({
      source: ConversationSource.dialpad,
      call,
      transcript,
      actorId: id,
    });

    const events = await prisma.auditEvent.findMany({
      where: { targetId: result.conversationId, eventType: AUDIT.conversationIngested },
    });
    expect(events).toHaveLength(1);
    expect(events[0].executedByActorId).toBe(id);

    const actor = await prisma.actor.findUniqueOrThrow({ where: { id } });
    expect(actor.kind).toBe("integration");
    expect(actor.integration).toBe(INTEGRATION_ACTORS.dialpadWebhook);
  });

  it("links the conversation to the rep by dialpad user id", async () => {
    const result = await upsertConversation({
      source: ConversationSource.dialpad,
      call,
      actorId: await actorId(),
    });
    const stored = await prisma.conversation.findUniqueOrThrow({
      where: { id: result.conversationId },
      include: { agent: true, participants: true },
    });
    expect(stored.agent?.name).toBe("Dana Whitfield");
    expect(stored.participants.some((p) => p.isExternal)).toBe(true);
  });

  it("marks a call skipped when transcripts are confirmed unavailable", async () => {
    const result = await upsertConversation({
      source: ConversationSource.dialpad,
      call: { ...call, durationSec: 24 },
      transcriptUnavailable: true,
      actorId: await actorId(),
    });
    const stored = await prisma.conversation.findUniqueOrThrow({
      where: { id: result.conversationId },
    });
    expect(stored.transcriptStatus).toBe(TranscriptStatus.unavailable);
    expect(stored.analysisStatus).toBe(AnalysisStatus.skipped);
  });

  it("leaves a call pending when the transcript fetch merely errored", async () => {
    // An errored fetch is not a definite answer, so the backfill must retry it.
    const result = await upsertConversation({
      source: ConversationSource.dialpad,
      call,
      transcriptUnavailable: false,
      actorId: await actorId(),
    });
    const stored = await prisma.conversation.findUniqueOrThrow({
      where: { id: result.conversationId },
    });
    expect(stored.transcriptStatus).toBe(TranscriptStatus.pending);
  });
});
