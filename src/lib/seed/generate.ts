import { Direction, SpeakerRole } from "@/generated/prisma/client";
import { Rng } from "./random";
import { SEED_AGENTS, SEED_CONTACTS, type SeedAgent, type SeedContact } from "./people";
import { archetypeMixFor, type SeedLine } from "./archetypes";

export interface GeneratedConversation {
  sourceId: string;
  archetypeSlug: string;
  agent: SeedAgent;
  contact: SeedContact;
  startedAt: Date;
  durationSec: number;
  direction: Direction;
  disposition: string;
  dispositionNotes: string;
  recordingUrl: string | null;
  lines: SeedLine[];
  expectedThemes: string[];
  expectedRules: string[];
  qualityBias: number;
}

export interface GenerateOptions {
  /** Days of history to produce. */
  days?: number;
  /** Target conversation count; actual output lands within a few percent. */
  target?: number;
  /** Anchor for the most recent day. Defaults to now. */
  endDate?: Date;
  seed?: number;
}

/**
 * Build a realistic call log.
 *
 * Volume follows a weekday pattern with a slow upward trend across the window,
 * so the overview chart shows something a manager would recognize rather than a
 * flat band of noise. Weekends are sparse but not empty — service calls happen.
 */
export function generateConversations(
  opts: GenerateOptions = {},
): GeneratedConversation[] {
  const days = opts.days ?? 90;
  const target = opts.target ?? 400;
  const endDate = opts.endDate ?? new Date();
  const rng = new Rng(opts.seed ?? 0x51ede5);

  const out: GeneratedConversation[] = [];
  let counter = 0;

  // Weight each day, then distribute the target across them proportionally.
  const dayWeights: number[] = [];
  for (let d = 0; d < days; d++) {
    const date = new Date(endDate);
    date.setDate(date.getDate() - (days - 1 - d));
    const dow = date.getDay();
    const weekend = dow === 0 || dow === 6;
    // Gentle growth over the window plus day-to-day variation.
    const trend = 0.8 + (d / days) * 0.45;
    const jitter = 0.75 + rng.next() * 0.5;
    dayWeights.push((weekend ? 0.18 : 1) * trend * jitter);
  }
  const weightSum = dayWeights.reduce((s, w) => s + w, 0);

  for (let d = 0; d < days; d++) {
    const date = new Date(endDate);
    date.setDate(date.getDate() - (days - 1 - d));
    const count = Math.round((dayWeights[d] / weightSum) * target);

    for (let i = 0; i < count; i++) {
      const agent = rng.weighted(
        SEED_AGENTS.map((ag) => [ag, ag.skill * 0.6 + 0.7] as const),
      );
      const contact = rng.pick(SEED_CONTACTS);
      const archetype = rng.weighted(archetypeMixFor(agent));
      const built = archetype.build({ rng, agent, contact });

      // Business hours, clustered around mid-morning and mid-afternoon.
      const hour = rng.weighted([
        [8, 6], [9, 12], [10, 15], [11, 13], [12, 6],
        [13, 10], [14, 14], [15, 13], [16, 9], [17, 4],
      ] as const);
      const startedAt = new Date(date);
      startedAt.setHours(hour, rng.int(0, 59), rng.int(0, 59), 0);

      const jitter = 0.7 + rng.next() * 0.6;
      const durationSec = Math.max(8, Math.round(built.baseDurationSec * jitter));

      counter += 1;
      const sourceId = `dp_seed_${String(counter).padStart(5, "0")}`;

      out.push({
        sourceId,
        archetypeSlug: archetype.slug,
        agent,
        contact,
        startedAt,
        durationSec,
        direction:
          archetype.slug === "escalation" ||
          archetype.slug === "parts_inquiry" ||
          archetype.slug === "billing_question"
            ? Direction.inbound
            : Direction.outbound,
        disposition: built.disposition,
        dispositionNotes: built.dispositionNotes,
        // A no-answer has no recording, which is what makes the degraded
        // transcript path reachable from seeded data.
        recordingUrl:
          built.lines.length > 0
            ? `https://recordings.example/${sourceId}`
            : null,
        lines: built.lines,
        expectedThemes: built.expectedThemes,
        expectedRules: built.expectedRules,
        qualityBias: built.qualityBias,
      });
    }
  }

  return out.sort((x, y) => x.startedAt.getTime() - y.startedAt.getTime());
}

/** Space transcript lines across the call so the timeline renders sensibly. */
export function timedSegments(
  lines: SeedLine[],
  durationSec: number,
): Array<{ speakerRole: SpeakerRole; text: string; startMs: number }> {
  if (lines.length === 0) return [];
  const usable = Math.max(1, durationSec - 5) * 1000;
  const step = usable / lines.length;
  return lines.map((line, idx) => ({
    speakerRole: line.role,
    text: line.text,
    startMs: Math.round(idx * step),
  }));
}
