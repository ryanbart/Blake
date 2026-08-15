import { describe, expect, it } from "vitest";
import {
  compileRule,
  InvalidRulePatternError,
  previewRule,
  runRules,
  type RuleInputSegment,
} from "@/lib/analysis/rules";
import { RULES } from "@/lib/reference-data";
import {
  RuleTarget,
  Severity,
  SpeakerRole,
  type Rule,
} from "@/generated/prisma/client";

/** Build a Rule row from a seed definition without touching the database. */
function asRule(seedName: string): Rule {
  const seed = RULES.find((r) => r.name === seedName);
  if (!seed) throw new Error(`No seeded rule named ${seedName}`);
  return {
    id: `rule_${seedName.replace(/\s+/g, "_").toLowerCase()}`,
    name: seed.name,
    description: seed.description,
    pattern: seed.pattern,
    isRegex: seed.isRegex,
    caseSensitive: false,
    appliesTo: seed.appliesTo,
    category: seed.category,
    severity: seed.severity,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const agent = (text: string): RuleInputSegment => ({
  id: `seg_${Math.random().toString(36).slice(2)}`,
  speakerRole: SpeakerRole.agent,
  text,
});
const customer = (text: string): RuleInputSegment => ({
  id: `seg_${Math.random().toString(36).slice(2)}`,
  speakerRole: SpeakerRole.customer,
  text,
});

const ALL_RULES = RULES.map((r) => asRule(r.name));

describe("each seeded rule fires on the transcript it targets", () => {
  const cases: Array<[string, RuleInputSegment]> = [
    ["Unauthorized guarantee", agent("I can guarantee we'll have them on site by the fifteenth.")],
    ["Unapproved discount", agent("I can do 8 percent off if you take all three.")],
    ["Competitor mentioned", customer("Crown Equipment quoted us a little under forty.")],
    ["Vague follow-up", agent("I'll follow up soon with something in writing.")],
    ["Delivery date committed", agent("I can have it delivered by Monday morning.")],
    ["Customer dissatisfaction", customer("This is unacceptable and I want to speak to a manager.")],
    ["Pricing discussed without quote", agent("You're looking at around 42000 per unit.")],
  ];

  it.each(cases)("%s", (ruleName, segment) => {
    const matches = runRules([segment], [asRule(ruleName)]);
    expect(matches).toHaveLength(1);
    expect(matches[0].title).toBe(ruleName);
    expect(matches[0].quote).toBe(segment.text);
    expect(matches[0].matchedText.length).toBeGreaterThan(0);
  });
});

describe("no rule fires on a clean transcript", () => {
  it("stays silent on a well-run call", () => {
    const clean: RuleInputSegment[] = [
      agent("Hi Doug, Priya from United Material Handling. Is now still a good time?"),
      customer("It is. We have three aisles we cannot service properly."),
      agent("What is the rack height, and how many hours a day would these run?"),
      customer("About thirty foot, two shifts."),
      agent(
        "I will send the written quote and the response log by Thursday end of day, so you have a day before Friday.",
      ),
    ];
    expect(runRules(clean, ALL_RULES)).toEqual([]);
  });
});

describe("speaker targeting", () => {
  it("does not flag the rep for words the customer said", () => {
    // The customer naming a competitor is signal; it is not a rep mistake.
    const guaranteeRule = asRule("Unauthorized guarantee");
    const spokenByCustomer = customer("Can you guarantee that date?");
    expect(runRules([spokenByCustomer], [guaranteeRule])).toEqual([]);
  });

  it("flags an agent-targeted rule only on agent speech", () => {
    const rule = asRule("Vague follow-up");
    expect(runRules([agent("I'll circle back with you soon.")], [rule])).toHaveLength(1);
    expect(runRules([customer("I'll circle back with you soon.")], [rule])).toEqual([]);
  });

  it("flags an any-targeted rule regardless of speaker", () => {
    const rule = asRule("Competitor mentioned");
    expect(runRules([agent("We beat Hyster on uptime.")], [rule])).toHaveLength(1);
    expect(runRules([customer("We also use Hyster.")], [rule])).toHaveLength(1);
  });
});

describe("match semantics", () => {
  it("records one match per rule per segment, not one per occurrence", () => {
    // Saying it three times in a sentence is one mistake, not three.
    const rule = asRule("Unauthorized guarantee");
    const segment = agent("I guarantee it. We guarantee it. You have my word.");
    expect(runRules([segment], [rule])).toHaveLength(1);
  });

  it("matches the same rule separately across different segments", () => {
    const rule = asRule("Unauthorized guarantee");
    const matches = runRules(
      [agent("I guarantee delivery."), agent("And we guarantee the parts.")],
      [rule],
    );
    expect(matches).toHaveLength(2);
  });

  it("does not carry regex state between segments", () => {
    // A `g` flag regex advances lastIndex; failing to reset it silently drops
    // every other match.
    const rule = asRule("Competitor mentioned");
    const matches = runRules(
      [customer("We use Crown Equipment."), customer("We also looked at Raymond.")],
      [rule],
    );
    expect(matches).toHaveLength(2);
  });

  it("skips disabled rules", () => {
    const disabled = { ...asRule("Unauthorized guarantee"), enabled: false };
    expect(runRules([agent("I guarantee it.")], [disabled])).toEqual([]);
  });

  it("ignores whitespace-only segments", () => {
    expect(runRules([agent("   ")], ALL_RULES)).toEqual([]);
  });
});

describe("literal vs regex patterns", () => {
  it("treats a literal pattern as literal, not as a regex", () => {
    const literal: Rule = {
      ...asRule("Unauthorized guarantee"),
      name: "Literal dot",
      pattern: "price.list",
      isRegex: false,
      severity: Severity.low,
    };
    // As a regex, "." would match the space in "price list".
    expect(runRules([agent("Send the price list please.")], [literal])).toEqual([]);
    expect(runRules([agent("Open price.list now.")], [literal])).toHaveLength(1);
  });

  it("honours case sensitivity", () => {
    const sensitive: Rule = {
      ...asRule("Unauthorized guarantee"),
      name: "Case test",
      pattern: "Crown",
      isRegex: false,
      caseSensitive: true,
    };
    expect(runRules([agent("crown equipment")], [sensitive])).toEqual([]);
    expect(runRules([agent("Crown equipment")], [sensitive])).toHaveLength(1);
  });

  it("raises a named error for an invalid pattern rather than failing silently", () => {
    const broken: Rule = { ...asRule("Unauthorized guarantee"), pattern: "([unclosed", isRegex: true };
    expect(() => compileRule(broken)).toThrow(InvalidRulePatternError);
    expect(() => compileRule(broken)).toThrow(/invalid pattern/i);
  });
});

describe("rule preview", () => {
  it("returns the segments a candidate pattern would flag", () => {
    const segments = [
      agent("I can knock off ten percent."),
      agent("The list price is firm."),
      customer("Any discount available?"),
    ];
    const hits = previewRule(
      "knock off",
      { isRegex: false, caseSensitive: false, appliesTo: RuleTarget.agent },
      segments,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toContain("knock off");
  });
});
