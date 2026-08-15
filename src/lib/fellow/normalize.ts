import { prisma } from "@/lib/db";
import {
  AnalysisStatus,
  ConversationSource,
  Direction,
  SpeakerRole,
  TranscriptStatus,
} from "@/generated/prisma/client";
import { AUDIT, recordAudit } from "@/lib/provenance/audit";
import {
  matchSpeakerToParticipant,
  type FellowMeeting,
  type FellowTranscriptLine,
} from "./types";

export interface NormalizedSegment {
  speakerRole: SpeakerRole;
  speakerName: string | null;
  startMs: number;
  text: string;
}

export interface NormalizedMeeting {
  segments: NormalizedSegment[];
  /** True when at least one attendee is outside the organization. */
  isCustomerFacing: boolean;
  /** Share of lines whose speaker could not be resolved to a participant. */
  unmatchedSpeakerRatio: number;
}

/**
 * Turn a Fellow meeting into our segment model.
 *
 * The hard part is the speaker side. Dialpad labels each line agent/external;
 * Fellow gives a display name, so the side has to be derived by matching that
 * name back to the participant list where `is_external` lives. Anything that
 * cannot be matched stays `unknown`, which is excluded from agent-targeted
 * rules — the safe direction.
 */
export function normalizeMeeting(
  meeting: FellowMeeting,
  transcript: FellowTranscriptLine[],
): NormalizedMeeting {
  const isCustomerFacing = meeting.participants.some((p) => p.isExternal);

  let unmatched = 0;
  const segments: NormalizedSegment[] = transcript.map((line) => {
    const participant = matchSpeakerToParticipant(
      line.speakerName,
      meeting.participants,
    );
    if (!participant) unmatched += 1;

    return {
      // "agent" means our side of the conversation, which for a meeting is the
      // internal attendee. On an internal meeting everyone is internal, which
      // is exactly why those are not scored on a sales rubric.
      speakerRole: !participant
        ? SpeakerRole.unknown
        : participant.isExternal
          ? SpeakerRole.customer
          : SpeakerRole.agent,
      speakerName: participant?.name ?? line.speakerName,
      startMs: line.startMs,
      text: line.text,
    };
  });

  return {
    segments,
    isCustomerFacing,
    unmatchedSpeakerRatio:
      transcript.length === 0 ? 0 : unmatched / transcript.length,
  };
}

export interface UpsertMeetingInput {
  meeting: FellowMeeting;
  transcript: FellowTranscriptLine[] | null;
  transcriptUnavailable?: boolean;
  actorId: string;
}

export interface UpsertMeetingResult {
  conversationId: string;
  created: boolean;
  transcriptWritten: boolean;
  isCustomerFacing: boolean;
  skippedInternal: boolean;
  /**
   * False when no internal attendee matched an Agent row. The meeting is still
   * stored, but it will not appear on any agent view — callers surface this
   * rather than letting attribution fail quietly.
   */
  agentMatched: boolean;
}

/**
 * Idempotent meeting ingest, keyed on (fellow, meetingId).
 *
 * Mirrors the Dialpad path deliberately: a replayed webhook or an overlapping
 * backfill window must be a no-op, and a later delivery may enrich but never
 * destroy.
 */
export async function upsertMeeting(
  input: UpsertMeetingInput,
): Promise<UpsertMeetingResult> {
  const { meeting, actorId } = input;
  const transcript = input.transcript ?? [];
  const normalized = normalizeMeeting(meeting, transcript);
  const hasTranscript = normalized.segments.length > 0;

  // Match the internal attendee to a rep so meetings land on agent views.
  const internalEmails = meeting.participants
    .filter((p) => !p.isExternal)
    .map((p) => p.email);
  const agent =
    internalEmails.length > 0
      ? await prisma.agent.findFirst({
          where: { email: { in: internalEmails, mode: "insensitive" } },
        })
      : null;

  const transcriptStatus = hasTranscript
    ? TranscriptStatus.available
    : input.transcriptUnavailable
      ? TranscriptStatus.unavailable
      : TranscriptStatus.pending;

  /**
   * Internal meetings are ingested but never scored.
   *
   * A standup run through a sales rubric produces meaningless numbers that
   * drag down a rep's average, and its action items are not CRM material. It
   * is still worth storing — it is real conversation history — so it is
   * recorded and marked `skipped` rather than dropped.
   */
  const analysisStatus = !normalized.isCustomerFacing
    ? AnalysisStatus.skipped
    : hasTranscript
      ? AnalysisStatus.pending
      : input.transcriptUnavailable
        ? AnalysisStatus.skipped
        : AnalysisStatus.pending;

  const existing = await prisma.conversation.findUnique({
    where: {
      source_sourceId: {
        source: ConversationSource.fellow,
        sourceId: meeting.meetingId,
      },
    },
    include: { segments: { take: 1 } },
  });

  if (existing) {
    const shouldWriteTranscript = hasTranscript && existing.segments.length === 0;

    await prisma.$transaction(async (tx) => {
      await tx.conversation.update({
        where: { id: existing.id },
        data: {
          title: meeting.title ?? existing.title,
          durationSec: Math.max(existing.durationSec, meeting.durationSec),
          recordingUrl: meeting.recordingUrl ?? existing.recordingUrl,
          externalUrl: meeting.externalUrl ?? existing.externalUrl,
          providerSummary: meeting.summary ?? existing.providerSummary,
          agentId: existing.agentId ?? agent?.id ?? null,
          ...(shouldWriteTranscript
            ? {
                transcriptStatus: TranscriptStatus.available,
                analysisStatus:
                  existing.analysisStatus === AnalysisStatus.analyzed
                    ? existing.analysisStatus
                    : analysisStatus,
                segments: { create: normalized.segments },
              }
            : {}),
        },
      });

      if (shouldWriteTranscript) {
        await recordAudit(
          {
            eventType: AUDIT.conversationIngested,
            executedByActorId: actorId,
            targetType: "Conversation",
            targetId: existing.id,
            summary: `Transcript added to Fellow meeting ${meeting.meetingId} (${normalized.segments.length} lines)`,
          },
          tx,
        );
      }
    });

    return {
      conversationId: existing.id,
      created: false,
      transcriptWritten: shouldWriteTranscript,
      isCustomerFacing: normalized.isCustomerFacing,
      skippedInternal: !normalized.isCustomerFacing,
      agentMatched: Boolean(existing.agentId ?? agent),
    };
  }

  const created = await prisma.$transaction(async (tx) => {
    const conversation = await tx.conversation.create({
      data: {
        source: ConversationSource.fellow,
        sourceId: meeting.meetingId,
        title: meeting.title,
        // A meeting has no inbound/outbound sense; internal is the honest label
        // for one with no external attendee.
        direction: normalized.isCustomerFacing
          ? Direction.outbound
          : Direction.internal,
        agentId: agent?.id ?? null,
        startedAt: meeting.startedAt,
        durationSec: meeting.durationSec,
        recordingUrl: meeting.recordingUrl,
        externalUrl: meeting.externalUrl,
        providerSummary: meeting.summary,
        dispositionNotes: meeting.notes,
        transcriptStatus,
        analysisStatus,
        participants: {
          create: meeting.participants.map((p) => ({
            name: p.name,
            email: p.email,
            isExternal: p.isExternal,
            role: p.isOrganizer ? "organizer" : p.isExternal ? "customer" : "agent",
          })),
        },
        segments: hasTranscript ? { create: normalized.segments } : undefined,
      },
    });

    await recordAudit(
      {
        eventType: AUDIT.conversationIngested,
        executedByActorId: actorId,
        targetType: "Conversation",
        targetId: conversation.id,
        summary: normalized.isCustomerFacing
          ? `Ingested Fellow meeting ${meeting.meetingId}`
          : `Ingested internal Fellow meeting ${meeting.meetingId} (not scored)`,
      },
      tx,
    );

    return conversation;
  });

  return {
    conversationId: created.id,
    created: true,
    transcriptWritten: hasTranscript,
    isCustomerFacing: normalized.isCustomerFacing,
    skippedInternal: !normalized.isCustomerFacing,
    agentMatched: Boolean(agent),
  };
}
