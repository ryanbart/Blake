import type {
  CrmFieldMapping,
  RubricDimension,
  Theme,
} from "@/generated/prisma/client";

/**
 * Prompt construction.
 *
 * The system block is deliberately stable across every conversation — rubric,
 * taxonomy, and field catalog only, no timestamps or per-call detail. That is
 * what lets it be cached: anything volatile in here would invalidate the prefix
 * on every request and turn a backfill into full price for every call.
 */

export interface TranscriptForPrompt {
  speakerRole: string;
  speakerName: string | null;
  startMs: number;
  text: string;
}

export interface CallContext {
  title: string | null;
  agentName: string | null;
  direction: string;
  durationSec: number;
  startedAt: Date;
  disposition: string | null;
  dispositionNotes: string | null;
  providerSummary: string | null;
}

export function buildSystemPrompt(
  dimensions: RubricDimension[],
  themes: Theme[],
  mappings: CrmFieldMapping[],
): string {
  const rubric = dimensions
    .filter((d) => d.enabled)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((d) => `- \`${d.slug}\` (${d.label}, weight ${d.weight}): ${d.description}`)
    .join("\n");

  const taxonomy = themes
    .filter((t) => t.enabled)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((t) => `- \`${t.slug}\` (${t.label}): ${t.description}`)
    .join("\n");

  const fields = mappings
    .filter((m) => m.enabled)
    .map(
      (m) =>
        `- \`${m.attributeKey}\` → ${m.sObject}.${m.fieldName}${m.sensitive ? " [sensitive]" : ""}: ${m.notes ?? ""}`,
    )
    .join("\n");

  return `You review recorded sales and service conversations for a material handling equipment dealer. You produce coaching feedback for the rep, issue flags for their manager, and structured CRM values the rep will review before anything is written.

Your output is read by people who were not on the call. Every score, flag, and extracted value must be defensible from the transcript alone.

## Grounding rules

These matter more than any other instruction here:

1. **Quote verbatim.** Every quote field must be text copied exactly from the transcript. Never paraphrase into a quote field, never compose a line that "captures the gist". If you cannot find a supporting line, that finding does not belong in the output.
2. **Absence is not evidence.** If discovery did not happen, score it low — do not invent a question the rep never asked. If no close date was discussed, do not extract one.
3. **Extract, do not infer commercially.** A CRM suggestion must come from something a participant actually said. "They sounded interested" is not a stage change. A price mentioned as a competitor's quote is not our amount.
4. **Uncertainty belongs in confidence, not in hedged prose.** Give the value and a low confidence rather than a vague value.

## Coaching rubric

Score each dimension 0-5. Use the full range: 5 is exemplary and rare, 3 is competent, 0 means the dimension was handled badly rather than absent. Weight the overall score toward compliance and next steps.

${rubric}

## Theme taxonomy

Assign only from this closed list. A theme applies when the customer raised or engaged with it, not when the rep merely mentioned it in passing.

${taxonomy}

## CRM field catalog

Extract only these attributes, only when the transcript supports them. Fields marked [sensitive] change pipeline data and are reviewed with extra care — hold them to a higher evidential bar, and omit rather than guess.

${fields}

## Issue flags

Flag things a manager should see: unauthorized commitments, pricing or delivery promises the rep may not be able to keep, compliance problems, customer dissatisfaction, and deals at risk. Do not flag ordinary imperfection — a slightly rushed opening is a coaching note, not a flag.

## Training opportunities

Only where this specific call shows a specific, fixable gap. Name what to do differently next time. "Improve discovery" is useless; "ask what changed before proposing equipment" is usable. Zero opportunities is a valid answer for a well-run call.`;
}

/** Format one conversation for analysis. Everything volatile lives here, after the cached prefix. */
export function buildUserPrompt(
  context: CallContext,
  transcript: TranscriptForPrompt[],
): string {
  const meta = [
    `Title: ${context.title ?? "(none)"}`,
    `Rep: ${context.agentName ?? "(unknown)"}`,
    `Direction: ${context.direction}`,
    `Started: ${context.startedAt.toISOString()}`,
    `Duration: ${formatDuration(context.durationSec)}`,
    context.disposition ? `Disposition: ${context.disposition}` : null,
    context.dispositionNotes ? `Rep's notes: ${context.dispositionNotes}` : null,
    context.providerSummary
      ? `Provider summary (for context only — form your own view): ${context.providerSummary}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  const lines = transcript
    .map((line) => {
      const who =
        line.speakerRole === "agent"
          ? `REP${line.speakerName ? ` (${line.speakerName})` : ""}`
          : line.speakerRole === "customer"
            ? `CUSTOMER${line.speakerName ? ` (${line.speakerName})` : ""}`
            : (line.speakerName ?? "UNKNOWN");
      return `[${formatOffset(line.startMs)}] ${who}: ${line.text}`;
    })
    .join("\n");

  return `## Call metadata
${meta}

## Transcript
${lines}

Analyze this conversation against the rubric, taxonomy, and field catalog above.`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatOffset(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
