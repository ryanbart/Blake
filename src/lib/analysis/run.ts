import { prisma } from "@/lib/db";
import {
  AnalysisStatus,
  ActorKind,
  Severity,
  type Conversation,
} from "@/generated/prisma/client";
import { AnalysisSchema, reconcile, type AnalysisResult } from "./schema";
import { ClaudeAnalyzer, hasAnthropicKey, AnalysisError } from "./claude";
import { analyzeHeuristically } from "./heuristic";
import type { CallContext, TranscriptForPrompt } from "./prompt";
import { runRules } from "./rules";
import {
  getAiActor,
  getSystemActor,
  SYSTEM_ACTORS,
} from "@/lib/provenance/actors";
import { AUDIT, recordAudit } from "@/lib/provenance/audit";

export interface AnalyzeOptions {
  /** Re-analyze conversations that already have an analysis. */
  force?: boolean;
  /** Cap the number processed in one run. */
  limit?: number;
  /** Skip calls shorter than this. Voicemails and misdials teach nothing. */
  minSeconds?: number;
  /** Force the heuristic path even when a key is present. */
  heuristicOnly?: boolean;
}

export interface AnalyzeSummary {
  considered: number;
  analyzed: number;
  skipped: number;
  failed: number;
  usedModel: boolean;
  tokensUsed: number;
  cacheReadTokens: number;
  droppedSlugs: string[];
}

const SEVERITY: Record<string, Severity> = {
  low: Severity.low,
  medium: Severity.medium,
  high: Severity.high,
  critical: Severity.critical,
};

/**
 * Analyze pending conversations.
 *
 * Rule findings are written first and independently of the model path, so a
 * missing API key, a rate limit, or a refusal never costs us compliance
 * flagging. The model adds judgment on top of that floor rather than being
 * the floor.
 */
export async function analyzePending(
  opts: AnalyzeOptions = {},
): Promise<AnalyzeSummary> {
  const minSeconds =
    opts.minSeconds ?? Number(process.env.MIN_CALL_SECONDS ?? 45);

  const [dimensions, themes, mappings, rules] = await Promise.all([
    prisma.rubricDimension.findMany(),
    prisma.theme.findMany(),
    prisma.crmFieldMapping.findMany(),
    prisma.rule.findMany(),
  ]);

  const known = {
    dimensions: new Set(dimensions.map((d) => d.slug)),
    themes: new Set(themes.map((t) => t.slug)),
    attributeKeys: new Set(mappings.map((m) => m.attributeKey)),
  };

  const useModel = !opts.heuristicOnly && hasAnthropicKey();
  const analyzer = useModel
    ? new ClaudeAnalyzer({ dimensions, themes, mappings })
    : null;

  const producer = analyzer
    ? await getAiActor(analyzer.model)
    : await getSystemActor(SYSTEM_ACTORS.heuristicAnalyzer);
  const rulesActor = await getSystemActor(SYSTEM_ACTORS.rulesEngine);

  const conversations = await prisma.conversation.findMany({
    where: {
      transcriptStatus: "available",
      ...(opts.force ? {} : { analysisStatus: AnalysisStatus.pending }),
    },
    include: {
      agent: true,
      segments: { orderBy: { startMs: "asc" } },
    },
    orderBy: { startedAt: "desc" },
    take: opts.limit,
  });

  const summary: AnalyzeSummary = {
    considered: conversations.length,
    analyzed: 0,
    skipped: 0,
    failed: 0,
    usedModel: useModel,
    tokensUsed: 0,
    cacheReadTokens: 0,
    droppedSlugs: [],
  };

  for (const conversation of conversations) {
    if (conversation.durationSec < minSeconds || conversation.segments.length === 0) {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { analysisStatus: AnalysisStatus.skipped },
      });
      summary.skipped += 1;
      continue;
    }

    // Rules first: deterministic, cheap, and independent of the model.
    await writeRuleFlags(conversation.id, conversation.segments, rules, rulesActor.id);

    const context: CallContext = {
      title: conversation.title,
      agentName: conversation.agent?.name ?? null,
      direction: conversation.direction,
      durationSec: conversation.durationSec,
      startedAt: conversation.startedAt,
      disposition: conversation.disposition,
      dispositionNotes: conversation.dispositionNotes,
      providerSummary: conversation.providerSummary,
    };
    const transcript: TranscriptForPrompt[] = conversation.segments.map((s) => ({
      speakerRole: s.speakerRole,
      speakerName: s.speakerName,
      startMs: s.startMs,
      text: s.text,
    }));

    try {
      let result: AnalysisResult;
      let tokensUsed = 0;

      if (analyzer) {
        const outcome = await analyzer.analyze(context, transcript, conversation.id);
        result = outcome.result;
        tokensUsed = outcome.tokensUsed;
        summary.tokensUsed += outcome.tokensUsed;
        summary.cacheReadTokens += outcome.cacheReadTokens;
      } else {
        result = AnalysisSchema.parse(
          analyzeHeuristically(context, transcript, { dimensions, themes, mappings }),
        );
      }

      const { result: clean, dropped } = reconcile(result, known);
      summary.droppedSlugs.push(...dropped);

      await persistAnalysis(conversation, clean, producer.id, tokensUsed);
      summary.analyzed += 1;
    } catch (err) {
      summary.failed += 1;
      const message = err instanceof Error ? err.message : String(err);

      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { analysisStatus: AnalysisStatus.failed },
      });
      await recordAudit({
        eventType: AUDIT.analysisFailed,
        executedByActorId: producer.id,
        targetType: "Conversation",
        targetId: conversation.id,
        summary: message.slice(0, 500),
      });

      // A refusal or a bad key is systemic, not per-call: stop rather than
      // burning the whole queue producing identical failures.
      if (err instanceof AnalysisError && /API key|declined/i.test(message)) {
        break;
      }
    }
  }

  return summary;
}

async function writeRuleFlags(
  conversationId: string,
  segments: Array<{ id: string; speakerRole: string; text: string }>,
  rules: Awaited<ReturnType<typeof prisma.rule.findMany>>,
  actorId: string,
): Promise<void> {
  const matches = runRules(
    segments.map((s) => ({
      id: s.id,
      speakerRole: s.speakerRole as never,
      text: s.text,
    })),
    rules,
  );
  if (matches.length === 0) return;

  // Replace this conversation's rule flags so a re-run does not duplicate them.
  // Model-produced flags are left alone; they are keyed by a different actor.
  await prisma.flag.deleteMany({
    where: { conversationId, ruleId: { not: null } },
  });
  await prisma.flag.createMany({
    data: matches.map((m) => ({
      conversationId,
      producedByActorId: actorId,
      severity: m.severity,
      category: m.category,
      title: m.title,
      detail: m.detail,
      quote: m.quote,
      segmentId: m.segmentId,
      ruleId: m.ruleId,
    })),
  });
}

async function persistAnalysis(
  conversation: Conversation & { agentId: string | null },
  result: AnalysisResult,
  producerActorId: string,
  tokensUsed: number,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Model findings are replaced wholesale on re-analysis; rule flags survive
    // because they carry a ruleId and are filtered out here.
    await tx.analysis.deleteMany({ where: { conversationId: conversation.id } });
    await tx.flag.deleteMany({
      where: { conversationId: conversation.id, ruleId: null },
    });
    await tx.trainingOpportunity.deleteMany({
      where: { conversationId: conversation.id },
    });
    await tx.conversationTheme.deleteMany({
      where: { conversationId: conversation.id },
    });

    await tx.analysis.create({
      data: {
        conversationId: conversation.id,
        producedByActorId: producerActorId,
        overallScore: result.overallScore,
        sentiment: result.sentiment,
        summary: result.summary,
        tokensUsed: tokensUsed || null,
        scores: {
          create: result.scores.map((s) => ({
            dimensionSlug: s.dimension,
            score: s.score,
            evidenceQuote: s.evidenceQuote || null,
            rationale: s.rationale || null,
          })),
        },
      },
    });

    for (const issue of result.issues) {
      await tx.flag.create({
        data: {
          conversationId: conversation.id,
          producedByActorId: producerActorId,
          severity: SEVERITY[issue.severity] ?? Severity.medium,
          category: issue.category,
          title: issue.title,
          detail: issue.detail,
          quote: issue.quote || null,
        },
      });
    }

    for (const training of result.trainingOpportunities) {
      await tx.trainingOpportunity.create({
        data: {
          conversationId: conversation.id,
          agentId: conversation.agentId,
          skillSlug: training.skill,
          priority: SEVERITY[training.priority] ?? Severity.medium,
          suggestion: training.suggestion,
          exampleQuote: training.exampleQuote || null,
        },
      });
    }

    for (const theme of result.themes) {
      await tx.conversationTheme.upsert({
        where: {
          conversationId_themeSlug: {
            conversationId: conversation.id,
            themeSlug: theme.theme,
          },
        },
        create: {
          conversationId: conversation.id,
          themeSlug: theme.theme,
          confidence: theme.confidence,
          sentiment: theme.sentiment,
          quote: theme.quote || null,
        },
        update: {
          confidence: theme.confidence,
          sentiment: theme.sentiment,
          quote: theme.quote || null,
        },
      });
    }

    await tx.conversation.update({
      where: { id: conversation.id },
      data: { analysisStatus: AnalysisStatus.analyzed },
    });

    await recordAudit(
      {
        eventType: AUDIT.conversationAnalyzed,
        executedByActorId: producerActorId,
        targetType: "Conversation",
        targetId: conversation.id,
        summary: `Scored ${result.overallScore.toFixed(1)}/5 with ${result.issues.length} issue(s)`,
      },
      tx,
    );
  });
}

/** True when the stored analysis came from a model rather than the fallback. */
export function isModelProduced(actor: { kind: ActorKind }): boolean {
  return actor.kind === ActorKind.ai_agent;
}
