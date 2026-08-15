import { describe, expect, it } from "vitest";
import { AnalysisSchema, reconcile, type AnalysisResult } from "@/lib/analysis/schema";
import { analyzeHeuristically } from "@/lib/analysis/heuristic";
import { buildSystemPrompt, buildUserPrompt } from "@/lib/analysis/prompt";
import { RUBRIC, THEMES, FIELD_MAPPINGS } from "@/lib/reference-data";
import type {
  CrmFieldMapping,
  RubricDimension,
  Theme,
} from "@/generated/prisma/client";

const dimensions = RUBRIC.map((r) => ({ ...r, enabled: true })) as RubricDimension[];
const themes = THEMES.map((t) => ({ ...t, enabled: true })) as Theme[];
const mappings = FIELD_MAPPINGS.map((m, i) => ({
  ...m,
  id: `m${i}`,
  enabled: true,
  writePolicy: "suggest_only",
  createdAt: new Date(),
  updatedAt: new Date(),
})) as CrmFieldMapping[];

const config = { dimensions, themes, mappings };

const context = {
  title: "Apex Cold Storage — Peter De Haan",
  agentName: "Dana Whitfield",
  direction: "outbound",
  durationSec: 412,
  startedAt: new Date("2026-08-14T14:30:00Z"),
  disposition: "Connected",
  dispositionNotes: "Quoted verbally",
  providerSummary: null,
};

const line = (role: "agent" | "customer", text: string, startMs = 0) => ({
  speakerRole: role,
  speakerName: role === "agent" ? "Dana Whitfield" : "Peter De Haan",
  startMs,
  text,
});

const BREACH_TRANSCRIPT = [
  line("agent", "Hi Peter, this is Dana at United Material Handling. Do you have a couple of minutes?"),
  line("customer", "Sure, but I am short on time.", 8000),
  line("agent", "Around 42000 per unit, and I can guarantee we will have them on site by the fifteenth.", 20000),
  line("customer", "That is higher than I hoped. Crown Equipment quoted us under that.", 40000),
  line("agent", "I can do 12 percent off if you take all three.", 55000),
  line("agent", "I'll follow up soon with something in writing.", 70000),
];

const GOOD_TRANSCRIPT = [
  line("agent", "Hi Doug, Priya from United Material Handling. Is now still a good time?"),
  line("customer", "It is, go ahead.", 6000),
  line("agent", "What pushed you to start looking? Something must have changed.", 12000),
  line("customer", "We took on a new customer and added four aisles.", 24000),
  line("agent", "What is the rack height, and how many hours a day would this run?", 36000),
  line("customer", "Thirty foot, two shifts.", 48000),
  line("agent", "Who else is involved in deciding this?", 60000),
  line("customer", "Our operations director signs anything over fifty thousand.", 72000),
  line("agent", "I will send the proposal Thursday morning so you have it before your Friday meeting.", 84000),
];

describe("analysis schema", () => {
  it("accepts heuristic output unchanged", () => {
    const result = analyzeHeuristically(context, BREACH_TRANSCRIPT, config);
    // The heuristic path must satisfy the same contract the model does, or the
    // fallback would produce rows the persist layer cannot write.
    expect(() => AnalysisSchema.parse(result)).not.toThrow();
  });

  it("rejects a score outside 0-5", () => {
    const bad = { dimension: "opening", score: 7, evidenceQuote: "", rationale: "" };
    const result = analyzeHeuristically(context, GOOD_TRANSCRIPT, config);
    expect(() =>
      AnalysisSchema.parse({ ...result, scores: [...result.scores, bad] }),
    ).toThrow();
  });
});

describe("reconcile drops unknown slugs", () => {
  const known = {
    dimensions: new Set(dimensions.map((d) => d.slug)),
    themes: new Set(themes.map((t) => t.slug)),
    attributeKeys: new Set(mappings.map((m) => m.attributeKey)),
  };

  it("discards a hallucinated dimension, theme, and attribute key", () => {
    const base = analyzeHeuristically(context, BREACH_TRANSCRIPT, config);
    const polluted: AnalysisResult = {
      ...base,
      scores: [
        ...base.scores,
        { dimension: "rapport_building", score: 4, evidenceQuote: "x", rationale: "y" },
      ],
      themes: [
        ...base.themes,
        { theme: "sustainability", confidence: 0.8, sentiment: "positive", quote: "x" },
      ],
      crmSuggestions: [
        {
          attributeKey: "opportunity_vibe",
          value: "good",
          confidence: 0.9,
          quote: "x",
          rationale: "y",
        },
      ],
      trainingOpportunities: [
        { skill: "charisma", priority: "low", suggestion: "s", exampleQuote: "q" },
      ],
    };

    const { result, dropped } = reconcile(polluted, known);

    // Structured output guarantees shape, not that a slug exists. Writing an
    // unknown one would violate a foreign key or invent a taxonomy entry.
    expect(result.scores.some((s) => s.dimension === "rapport_building")).toBe(false);
    expect(result.themes.some((t) => t.theme === "sustainability")).toBe(false);
    expect(result.crmSuggestions).toHaveLength(0);
    expect(result.trainingOpportunities).toHaveLength(0);
    expect(dropped).toHaveLength(4);
  });

  it("keeps everything valid", () => {
    const base = analyzeHeuristically(context, GOOD_TRANSCRIPT, config);
    const { result, dropped } = reconcile(base, known);
    expect(dropped).toEqual([]);
    expect(result.scores.length).toBe(base.scores.length);
  });
});

describe("heuristic analyzer", () => {
  it("scores compliance near zero when the rep guarantees and discounts", () => {
    const result = analyzeHeuristically(context, BREACH_TRANSCRIPT, config);
    const compliance = result.scores.find((s) => s.dimension === "compliance");
    expect(compliance?.score).toBeLessThan(1.5);
  });

  it("scores compliance high on a clean call", () => {
    const result = analyzeHeuristically(context, GOOD_TRANSCRIPT, config);
    const compliance = result.scores.find((s) => s.dimension === "compliance");
    expect(compliance?.score).toBeGreaterThan(4);
  });

  it("rates discovery by how many open questions the rep actually asked", () => {
    const good = analyzeHeuristically(context, GOOD_TRANSCRIPT, config);
    const bad = analyzeHeuristically(context, BREACH_TRANSCRIPT, config);
    const score = (r: AnalysisResult) =>
      r.scores.find((s) => s.dimension === "discovery")?.score ?? 0;
    expect(score(good)).toBeGreaterThan(score(bad) + 1.5);
  });

  it("raises a critical issue for an unauthorized guarantee, with the quote", () => {
    const result = analyzeHeuristically(context, BREACH_TRANSCRIPT, config);
    const critical = result.issues.find((i) => i.severity === "critical");
    expect(critical?.title).toMatch(/guarantee/i);
    // Every finding must be traceable to a real line.
    expect(BREACH_TRANSCRIPT.some((l) => l.text === critical?.quote)).toBe(true);
  });

  it("finds no issues on a well-run call", () => {
    const result = analyzeHeuristically(context, GOOD_TRANSCRIPT, config);
    expect(result.issues).toEqual([]);
  });

  it("produces identical output for identical input", () => {
    // A fallback that scored differently on each run would be worse than none.
    const a = analyzeHeuristically(context, BREACH_TRANSCRIPT, config);
    const b = analyzeHeuristically(context, BREACH_TRANSCRIPT, config);
    expect(a).toEqual(b);
  });

  it("labels its own output as pattern analysis, not model output", () => {
    const result = analyzeHeuristically(context, GOOD_TRANSCRIPT, config);
    expect(result.summary).toMatch(/no model was used/i);
  });

  it("only extracts a CRM next step when a dated commitment exists", () => {
    const good = analyzeHeuristically(context, GOOD_TRANSCRIPT, config);
    const bad = analyzeHeuristically(context, BREACH_TRANSCRIPT, config);
    expect(good.crmSuggestions.some((s) => s.attributeKey === "next_step")).toBe(true);
    // "I'll follow up soon" is not a next step.
    expect(bad.crmSuggestions.some((s) => s.attributeKey === "next_step")).toBe(false);
  });

  it("assigns themes only from the closed taxonomy", () => {
    const slugs = new Set(themes.map((t) => t.slug));
    const result = analyzeHeuristically(context, BREACH_TRANSCRIPT, config);
    expect(result.themes.length).toBeGreaterThan(0);
    for (const theme of result.themes) expect(slugs.has(theme.theme)).toBe(true);
  });

  it("respects a disabled rubric dimension", () => {
    const trimmed = dimensions.map((d) =>
      d.slug === "tone" ? { ...d, enabled: false } : d,
    );
    const result = analyzeHeuristically(context, GOOD_TRANSCRIPT, {
      ...config,
      dimensions: trimmed,
    });
    expect(result.scores.some((s) => s.dimension === "tone")).toBe(false);
  });
});

describe("prompt construction", () => {
  it("keeps the cached system prefix free of per-call content", () => {
    const system = buildSystemPrompt(dimensions, themes, mappings);
    // Anything volatile here invalidates the cache on every request and turns a
    // backfill into full price for every call.
    expect(system).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // no ISO timestamps
    expect(system).not.toContain(context.title!);
    expect(system).not.toContain("Dana Whitfield");
    expect(system).not.toContain("42000");
  });

  it("lists every enabled rubric dimension and theme slug", () => {
    const system = buildSystemPrompt(dimensions, themes, mappings);
    for (const d of dimensions) expect(system).toContain(`\`${d.slug}\``);
    for (const t of themes) expect(system).toContain(`\`${t.slug}\``);
  });

  it("marks sensitive CRM fields so the model holds them to a higher bar", () => {
    const system = buildSystemPrompt(dimensions, themes, mappings);
    expect(system).toContain("`amount`");
    expect(system).toMatch(/amount.*\[sensitive\]/);
    expect(system).toMatch(/next_step.*Opportunity\.NextStep/);
  });

  it("omits disabled reference data from the prompt", () => {
    const trimmed = themes.map((t) =>
      t.slug === "billing" ? { ...t, enabled: false } : t,
    );
    const system = buildSystemPrompt(dimensions, trimmed, mappings);
    expect(system).not.toContain("`billing`");
  });

  it("renders speaker roles and timestamps in the user prompt", () => {
    const user = buildUserPrompt(context, GOOD_TRANSCRIPT);
    expect(user).toContain("[00:00] REP (Dana Whitfield):");
    expect(user).toContain("CUSTOMER (Peter De Haan):");
    expect(user).toContain("[01:24]"); // 84000ms
    expect(user).toContain("Duration: 6m 52s");
  });

  it("passes a provider summary as context rather than as a conclusion", () => {
    const user = buildUserPrompt(
      { ...context, providerSummary: "Fellow says the deal is closing." },
      GOOD_TRANSCRIPT,
    );
    expect(user).toMatch(/for context only/i);
  });
});
