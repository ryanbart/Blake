import { RuleTarget, SpeakerRole, type Rule, type Severity } from "@/generated/prisma/client";

/**
 * Deterministic rule matching over transcript segments.
 *
 * These findings exist so compliance flagging never depends on model
 * availability, cost, or judgment. Anything a pattern catches reliably belongs
 * here; the model is for the things a pattern cannot judge.
 */

export interface RuleInputSegment {
  id?: string;
  speakerRole: SpeakerRole;
  text: string;
}

export interface RuleMatch {
  ruleId: string;
  segmentId: string | null;
  severity: Severity;
  category: string;
  title: string;
  detail: string | null;
  /** The full segment, so a reviewer sees the sentence rather than a fragment. */
  quote: string;
  /** Exactly what the pattern matched, for highlighting inside the quote. */
  matchedText: string;
}

/**
 * Longest single segment we will run a pattern against.
 *
 * Rules are admin-editable, so a pattern with catastrophic backtracking is a
 * plausible accident. Matching per-segment already keeps inputs short; this cap
 * bounds the pathological case rather than trusting every future edit. Node has
 * no regex timeout, so bounding the input is the available lever.
 */
const MAX_SEGMENT_CHARS = 4_000;

export class InvalidRulePatternError extends Error {
  constructor(
    readonly ruleName: string,
    cause: unknown,
  ) {
    super(
      `Rule "${ruleName}" has an invalid pattern: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "InvalidRulePatternError";
  }
}

/** Compile a rule to a RegExp. Literal patterns are escaped, not interpreted. */
export function compileRule(rule: Pick<Rule, "name" | "pattern" | "isRegex" | "caseSensitive">): RegExp {
  const source = rule.isRegex ? rule.pattern : escapeLiteral(rule.pattern);
  const flags = rule.caseSensitive ? "g" : "gi";
  try {
    return new RegExp(source, flags);
  } catch (err) {
    throw new InvalidRulePatternError(rule.name, err);
  }
}

function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function appliesToSegment(target: RuleTarget, role: SpeakerRole): boolean {
  if (target === RuleTarget.any) return true;
  if (target === RuleTarget.agent) return role === SpeakerRole.agent;
  if (target === RuleTarget.customer) return role === SpeakerRole.customer;
  return false;
}

/**
 * Run enabled rules over a transcript.
 *
 * At most one match per (rule, segment): a rep who says "guarantee" three times
 * in one sentence has made one mistake, not three, and a flag list padded with
 * duplicates is one a manager stops reading.
 */
export function runRules(
  segments: RuleInputSegment[],
  rules: Rule[],
): RuleMatch[] {
  const matches: RuleMatch[] = [];

  const compiled = rules
    .filter((r) => r.enabled)
    .map((rule) => ({ rule, regex: compileRule(rule) }));

  for (const segment of segments) {
    const text = segment.text.slice(0, MAX_SEGMENT_CHARS);
    if (!text.trim()) continue;

    for (const { rule, regex } of compiled) {
      if (!appliesToSegment(rule.appliesTo, segment.speakerRole)) continue;

      regex.lastIndex = 0; // `g` regexes carry state between calls
      const found = regex.exec(text);
      if (!found) continue;

      matches.push({
        ruleId: rule.id,
        segmentId: segment.id ?? null,
        severity: rule.severity,
        category: rule.category,
        title: rule.name,
        detail: rule.description,
        quote: segment.text,
        matchedText: found[0],
      });
    }
  }

  return matches;
}

/**
 * Preview a single pattern without touching the database — powers the
 * "test against recent conversations" box in the rules editor, so an author
 * sees what a pattern catches before it starts flagging live calls.
 */
export function previewRule(
  pattern: string,
  opts: { isRegex: boolean; caseSensitive: boolean; appliesTo: RuleTarget },
  segments: RuleInputSegment[],
): RuleInputSegment[] {
  const regex = compileRule({
    name: "preview",
    pattern,
    isRegex: opts.isRegex,
    caseSensitive: opts.caseSensitive,
  });

  return segments.filter((segment) => {
    if (!appliesToSegment(opts.appliesTo, segment.speakerRole)) return false;
    regex.lastIndex = 0;
    return regex.test(segment.text.slice(0, MAX_SEGMENT_CHARS));
  });
}
