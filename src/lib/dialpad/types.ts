import { z } from "zod";

/**
 * Dialpad API shapes.
 *
 * developers.dialpad.com is unreachable from this environment, so these are
 * built from published endpoint behavior and encoded defensively:
 *
 *   - every schema is `.passthrough()`, so an unexpected field is carried
 *     through rather than throwing;
 *   - everything not needed to identify a call is optional;
 *   - each raw shape has exactly one `toX()` mapper below it, so correcting a
 *     field name after checking the live docs is a one-line change here rather
 *     than a hunt through call sites.
 *
 * `npm run verify -- --dialpad` prints the first live response next to what we
 * expect, which is the intended way to confirm these before trusting them.
 */

/** Dialpad returns numeric ids as strings in some payloads and numbers in others. */
const id = z.union([z.string(), z.number()]).transform((v) => String(v));

/** Epoch milliseconds, sometimes stringified. */
const epochMs = z
  .union([z.string(), z.number()])
  .transform((v) => Number(v))
  .refine((n) => Number.isFinite(n), "not a timestamp");

export const DialpadUserRaw = z
  .object({
    id,
    display_name: z.string().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    emails: z.array(z.string()).optional(),
    email: z.string().optional(),
    office_id: id.optional(),
    state: z.string().optional(),
    is_admin: z.boolean().optional(),
  })
  .passthrough();
export type DialpadUserRaw = z.infer<typeof DialpadUserRaw>;

export interface DialpadUser {
  id: string;
  name: string;
  email: string | null;
  officeId: string | null;
  active: boolean;
}

export function toUser(raw: DialpadUserRaw): DialpadUser {
  const name =
    raw.display_name ??
    [raw.first_name, raw.last_name].filter(Boolean).join(" ").trim();
  return {
    id: raw.id,
    name: name || `Dialpad user ${raw.id}`,
    email: raw.email ?? raw.emails?.[0] ?? null,
    officeId: raw.office_id ?? null,
    active: raw.state ? raw.state.toLowerCase() === "active" : true,
  };
}

export const DialpadListResponse = <T extends z.ZodTypeAny>(item: T) =>
  z
    .object({
      items: z.array(item).optional(),
      // Some endpoints key the array by resource name instead of `items`.
      users: z.array(item).optional(),
      cursor: z.string().nullish(),
    })
    .passthrough();

/** One line of a Dialpad Ai transcript. */
export const DialpadTranscriptLineRaw = z
  .object({
    name: z.string().optional(),
    content: z.string().optional(),
    text: z.string().optional(),
    time: epochMs.optional(),
    start_time: epochMs.optional(),
    type: z.string().optional(),
    // Dialpad labels the speaker's side; exact vocabulary varies by plan.
    speaker_type: z.string().optional(),
recipient: z.string().optional(),
  })
  .passthrough();
export type DialpadTranscriptLineRaw = z.infer<typeof DialpadTranscriptLineRaw>;

export const DialpadTranscriptRaw = z
  .object({
    call_id: id.optional(),
    lines: z.array(DialpadTranscriptLineRaw).optional(),
    transcript: z.array(DialpadTranscriptLineRaw).optional(),
    moments: z.array(z.unknown()).optional(),
  })
  .passthrough();
export type DialpadTranscriptRaw = z.infer<typeof DialpadTranscriptRaw>;

export interface TranscriptLine {
  speakerName: string | null;
  /** Raw speaker label; mapping to agent/customer happens at ingest. */
  speakerLabel: string | null;
  startMs: number;
  text: string;
}

export function toTranscript(raw: DialpadTranscriptRaw): TranscriptLine[] {
  const lines = raw.lines ?? raw.transcript ?? [];
  const out: TranscriptLine[] = [];
  let firstTs: number | null = null;

  for (const line of lines) {
    const text = (line.content ?? line.text ?? "").trim();
    if (!text) continue;
    // Dialpad interleaves non-speech entries (call started, hold, transfer).
    if (line.type && line.type !== "transcript") continue;

    const ts = line.time ?? line.start_time ?? 0;
    if (firstTs === null && ts) firstTs = ts;
    // Absolute epoch times become offsets from the first line so the UI can
    // render a timeline without knowing when the call started.
    const startMs = ts && firstTs ? Math.max(0, ts - firstTs) : 0;

    out.push({
      speakerName: line.name ?? null,
      speakerLabel: line.speaker_type ?? line.recipient ?? null,
      startMs,
      text,
    });
  }
  return out;
}

/** One row of the `stat_type: "calls"` CSV export. */
export const DialpadCallRecord = z
  .object({
    call_id: z.string(),
    date_started: z.string().optional(),
    direction: z.string().optional(),
    duration: z.string().optional(),
    total_duration: z.string().optional(),
    target_id: z.string().optional(),
    target_name: z.string().optional(),
    external_number: z.string().optional(),
    contact_name: z.string().optional(),
    disposition: z.string().optional(),
    disposition_notes: z.string().optional(),
    recording_url: z.string().optional(),
  })
  .passthrough();
export type DialpadCallRecord = z.infer<typeof DialpadCallRecord>;

export interface NormalizedCall {
  sourceId: string;
  startedAt: Date;
  durationSec: number;
  direction: "inbound" | "outbound" | "internal";
  dialpadUserId: string | null;
  agentName: string | null;
  contactName: string | null;
  contactPhone: string | null;
  disposition: string | null;
  dispositionNotes: string | null;
  recordingUrl: string | null;
}

export function toCall(raw: DialpadCallRecord): NormalizedCall {
  const dir = (raw.direction ?? "").toLowerCase();
  const direction =
    dir === "inbound" ? "inbound" : dir === "internal" ? "internal" : "outbound";

  const durationRaw = raw.duration ?? raw.total_duration ?? "0";
  const durationNum = Number(durationRaw);
  // The export reports duration in seconds on some plans and milliseconds on
  // others. A "call" over 24h is the giveaway; treat it as ms.
  const durationSec = !Number.isFinite(durationNum)
    ? 0
    : durationNum > 86_400
      ? Math.round(durationNum / 1000)
      : Math.round(durationNum);

  return {
    sourceId: raw.call_id,
    startedAt: parseTimestamp(raw.date_started),
    durationSec,
    direction,
    dialpadUserId: raw.target_id ?? null,
    agentName: raw.target_name ?? null,
    contactName: raw.contact_name ?? null,
    contactPhone: raw.external_number ?? null,
    disposition: raw.disposition ?? null,
    dispositionNotes: raw.disposition_notes ?? null,
    recordingUrl: raw.recording_url ?? null,
  };
}

/** Accepts ISO strings and epoch seconds/milliseconds; never throws. */
export function parseTimestamp(value: string | undefined): Date {
  if (!value) return new Date(0);
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && value.trim() !== "") {
    // 10 digits is seconds, 13 is milliseconds.
    return new Date(asNumber > 1e11 ? asNumber : asNumber * 1000);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

/** Async stats-export job handle. */
export const DialpadStatsJob = z
  .object({
    request_id: z.string(),
    status: z.string().optional(),
    download_url: z.string().nullish(),
    file_type: z.string().optional(),
  })
  .passthrough();
export type DialpadStatsJob = z.infer<typeof DialpadStatsJob>;

/**
 * Call-event webhook payload. Dialpad delivers these as HS256-signed JWTs; this
 * is the decoded claim set.
 */
export const DialpadCallEvent = z
  .object({
    call_id: id,
    state: z.string().optional(),
    direction: z.string().optional(),
    date_started: z.union([z.string(), z.number()]).optional(),
    date_ended: z.union([z.string(), z.number()]).optional(),
    duration: z.union([z.string(), z.number()]).optional(),
    target: z
      .object({
        id: id.optional(),
        name: z.string().optional(),
        type: z.string().optional(),
      })
      .passthrough()
      .optional(),
    contact: z
      .object({
        id: id.optional(),
        name: z.string().optional(),
        phone: z.string().optional(),
      })
      .passthrough()
      .optional(),
    external_number: z.string().optional(),
    recording_url: z.string().nullish(),
    admin_call_recording_share_link: z.string().nullish(),
  })
  .passthrough();
export type DialpadCallEvent = z.infer<typeof DialpadCallEvent>;

export function callEventToCall(event: DialpadCallEvent): NormalizedCall {
  const dir = (event.direction ?? "").toLowerCase();
  const durationNum = Number(event.duration ?? 0);
  const durationSec = !Number.isFinite(durationNum)
    ? 0
    : durationNum > 86_400
      ? Math.round(durationNum / 1000)
      : Math.round(durationNum);

  return {
    sourceId: event.call_id,
    startedAt: parseTimestamp(
      event.date_started === undefined ? undefined : String(event.date_started),
    ),
    durationSec,
    direction:
      dir === "inbound" ? "inbound" : dir === "internal" ? "internal" : "outbound",
    dialpadUserId: event.target?.id ?? null,
    agentName: event.target?.name ?? null,
    contactName: event.contact?.name ?? null,
    contactPhone: event.contact?.phone ?? event.external_number ?? null,
    disposition: null,
    dispositionNotes: null,
    recordingUrl:
      event.recording_url ?? event.admin_call_recording_share_link ?? null,
  };
}
