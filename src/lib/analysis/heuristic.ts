import type {
  CrmFieldMapping,
  RubricDimension,
  Theme,
} from "@/generated/prisma/client";
import type { CallContext, TranscriptForPrompt } from "./prompt";
import type { AnalysisResult } from "./schema";
import { Rng } from "@/lib/seed/random";

/**
 * Deterministic analyzer used when no ANTHROPIC_API_KEY is present.
 *
 * This exists so a contributor with no credentials still gets a fully populated
 * dashboard — an empty app is impossible to evaluate or develop against. It is
 * pattern matching, not judgment, and the UI badges its output `heuristic`
 * rather than presenting it as model analysis. That labelling is the point: the
 * failure mode to avoid is a demo that looks like AI output and is not.
 */

const SIGNALS = {
  openQuestion: /\b(what|how|why|when|who|which)\b[^?]*\?/i,
  datedCommitment:
    /\b(monday|tuesday|wednesday|thursday|friday|by (the )?\d{1,2}(st|nd|rd|th)?|end of day|tomorrow|next week)\b/i,
  vagueFollowUp: /\b(follow up soon|circle back|touch base|reach out soon)\b/i,
  guarantee: /\b(guarantee|i promise|you have my word)\b/i,
  discount: /\b\d{1,2}\s?(%|percent)\s?(off|discount)|knock off\b/i,
  competitor:
    /\b(crown equipment|toyota material handling|hyster|yale|raymond)\b/i,
  priceTalk: /\b(price|pricing|quote|cost|budget|\$\s?\d|per unit)\b/i,
  stock: /\b(in stock|backorder|back order|on the shelf|availability|lead time)\b/i,
  delivery: /\b(deliver|delivery|freight|ship|shipping|on site|install)\b/i,
  escalation:
    /\b(unacceptable|speak to (a|your) (manager|supervisor)|business elsewhere|cancel (my|the) (order|account))\b/i,
  billing: /\b(invoice|net \d+|payment terms|credit application|billing)\b/i,
  service: /\b(service contract|response time|uptime|parts|maintenance|warranty)\b/i,
  hedging: /\b(honestly|just a better|everyone who|the best on the market)\b/i,
};

interface Scored {
  slug: string;
  score: number;
  quote: string;
  rationale: string;
}

export function analyzeHeuristically(
  context: CallContext,
  transcript: TranscriptForPrompt[],
  config: {
    dimensions: RubricDimension[];
    themes: Theme[];
    mappings: CrmFieldMapping[];
  },
): AnalysisResult {
  const agentLines = transcript.filter((l) => l.speakerRole === "agent");
  const customerLines = transcript.filter((l) => l.speakerRole === "customer");
  const agentText = agentLines.map((l) => l.text).join(" ");
  const allText = transcript.map((l) => l.text).join(" ");

  // Seeded on the transcript so the same call always scores the same. A
  // fallback that produced different numbers each run would be worse than none.
  const rng = new Rng(hashString(allText));

  const find = (re: RegExp, lines = transcript): string =>
    lines.find((l) => re.test(l.text))?.text ?? "";

  const questionCount = agentLines.filter((l) =>
    SIGNALS.openQuestion.test(l.text),
  ).length;
  const hasDatedCommitment = SIGNALS.datedCommitment.test(agentText);
  const hasVagueFollowUp = SIGNALS.vagueFollowUp.test(agentText);
  const hasGuarantee = SIGNALS.guarantee.test(agentText);
  const hasDiscount = SIGNALS.discount.test(agentText);
  const hasEscalation = SIGNALS.escalation.test(
    customerLines.map((l) => l.text).join(" "),
  );
  const hedges = SIGNALS.hedging.test(agentText);

  const clamp = (n: number) => Math.max(0, Math.min(5, Number(n.toFixed(1))));
  const jitter = () => (rng.next() - 0.5) * 0.6;

  const scored: Scored[] = [];
  const enabled = new Set(config.dimensions.filter((d) => d.enabled).map((d) => d.slug));

  if (enabled.has("opening")) {
    const introduced = /united material handling|this is |speaking/i.test(
      agentLines[0]?.text ?? "",
    );
    scored.push({
      slug: "opening",
      score: clamp((introduced ? 3.8 : 2.2) + jitter()),
      quote: agentLines[0]?.text ?? "",
      rationale: introduced
        ? "Identified themselves and the company at the top of the call."
        : "Opened without a clear introduction.",
    });
  }

  if (enabled.has("discovery")) {
    const base = questionCount >= 4 ? 4.4 : questionCount >= 2 ? 3.2 : 1.4;
    scored.push({
      slug: "discovery",
      score: clamp(base + jitter()),
      quote: find(SIGNALS.openQuestion, agentLines),
      rationale: `${questionCount} open question${questionCount === 1 ? "" : "s"} from the rep.`,
    });
  }

  if (enabled.has("product_knowledge")) {
    scored.push({
      slug: "product_knowledge",
      score: clamp((hedges ? 1.8 : 3.6) + jitter()),
      quote: hedges ? find(SIGNALS.hedging, agentLines) : (agentLines[1]?.text ?? ""),
      rationale: hedges
        ? "Answered a product question with generalities rather than specifics."
        : "Answers were specific to the customer's situation.",
    });
  }

  if (enabled.has("objection_handling")) {
    const objection = customerLines.some((l) =>
      /\b(higher than|too much|not sure|cannot|hoped|expensive)\b/i.test(l.text),
    );
    const base = !objection ? 3.0 : hasDiscount ? 1.6 : 3.9;
    scored.push({
      slug: "objection_handling",
      score: clamp(base + jitter()),
      quote: find(/\b(higher than|too much|hoped)\b/i, customerLines),
      rationale: hasDiscount
        ? "Answered a price objection by discounting rather than by understanding it."
        : objection
          ? "Engaged with the objection before responding."
          : "No substantive objection was raised.",
    });
  }

  if (enabled.has("next_steps")) {
    const base = hasDatedCommitment ? 4.5 : hasVagueFollowUp ? 1.3 : 2.4;
    scored.push({
      slug: "next_steps",
      score: clamp(base + jitter()),
      quote: hasDatedCommitment
        ? find(SIGNALS.datedCommitment, agentLines)
        : find(SIGNALS.vagueFollowUp, agentLines),
      rationale: hasDatedCommitment
        ? "Closed with a specific dated commitment."
        : "Ended without a dated next step.",
    });
  }

  if (enabled.has("compliance")) {
    const breaches = (hasGuarantee ? 1 : 0) + (hasDiscount ? 1 : 0);
    scored.push({
      slug: "compliance",
      score: clamp((breaches === 0 ? 4.7 : breaches === 1 ? 2.0 : 0.6) + jitter() * 0.4),
      quote: hasGuarantee
        ? find(SIGNALS.guarantee, agentLines)
        : find(SIGNALS.discount, agentLines),
      rationale:
        breaches === 0
          ? "No unauthorized commitments."
          : `${breaches} unauthorized commitment${breaches === 1 ? "" : "s"} made on the call.`,
    });
  }

  if (enabled.has("tone")) {
    scored.push({
      slug: "tone",
      score: clamp((hasEscalation ? 3.4 : 4.0) + jitter()),
      quote: agentLines[agentLines.length - 1]?.text ?? "",
      rationale: hasEscalation
        ? "Stayed composed with an upset customer."
        : "Professional throughout.",
    });
  }

  const weightBySlug = new Map(config.dimensions.map((d) => [d.slug, d.weight]));
  const weightTotal = scored.reduce(
    (sum, s) => sum + (weightBySlug.get(s.slug) ?? 1),
    0,
  );
  const overall =
    weightTotal > 0
      ? scored.reduce(
          (sum, s) => sum + s.score * (weightBySlug.get(s.slug) ?? 1),
          0,
        ) / weightTotal
      : 0;

  // Themes
  const themeSlugs = new Set(config.themes.filter((t) => t.enabled).map((t) => t.slug));
  const themes: AnalysisResult["themes"] = [];
  const addTheme = (
    slug: string,
    re: RegExp,
    sentiment: "positive" | "neutral" | "negative" | "mixed",
  ) => {
    if (!themeSlugs.has(slug)) return;
    const quote = find(re);
    if (!quote) return;
    themes.push({ theme: slug, confidence: 0.55 + rng.next() * 0.35, sentiment, quote });
  };
  addTheme("pricing", SIGNALS.priceTalk, hasDiscount ? "negative" : "neutral");
  addTheme("inventory", SIGNALS.stock, "neutral");
  addTheme("delivery", SIGNALS.delivery, hasEscalation ? "negative" : "neutral");
  addTheme("competitor", SIGNALS.competitor, "mixed");
  addTheme("escalation", SIGNALS.escalation, "negative");
  addTheme("billing", SIGNALS.billing, "neutral");
  addTheme("service_support", SIGNALS.service, "positive");

  // Issues
  const issues: AnalysisResult["issues"] = [];
  if (hasGuarantee) {
    issues.push({
      severity: "critical",
      category: "compliance",
      title: "Unauthorized guarantee",
      detail: "The rep guaranteed an outcome. Only a manager can make a guarantee.",
      quote: find(SIGNALS.guarantee, agentLines),
    });
  }
  if (hasDiscount) {
    issues.push({
      severity: "high",
      category: "compliance",
      title: "Discount offered without approval",
      detail: "A specific discount was offered verbally before approval.",
      quote: find(SIGNALS.discount, agentLines),
    });
  }
  if (hasEscalation) {
    issues.push({
      severity: "high",
      category: "risk",
      title: "Customer threatened to leave",
      detail: "The customer raised escalation language. Should reach a manager today.",
      quote: find(SIGNALS.escalation, customerLines),
    });
  }
  if (hasVagueFollowUp && !hasDatedCommitment) {
    issues.push({
      severity: "medium",
      category: "process",
      title: "No dated next step",
      detail: "The call closed without a commitment anyone can hold.",
      quote: find(SIGNALS.vagueFollowUp, agentLines),
    });
  }

  // Training opportunities
  const training: AnalysisResult["trainingOpportunities"] = [];
  if (questionCount < 2 && enabled.has("discovery")) {
    training.push({
      skill: "discovery",
      priority: "high",
      suggestion:
        "Ask what changed for the customer before proposing any equipment. One 'what prompted this?' would have reframed the whole call.",
      exampleQuote: agentLines[1]?.text ?? "",
    });
  }
  if (hasVagueFollowUp && enabled.has("next_steps")) {
    training.push({
      skill: "next_steps",
      priority: "medium",
      suggestion:
        "Replace 'I'll follow up soon' with a named day and a named deliverable, then confirm it back.",
      exampleQuote: find(SIGNALS.vagueFollowUp, agentLines),
    });
  }
  if (hasDiscount && enabled.has("objection_handling")) {
    training.push({
      skill: "objection_handling",
      priority: "high",
      suggestion:
        "When price comes up, ask what it is being compared against before moving on price.",
      exampleQuote: find(SIGNALS.discount, agentLines),
    });
  }

  // CRM suggestions — only the safest fields, and only with a real quote.
  const known = new Set(config.mappings.filter((m) => m.enabled).map((m) => m.attributeKey));
  const crmSuggestions: AnalysisResult["crmSuggestions"] = [];
  if (known.has("next_step") && hasDatedCommitment) {
    const quote = find(SIGNALS.datedCommitment, agentLines);
    crmSuggestions.push({
      attributeKey: "next_step",
      value: quote.slice(0, 240),
      confidence: 0.6,
      quote,
      rationale: "The rep stated a dated commitment on the call.",
    });
  }

  const sentiment: AnalysisResult["sentiment"] = hasEscalation
    ? "negative"
    : overall >= 3.8
      ? "positive"
      : overall >= 2.5
        ? "neutral"
        : "mixed";

  return {
    summary: buildSummary(context, {
      overall,
      hasEscalation,
      hasGuarantee,
      hasDiscount,
      hasDatedCommitment,
      questionCount,
    }),
    overallScore: clamp(overall),
    sentiment,
    scores: scored.map((s) => ({
      dimension: s.slug,
      score: s.score,
      evidenceQuote: s.quote,
      rationale: s.rationale,
    })),
    issues,
    trainingOpportunities: training,
    themes,
    crmSuggestions,
    discoveredContacts: [],
    commitments: hasDatedCommitment
      ? [
          {
            text: find(SIGNALS.datedCommitment, agentLines).slice(0, 240),
            owner: "agent" as const,
            dueDate: "",
            quote: find(SIGNALS.datedCommitment, agentLines),
          },
        ]
      : [],
  };
}

function buildSummary(
  context: CallContext,
  facts: {
    overall: number;
    hasEscalation: boolean;
    hasGuarantee: boolean;
    hasDiscount: boolean;
    hasDatedCommitment: boolean;
    questionCount: number;
  },
): string {
  const parts: string[] = [];
  parts.push(
    facts.hasEscalation
      ? "The customer raised a complaint and referenced escalation."
      : `A ${context.direction} call lasting ${Math.round(context.durationSec / 60)} minutes.`,
  );
  if (facts.hasGuarantee || facts.hasDiscount) {
    parts.push(
      "The rep made a commitment that normally needs approval, which is the main thing to review here.",
    );
  }
  parts.push(
    facts.hasDatedCommitment
      ? "The call closed with a dated next step."
      : "The call closed without a dated next step.",
  );
  parts.push(
    `Pattern analysis only — no model was used to produce this summary.`,
  );
  return parts.join(" ");
}

function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
