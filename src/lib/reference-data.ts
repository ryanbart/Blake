import { Severity, RuleTarget } from "@/generated/prisma/client";

/**
 * Reference data seeded on first run and editable in the UI afterwards.
 *
 * It lives in code rather than a migration so the analysis prompt and the
 * database read from one source: the rubric and theme taxonomy below are
 * rendered directly into the cached system prompt, so a drift between "what the
 * model was told" and "what we store" is impossible by construction.
 */

export interface RubricSeed {
  slug: string;
  label: string;
  description: string;
  weight: number;
  sortOrder: number;
}

/**
 * The coaching rubric. Descriptions are written for the model as much as the
 * manager — they are the scoring instructions, so they say what good looks like
 * rather than naming the skill and hoping.
 */
export const RUBRIC: RubricSeed[] = [
  {
    slug: "opening",
    label: "Opening",
    description:
      "Identified themselves and the company, established why they were calling, and confirmed it was a workable time. A strong opening earns the next two minutes; a weak one is a rushed pitch before the customer has agreed to listen.",
    weight: 1,
    sortOrder: 10,
  },
  {
    slug: "discovery",
    label: "Discovery",
    description:
      "Asked open questions and listened to the answers before proposing anything. Look for questions that changed what the rep said next. A rep who asks three questions and then delivers the same pitch regardless has not done discovery.",
    weight: 1.5,
    sortOrder: 20,
  },
  {
    slug: "product_knowledge",
    label: "Product knowledge",
    description:
      "Answered questions about the product accurately and without hedging. Penalize guesses stated as fact; do not penalize an honest 'let me confirm and come back to you', which is the correct move when unsure.",
    weight: 1.25,
    sortOrder: 30,
  },
  {
    slug: "objection_handling",
    label: "Objection handling",
    description:
      "Acknowledged the objection, understood it before answering, and responded to the actual concern. Discounting immediately is not objection handling; neither is repeating the original claim more loudly.",
    weight: 1.5,
    sortOrder: 40,
  },
  {
    slug: "next_steps",
    label: "Next steps",
    description:
      "Ended with a specific, mutually agreed next action with an owner and a date. 'I'll follow up soon' is not a next step. This dimension predicts pipeline movement more than any other, so weight it accordingly.",
    weight: 1.5,
    sortOrder: 50,
  },
  {
    slug: "compliance",
    label: "Compliance",
    description:
      "Made no unauthorized guarantees about pricing, delivery, or outcomes, and made no claim the company cannot stand behind. Score this strictly — a single unauthorized commitment is a low score regardless of how well the rest of the call went.",
    weight: 2,
    sortOrder: 60,
  },
  {
    slug: "tone",
    label: "Tone",
    description:
      "Stayed composed and respectful, matched the customer's register, and did not talk over them. Warmth is not required; being hard to talk to is penalized.",
    weight: 0.75,
    sortOrder: 70,
  },
];

export interface ThemeSeed {
  slug: string;
  label: string;
  description: string;
  category: string;
  sortOrder: number;
}

/**
 * What customers talk about. Closed taxonomy on purpose: an open-ended "extract
 * the topics" produces a long tail nobody can chart, and the whole point is
 * trend lines a manager can act on.
 */
export const THEMES: ThemeSeed[] = [
  {
    slug: "pricing",
    label: "Pricing",
    description:
      "Cost, quotes, discounts, budget constraints, or comparisons to another vendor's price.",
    category: "commercial",
    sortOrder: 10,
  },
  {
    slug: "inventory",
    label: "Inventory & availability",
    description:
      "Stock levels, backorders, whether an item can be sourced, substitutions for unavailable products.",
    category: "operations",
    sortOrder: 20,
  },
  {
    slug: "delivery",
    label: "Delivery & lead time",
    description:
      "Shipping dates, freight, install scheduling, delays, and how long something will take to arrive.",
    category: "operations",
    sortOrder: 30,
  },
  {
    slug: "competitor",
    label: "Competitor",
    description:
      "A named competitor, an alternative being evaluated, or an incumbent supplier the customer already uses.",
    category: "commercial",
    sortOrder: 40,
  },
  {
    slug: "product_fit",
    label: "Product fit",
    description:
      "Whether the product suits the customer's application — capacity, specification, compatibility, use case.",
    category: "product",
    sortOrder: 50,
  },
  {
    slug: "service_support",
    label: "Service & support",
    description:
      "Maintenance, warranty, repairs, parts, and the responsiveness of past support interactions.",
    category: "support",
    sortOrder: 60,
  },
  {
    slug: "billing",
    label: "Billing & terms",
    description:
      "Invoices, payment terms, credit applications, purchase orders, and billing disputes.",
    category: "commercial",
    sortOrder: 70,
  },
  {
    slug: "escalation",
    label: "Escalation",
    description:
      "The customer is dissatisfied, asking for a manager, threatening to leave, or referencing an unresolved complaint.",
    category: "risk",
    sortOrder: 80,
  },
];

export interface RuleSeed {
  name: string;
  description: string;
  pattern: string;
  isRegex: boolean;
  appliesTo: RuleTarget;
  category: string;
  severity: Severity;
}

/**
 * Deterministic checks that run with or without an API key.
 *
 * These exist so compliance flagging never depends on model availability or
 * mood. Anything a regex can catch reliably belongs here rather than in the
 * prompt — the model is for judgment, not for pattern matching.
 */
export const RULES: RuleSeed[] = [
  {
    name: "Unauthorized guarantee",
    description:
      "Rep promised or guaranteed an outcome. Only a manager can make a guarantee, so any instance needs review.",
    pattern:
      "\\b(i (can )?guarantee|we guarantee|guaranteed|i promise|we promise|you have my word)\\b",
    isRegex: true,
    appliesTo: RuleTarget.agent,
    category: "compliance",
    severity: Severity.critical,
  },
  {
    name: "Unapproved discount",
    description:
      "Rep offered a specific discount. Discounts above the standard band need approval before they are said out loud.",
    pattern:
      "\\b(\\d{1,2}\\s?(%|percent)\\s?(off|discount)|knock off|take .{0,12} off the price|cut you a deal)\\b",
    isRegex: true,
    appliesTo: RuleTarget.agent,
    category: "compliance",
    severity: Severity.high,
  },
  {
    name: "Competitor mentioned",
    description:
      "A competing supplier came up. Useful for win/loss trends even when the call went well.",
    pattern:
      "\\b(toyota material handling|crown equipment|hyster|yale|raymond|komatsu|clark forklift)\\b",
    isRegex: true,
    appliesTo: RuleTarget.any,
    category: "competitive",
    severity: Severity.low,
  },
  {
    name: "Vague follow-up",
    description:
      "The call ended without a dated commitment. Strongly correlated with deals that stall.",
    pattern:
      "\\b(i'?ll (follow up|circle back|reach out|touch base)( with you)?( soon| at some point| down the road| when i can)|give me a shout|let'?s touch base sometime)\\b",
    isRegex: true,
    appliesTo: RuleTarget.agent,
    category: "process",
    severity: Severity.medium,
  },
  {
    name: "Delivery date committed",
    description:
      "A specific delivery or install date was promised. Worth confirming against actual lead times.",
    pattern:
      "\\b(have it (there|to you|delivered) (by|on)|deliver(ed)? (by|on)|on site by|installed by)\\b",
    isRegex: true,
    appliesTo: RuleTarget.agent,
    category: "operations",
    severity: Severity.medium,
  },
  {
    name: "Customer dissatisfaction",
    description:
      "Customer expressed frustration or referenced escalation. Should reach a manager the same day.",
    pattern:
      "\\b(speak to (a|your) (manager|supervisor)|this is (unacceptable|ridiculous)|last time i|take my business elsewhere|cancel (my|the) (order|account))\\b",
    isRegex: true,
    appliesTo: RuleTarget.customer,
    category: "risk",
    severity: Severity.high,
  },
  {
    name: "Pricing discussed without quote",
    description:
      "A price was quoted verbally. Verbal quotes should be followed by written confirmation.",
    pattern: "\\b(around|about|roughly|ballpark)\\s+\\$?\\d{3,}",
    isRegex: true,
    appliesTo: RuleTarget.agent,
    category: "process",
    severity: Severity.low,
  },
];

export interface FieldMappingSeed {
  attributeKey: string;
  sObject: string;
  fieldName: string;
  sensitive: boolean;
  notes: string;
}

/**
 * Extracted attribute -> Salesforce field. Validated against the org's Describe
 * metadata before use, so a mapping cannot point at a field that does not exist.
 *
 * `sensitive` marks the fields a wrong extraction damages most. Those always
 * require a human regardless of autonomy policy — and a rep can approve them in
 * one keystroke anyway, so the safety costs almost nothing.
 */
export const FIELD_MAPPINGS: FieldMappingSeed[] = [
  {
    attributeKey: "next_step",
    sObject: "Opportunity",
    fieldName: "NextStep",
    sensitive: false,
    notes: "The agreed next action, with owner and date where stated.",
  },
  {
    attributeKey: "close_date",
    sObject: "Opportunity",
    fieldName: "CloseDate",
    sensitive: true,
    notes: "Only when the customer named a decision date explicitly.",
  },
  {
    attributeKey: "amount",
    sObject: "Opportunity",
    fieldName: "Amount",
    sensitive: true,
    notes: "Only from a figure both parties discussed as the deal value.",
  },
  {
    attributeKey: "stage",
    sObject: "Opportunity",
    fieldName: "StageName",
    sensitive: true,
    notes: "Validated against the org's picklist before it is ever suggested.",
  },
  {
    attributeKey: "description",
    sObject: "Opportunity",
    fieldName: "Description",
    sensitive: false,
    notes: "Appended call context, never a replacement for existing text.",
  },
  {
    attributeKey: "contact_title",
    sObject: "Contact",
    fieldName: "Title",
    sensitive: false,
    notes: "Only when the contact stated their own role.",
  },
  {
    attributeKey: "contact_phone",
    sObject: "Contact",
    fieldName: "Phone",
    sensitive: false,
    notes: "A direct line given on the call that differs from the stored value.",
  },
  {
    attributeKey: "contact_email",
    sObject: "Contact",
    fieldName: "Email",
    sensitive: false,
    notes: "Spelled out or confirmed on the call.",
  },
];
