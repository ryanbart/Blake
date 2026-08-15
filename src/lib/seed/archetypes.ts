import { SpeakerRole } from "@/generated/prisma/client";
import type { Rng } from "./random";
import { COMPETITORS, EQUIPMENT, type SeedAgent, type SeedContact } from "./people";

/**
 * Call archetypes.
 *
 * Each one plants specific, checkable content — a compliance breach, a pricing
 * objection, an escalation — so every screen in the UI has real data behind it
 * and the end-to-end verification in the plan can assert on known transcripts
 * rather than hoping random text happened to trip a rule.
 *
 * Lines are written as things people actually say on these calls, because the
 * analysis prompt reads them: transcripts full of lorem ipsum would produce
 * scores and themes that tell us nothing about whether the prompt works.
 */

export interface SeedLine {
  role: SpeakerRole;
  text: string;
}

export interface ArchetypeContext {
  rng: Rng;
  agent: SeedAgent;
  contact: SeedContact;
}

export interface ArchetypeResult {
  lines: SeedLine[];
  /** Rough seconds; the generator jitters this. */
  baseDurationSec: number;
  disposition: string;
  dispositionNotes: string;
  /** Themes we expect the analyzer to find. Used to sanity-check the prompt. */
  expectedThemes: string[];
  /** Rule names this transcript should trip, asserted by the seed self-check. */
  expectedRules: string[];
  /** Nudges the heuristic analyzer so seeded scores are not uniform. */
  qualityBias: number;
}

export interface Archetype {
  slug: string;
  label: string;
  build(ctx: ArchetypeContext): ArchetypeResult;
}

const a = (text: string): SeedLine => ({ role: SpeakerRole.agent, text });
const c = (text: string): SeedLine => ({ role: SpeakerRole.customer, text });

/** A well-run discovery call. The shape a coach would hold up as the example. */
const strongDiscovery: Archetype = {
  slug: "strong_discovery",
  label: "Strong discovery call",
  build({ rng, agent, contact }) {
    const kit = rng.pick(EQUIPMENT);
    const aisles = rng.int(2, 6);
    return {
      lines: [
        a(`Hi ${contact.name.split(" ")[0]}, ${agent.name.split(" ")[0]} from United Material Handling. Is now still a good time for the fifteen minutes we booked?`),
        c(`It is, go ahead.`),
        a(`Before I talk about equipment at all — what pushed you to start looking? Something must have changed.`),
        c(`We took on a new customer and added ${aisles} aisles. What we have cannot reach the top racks safely.`),
        a(`Understood. What is the rack height, and how many hours a day would this be running?`),
        c(`Thirty foot, and we are running two shifts now. So sixteen hours.`),
        a(`That is useful. At sixteen hours a day the duty cycle matters more than the sticker price — what happened last time a unit went down?`),
        c(`We lost most of a shift. That is the part that actually worries me.`),
        a(`Then let me focus there rather than on specification sheets. Who else is involved in deciding this?`),
        c(`Me, and our operations director signs anything over fifty thousand.`),
        a(`Makes sense. I will put together a ${kit.name} proposal with the service response terms spelled out, and send it Thursday morning so you have it before your Friday meeting. Can we hold thirty minutes next Wednesday to walk through it together?`),
        c(`Wednesday works. Send it to me and I will forward it on.`),
      ],
      baseDurationSec: 620,
      disposition: "Connected",
      dispositionNotes: `Discovery on ${aisles} new aisles; uptime is the real driver. Proposal Thursday, review Wednesday.`,
      expectedThemes: ["product_fit", "service_support"],
      expectedRules: [],
      qualityBias: 0.85,
    };
  },
};

/** The compliance case: an unauthorized guarantee plus an unapproved discount. */
const complianceBreach: Archetype = {
  slug: "compliance_breach",
  label: "Compliance breach",
  build({ rng, agent, contact }) {
    const kit = rng.pick(EQUIPMENT);
    const competitor = rng.pick(COMPETITORS);
    const discount = rng.int(8, 18);
    return {
      lines: [
        a(`Hi ${contact.name.split(" ")[0]}, it is ${agent.name.split(" ")[0]} at United Material Handling. Do you have a couple of minutes?`),
        c(`Sure, but I am short on time.`),
        a(`No problem. I wanted to get you a number on the ${kit.name}s you asked about.`),
        c(`Go ahead. What are we looking at?`),
        a(`Around ${kit.unitPrice} per unit, and I can guarantee we will have them on site by the fifteenth.`),
        c(`That is higher than I hoped. ${competitor} quoted us noticeably under that.`),
        a(`I hear you. I can do ${discount} percent off if you take all three, and I promise you will not get better service anywhere.`),
        c(`Let me think about it.`),
        a(`Of course. I'll follow up soon with something in writing.`),
      ],
      baseDurationSec: 265,
      disposition: "Connected",
      dispositionNotes: `Quoted ${kit.name}s verbally, offered ${discount}% to close.`,
      expectedThemes: ["pricing", "competitor", "delivery"],
      expectedRules: [
        "Unauthorized guarantee",
        "Unapproved discount",
        "Competitor mentioned",
        "Vague follow-up",
        "Pricing discussed without quote",
      ],
      qualityBias: 0.2,
    };
  },
};

/** An unhappy customer. Should reach a manager the same day. */
const escalation: Archetype = {
  slug: "escalation",
  label: "Customer escalation",
  build({ rng, agent, contact }) {
    const kit = rng.pick(EQUIPMENT);
    const days = rng.int(2, 9);
    return {
      lines: [
        a(`United Material Handling, this is ${agent.name.split(" ")[0]}.`),
        c(`${agent.name.split(" ")[0]}, the ${kit.name}s were supposed to be here ${days} days ago. This is unacceptable and I want to speak to a manager.`),
        a(`I understand, and I am sorry. Let me pull the order up before I hand you over so you are not repeating yourself.`),
        c(`Fine. But if this happens again we will take my business elsewhere.`),
        a(`That is fair. It looks like the carrier has them sitting in Louisville. I can have it delivered by Monday morning, and I am getting our service manager on the line now.`),
        c(`Monday is not what I was promised, but alright.`),
        a(`Understood. I will also send you the tracking myself so you are not chasing us for it.`),
      ],
      baseDurationSec: 340,
      disposition: "Escalated",
      dispositionNotes: `Late delivery, ${days} days past. Escalated to service manager; committed Monday AM.`,
      expectedThemes: ["escalation", "delivery", "service_support"],
      expectedRules: ["Customer dissatisfaction", "Delivery date committed"],
      qualityBias: 0.6,
    };
  },
};

/** A competitive bake-off, handled well. Themes without a compliance problem. */
const competitiveBakeoff: Archetype = {
  slug: "competitive_bakeoff",
  label: "Competitive bake-off",
  build({ rng, agent, contact }) {
    const competitor = rng.pick(COMPETITORS);
    const kit = rng.pick(EQUIPMENT);
    const units = rng.int(3, 8);
    return {
      lines: [
        a(`Hi ${contact.name.split(" ")[0]}, ${agent.name.split(" ")[0]} from United Material Handling.`),
        c(`Hi. I will say up front we are also talking to ${competitor}.`),
        a(`That is useful to know rather than find out later. What matters most in the comparison, so I answer the right question?`),
        c(`Uptime. We lost about forty hours last year waiting on parts.`),
        a(`Then let me be specific instead of general. We stock the wear parts for this class locally and our contract carries a four hour on site response. I would rather show you last quarter's response log than quote you a number.`),
        c(`That would actually help. What is the range on ${units} units?`),
        a(`I want to confirm the parts pricing with our service manager before I put a figure in writing, so let me come back to you with it properly.`),
        c(`I need something written by Friday. Our board meets the following Tuesday.`),
        a(`Then I will have the quote and the response log to you Thursday end of day, so you have a day to read it. I will copy Ellen since you mentioned she signs off.`),
      ],
      baseDurationSec: 545,
      disposition: "Connected",
      dispositionNotes: `Head to head with ${competitor}; uptime is the deciding factor. Quote + response log Thursday.`,
      expectedThemes: ["competitor", "service_support", "pricing"],
      expectedRules: ["Competitor mentioned"],
      qualityBias: 0.9,
    };
  },
};

/** Routine parts and availability. The bulk of a real call log. */
const partsInquiry: Archetype = {
  slug: "parts_inquiry",
  label: "Parts availability",
  build({ rng, agent, contact }) {
    const kit = rng.pick(EQUIPMENT);
    const inStock = rng.bool(0.6);
    return {
      lines: [
        a(`United Material Handling parts, ${agent.name.split(" ")[0]} speaking.`),
        c(`I need a mast chain and the two lift cylinders for our ${kit.name}.`),
        a(`Do you have the serial number handy? The mast chain changed part numbers mid-year.`),
        c(`Give me a second. It is on the plate here — yes, I have it.`),
        inStock
          ? a(`We have both on the shelf. If you order before two I can have it delivered by tomorrow.`)
          : a(`The chain is here, the cylinders are on backorder about ten days. I can ship the chain now or hold and send it together.`),
        inStock ? c(`Send it today then.`) : c(`Send the chain now, we will limp along.`),
        a(`Done. I will email the confirmation in the next few minutes.`),
      ],
      baseDurationSec: 195,
      disposition: "Connected",
      dispositionNotes: inStock
        ? "Parts in stock, shipping today."
        : "Cylinders backordered ~10 days; chain shipping now.",
      expectedThemes: inStock ? ["service_support"] : ["inventory", "delivery"],
      expectedRules: inStock ? ["Delivery date committed"] : [],
      qualityBias: 0.7,
    };
  },
};

/** A weak call: pitching before understanding, no real next step. */
const missedDiscovery: Archetype = {
  slug: "missed_discovery",
  label: "Pitched without discovery",
  build({ rng, agent, contact }) {
    const kit = rng.pick(EQUIPMENT);
    return {
      lines: [
        a(`Hi, is this ${contact.name}? Great — I am calling from United Material Handling about your equipment needs.`),
        c(`We are not really in the market right now.`),
        a(`Sure, sure. Well, we have a great deal on ${kit.name}s at the moment, they are the best on the market, and I think you would see real value.`),
        c(`What makes them better than what we run today?`),
        a(`They are just a better machine overall, honestly. Everyone who switches is happy.`),
        c(`That is not really an answer.`),
        a(`Fair enough. Let me send you a brochure and I'll circle back with you soon.`),
        c(`Alright.`),
      ],
      baseDurationSec: 155,
      disposition: "Connected",
      dispositionNotes: "Not in market. Sent brochure.",
      expectedThemes: ["product_fit"],
      expectedRules: ["Vague follow-up"],
      qualityBias: 0.15,
    };
  },
};

/** Billing and terms. Gives the billing theme non-trivial volume. */
const billingQuestion: Archetype = {
  slug: "billing_question",
  label: "Billing and terms",
  build({ rng, agent, contact }) {
    const invoice = rng.int(40000, 99999);
    return {
      lines: [
        a(`United Material Handling, ${agent.name.split(" ")[0]}.`),
        c(`I am looking at invoice ${invoice} and the freight line does not match the quote.`),
        a(`Let me pull it up. You are right — the quote had freight prepaid and the invoice billed it separately. That is our error.`),
        c(`Can you fix it?`),
        a(`Yes. I will have a corrected invoice issued today and email it to you. Do not pay this one.`),
        c(`Appreciated. While I have you, can we move to net forty five?`),
        a(`That is a credit decision rather than mine, but I will get the application to you today and flag that you have been on time for two years.`),
      ],
      baseDurationSec: 280,
      disposition: "Connected",
      dispositionNotes: `Invoice ${invoice} freight billed in error; correcting. Requested net 45 terms.`,
      expectedThemes: ["billing"],
      expectedRules: [],
      qualityBias: 0.8,
    };
  },
};

/** Voicemail / no answer. Short, no transcript — exercises the degraded path. */
const noAnswer: Archetype = {
  slug: "no_answer",
  label: "No answer",
  build() {
    return {
      lines: [],
      baseDurationSec: 24,
      disposition: "No Answer",
      dispositionNotes: "",
      expectedThemes: [],
      expectedRules: [],
      qualityBias: 0,
    };
  },
};

export const ARCHETYPES = {
  strongDiscovery,
  complianceBreach,
  escalation,
  competitiveBakeoff,
  partsInquiry,
  missedDiscovery,
  billingQuestion,
  noAnswer,
} as const;

/**
 * Archetype mix for a rep, weighted by skill.
 *
 * A rep three months in draws compliance breaches and missed discovery far more
 * often than a twenty-year veteran, which is what makes the per-agent trends and
 * the training-opportunity list mean something rather than being noise.
 */
export function archetypeMixFor(agent: SeedAgent): ReadonlyArray<readonly [Archetype, number]> {
  const green = 1 - agent.skill;
  return [
    [strongDiscovery, 10 + agent.skill * 30],
    [competitiveBakeoff, 6 + agent.skill * 14],
    [partsInquiry, 22],
    [billingQuestion, 8],
    [escalation, 6 + green * 8],
    [missedDiscovery, 4 + green * 26],
    [complianceBreach, 2 + green * 18],
    [noAnswer, 14],
  ] as const;
}
