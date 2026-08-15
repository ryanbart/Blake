import { prisma } from "@/lib/db";
import {
  AnalysisStatus,
  ConversationSource,
  Direction,
  SpeakerRole,
  TranscriptStatus,
} from "@/generated/prisma/client";
import { AUDIT, recordAudit } from "@/lib/provenance/audit";
import type { NormalizedCall, TranscriptLine } from "@/lib/dialpad/types";

export interface UpsertInput {
  source: ConversationSource;
  call: NormalizedCall;
  transcript?: TranscriptLine[] | null;
  /** Set when transcripts are confirmed unavailable rather than just absent. */
  transcriptUnavailable?: boolean;
  actorId: string;
  contact?: { name?: string | null; email?: string | null; phone?: string | null };
}

export interface UpsertResult {
  conversationId: string;
  created: boolean;
  transcriptWritten: boolean;
}

/**
 * Idempotent conversation ingest.
 *
 * Keyed on (source, sourceId), which is what makes a replayed webhook and an
 * overlapping backfill window no-ops rather than duplicates. The nightly
 * backfill deliberately re-covers days the webhooks already delivered, so this
 * is the load-bearing guarantee for the whole ingest design, not a nicety.
 *
 * A second delivery is allowed to *enrich*: webhooks arrive at hangup without a
 * transcript, and the backfill later brings one. What it must never do is
 * duplicate the row or wipe an analysis that already ran.
 */
export async function upsertConversation(
  input: UpsertInput,
): Promise<UpsertResult> {
  const { call, source, actorId } = input;

  const existing = await prisma.conversation.findUnique({
    where: { source_sourceId: { source, sourceId: call.sourceId } },
    include: { segments: { take: 1 } },
  });

  const agent = call.dialpadUserId
    ? await prisma.agent.findUnique({ where: { dialpadUserId: call.dialpadUserId } })
    : null;

  const hasTranscript = (input.transcript?.length ?? 0) > 0;
  const transcriptStatus = hasTranscript
    ? TranscriptStatus.available
    : input.transcriptUnavailable
      ? TranscriptStatus.unavailable
      : TranscriptStatus.pending;

  if (existing) {
    // Only add a transcript we did not already have; never replace one.
    const shouldWriteTranscript = hasTranscript && existing.segments.length === 0;

    await prisma.$transaction(async (tx) => {
      await tx.conversation.update({
        where: { id: existing.id },
        data: {
          // Later deliveries carry the final duration and disposition.
          durationSec: Math.max(existing.durationSec, call.durationSec),
          disposition: call.disposition ?? existing.disposition,
          dispositionNotes: call.dispositionNotes ?? existing.dispositionNotes,
          recordingUrl: call.recordingUrl ?? existing.recordingUrl,
          agentId: existing.agentId ?? agent?.id ?? null,
          ...(shouldWriteTranscript
            ? {
                transcriptStatus: TranscriptStatus.available,
                // A newly-arrived transcript makes an untouched call analyzable
                // again, but must not undo an analysis that already ran.
                analysisStatus:
                  existing.analysisStatus === AnalysisStatus.analyzed
                    ? existing.analysisStatus
                    : AnalysisStatus.pending,
                segments: {
                  create: (input.transcript ?? []).map(toSegment),
                },
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
            summary: `Transcript added to ${call.sourceId} (${input.transcript?.length ?? 0} lines)`,
          },
          tx,
        );
      }
    });

    return {
      conversationId: existing.id,
      created: false,
      transcriptWritten: shouldWriteTranscript,
    };
  }

  const created = await prisma.$transaction(async (tx) => {
    const conversation = await tx.conversation.create({
      data: {
        source,
        sourceId: call.sourceId,
        title: call.contactName
          ? `${call.contactName}${call.contactPhone ? ` (${call.contactPhone})` : ""}`
          : null,
        direction: toDirection(call.direction),
        agentId: agent?.id ?? null,
        startedAt: call.startedAt,
        durationSec: call.durationSec,
        recordingUrl: call.recordingUrl,
        disposition: call.disposition,
        dispositionNotes: call.dispositionNotes,
        transcriptStatus,
        analysisStatus: hasTranscript
          ? AnalysisStatus.pending
          : input.transcriptUnavailable
            ? AnalysisStatus.skipped
            : AnalysisStatus.pending,
        participants: {
          create: [
            ...(agent
              ? [
                  {
                    name: agent.name,
                    email: agent.email,
                    isExternal: false,
                    role: "agent",
                  },
                ]
              : []),
            ...(call.contactName || call.contactPhone || input.contact?.email
              ? [
                  {
                    name: input.contact?.name ?? call.contactName ?? null,
                    email: input.contact?.email ?? null,
                    phone: input.contact?.phone ?? call.contactPhone ?? null,
                    isExternal: true,
                    role: "customer",
                  },
                ]
              : []),
          ],
        },
        segments: hasTranscript
          ? { create: (input.transcript ?? []).map(toSegment) }
          : undefined,
      },
    });

    await recordAudit(
      {
        eventType: AUDIT.conversationIngested,
        executedByActorId: actorId,
        targetType: "Conversation",
        targetId: conversation.id,
        summary: `Ingested ${source} call ${call.sourceId}`,
      },
      tx,
    );

    return conversation;
  });

  return {
    conversationId: created.id,
    created: true,
    transcriptWritten: hasTranscript,
  };
}

function toSegment(line: TranscriptLine) {
  return {
    speakerRole: toSpeakerRole(line.speakerLabel),
    speakerName: line.speakerName,
    startMs: line.startMs,
    text: line.text,
  };
}

/**
 * Map a provider speaker label onto our two-sided model.
 *
 * Dialpad's vocabulary varies by plan, so this accepts the several labels seen
 * in the wild and falls back to `unknown` rather than guessing. An unknown
 * speaker is excluded from agent-targeted rules, which is the safe direction:
 * better to miss a flag than to blame a rep for the customer's words.
 */
export function toSpeakerRole(label: string | null): SpeakerRole {
  if (!label) return SpeakerRole.unknown;
  const normalized = label.toLowerCase();
  if (["agent", "internal", "operator", "user", "rep"].includes(normalized)) {
    return SpeakerRole.agent;
  }
  if (["external", "customer", "contact", "caller"].includes(normalized)) {
    return SpeakerRole.customer;
  }
  return SpeakerRole.unknown;
}

function toDirection(direction: NormalizedCall["direction"]): Direction {
  if (direction === "inbound") return Direction.inbound;
  if (direction === "internal") return Direction.internal;
  return Direction.outbound;
}
