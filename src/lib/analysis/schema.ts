import { z } from "zod";

/**
 * The analysis contract.
 *
 * This schema is the single source of truth: it is handed to the model as the
 * structured-output format AND used to build the Prisma writes. Model output and
 * database shape therefore cannot drift — a field added here is a field the
 * model is told about and a field we know how to persist, in one edit.
 */

export const SentimentEnum = z.enum(["positive", "neutral", "negative", "mixed"]);
export type Sentiment = z.infer<typeof SentimentEnum>;

export const SeverityEnum = z.enum(["low", "medium", "high", "critical"]);

export const ScoreItemSchema = z.object({
  dimension: z
    .string()
    .describe("Rubric dimension slug, exactly as listed in the rubric."),
  score: z
    .number()
    .min(0)
    .max(5)
    .describe("0-5. Use the whole range; 3 is competent, not a default."),
  evidenceQuote: z
    .string()
    .describe(
      "A verbatim line from the transcript supporting this score. Empty string only if the dimension genuinely did not arise.",
    ),
  rationale: z
    .string()
    .describe("One sentence. What the rep did or failed to do, not a restatement of the score."),
});

export const IssueFlagSchema = z.object({
  severity: SeverityEnum,
  category: z
    .string()
    .describe("Short slug: compliance, process, risk, competitive, operations, coaching."),
  title: z.string().describe("Under 60 characters."),
  detail: z.string().describe("What went wrong and why it matters."),
  quote: z.string().describe("Verbatim transcript line demonstrating the issue."),
});

export const TrainingOpportunitySchema = z.object({
  skill: z
    .string()
    .describe("Rubric dimension slug this would improve."),
  priority: SeverityEnum,
  suggestion: z
    .string()
    .describe(
      "Concrete and actionable. Name what to do differently next time, not 'improve discovery'.",
    ),
  exampleQuote: z.string().describe("The moment from this call to review together."),
});

export const ThemeMatchSchema = z.object({
  theme: z.string().describe("Theme slug, exactly as listed in the taxonomy."),
  confidence: z.number().min(0).max(1),
  sentiment: SentimentEnum.describe("The customer's stance on this specific theme."),
  quote: z.string().describe("Verbatim line where the theme appears."),
});

export const CrmSuggestionSchema = z.object({
  attributeKey: z
    .string()
    .describe("Attribute key from the CRM field catalog, exactly as listed."),
  value: z
    .string()
    .describe("The extracted value as a plain string. Dates as YYYY-MM-DD."),
  confidence: z.number().min(0).max(1),
  quote: z
    .string()
    .describe(
      "Verbatim line this was drawn from. A suggestion without evidence is not reviewable.",
    ),
  rationale: z.string().describe("One sentence justifying the extraction."),
});

export const DiscoveredContactSchema = z.object({
  name: z.string(),
  title: z.string().describe("Empty string if not stated."),
  email: z.string().describe("Empty string if not stated."),
  phone: z.string().describe("Empty string if not stated."),
  role: z
    .string()
    .describe("Their role in this deal, e.g. 'signs off above 50k'. Empty string if unclear."),
  quote: z.string(),
});

export const CommitmentSchema = z.object({
  text: z.string().describe("What was promised, in the promiser's terms."),
  owner: z.enum(["agent", "customer"]),
  dueDate: z
    .string()
    .describe("YYYY-MM-DD if a date was stated or clearly implied, otherwise empty string."),
  quote: z.string(),
});

export const AnalysisSchema = z.object({
  summary: z
    .string()
    .describe(
      "2-4 sentences. What the call was about and where it landed. Lead with the outcome.",
    ),
  overallScore: z
    .number()
    .min(0)
    .max(5)
    .describe("Holistic 0-5, weighted toward compliance and next steps."),
  sentiment: SentimentEnum.describe("The customer's overall sentiment."),
  scores: z.array(ScoreItemSchema),
  issues: z.array(IssueFlagSchema),
  trainingOpportunities: z.array(TrainingOpportunitySchema),
  themes: z.array(ThemeMatchSchema),
  crmSuggestions: z.array(CrmSuggestionSchema),
  discoveredContacts: z.array(DiscoveredContactSchema),
  commitments: z.array(CommitmentSchema),
});

export type AnalysisResult = z.infer<typeof AnalysisSchema>;
export type ScoreItemResult = z.infer<typeof ScoreItemSchema>;
export type IssueFlagResult = z.infer<typeof IssueFlagSchema>;
export type ThemeMatchResult = z.infer<typeof ThemeMatchSchema>;
export type CrmSuggestionResult = z.infer<typeof CrmSuggestionSchema>;
export type CommitmentResult = z.infer<typeof CommitmentSchema>;

/**
 * Drop anything referencing a slug we do not recognize.
 *
 * Structured output guarantees the shape, not that the model invented a
 * plausible-looking dimension or theme slug. Writing an unknown slug would
 * violate a foreign key at best and silently create a junk taxonomy entry at
 * worst, so unknowns are discarded here and reported for prompt tuning.
 */
export function reconcile(
  result: AnalysisResult,
  known: {
    dimensions: Set<string>;
    themes: Set<string>;
    attributeKeys: Set<string>;
  },
): { result: AnalysisResult; dropped: string[] } {
  const dropped: string[] = [];

  const scores = result.scores.filter((s) => {
    if (known.dimensions.has(s.dimension)) return true;
    dropped.push(`score.dimension=${s.dimension}`);
    return false;
  });

  const themes = result.themes.filter((t) => {
    if (known.themes.has(t.theme)) return true;
    dropped.push(`theme=${t.theme}`);
    return false;
  });

  const crmSuggestions = result.crmSuggestions.filter((s) => {
    if (known.attributeKeys.has(s.attributeKey)) return true;
    dropped.push(`crm.attributeKey=${s.attributeKey}`);
    return false;
  });

  const trainingOpportunities = result.trainingOpportunities.filter((t) => {
    if (known.dimensions.has(t.skill)) return true;
    dropped.push(`training.skill=${t.skill}`);
    return false;
  });

  return {
    result: { ...result, scores, themes, crmSuggestions, trainingOpportunities },
    dropped,
  };
}
