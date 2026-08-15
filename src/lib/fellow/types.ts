import { z } from "zod";

/**
 * Fellow API shapes.
 *
 * developers.fellow.ai is unreachable from this environment, so these were
 * built from payloads captured against a live workspace (unitedmh.fellow.app)
 * rather than from documentation. That makes the field names better grounded
 * than the Dialpad ones, but the *envelope* — pagination, error shape, webhook
 * signing — is still unverified, so everything stays tolerant:
 * `.passthrough()`, optional fields, and one mapper per shape.
 */

const id = z.union([z.string(), z.number()]).transform((v) => String(v));

/**
 * A meeting participant.
 *
 * `is_external` is the load-bearing field: it decides whether a meeting is a
 * customer conversation at all, which in turn gates coaching analysis and (in
 * Phase 3) CRM extraction. An internal standup must not be scored on a sales
 * rubric or generate opportunity suggestions.
 *
 * Note `name` is optional while `email` is not. Externals invited by address
 * often arrive with no display name at all, which is why speaker matching
 * cannot rely on names alone — see matchSpeakerToParticipant().
 */
export const FellowParticipantRaw = z
  .object({
    email: z.string(),
    name: z.string().optional(),
    is_attendee: z.boolean().optional(),
    is_organizer: z.boolean().optional(),
    is_optional: z.boolean().optional(),
    is_external: z.boolean().optional(),
    rsvp: z.string().optional(),
  })
  .passthrough();
export type FellowParticipantRaw = z.infer<typeof FellowParticipantRaw>;

export interface FellowParticipant {
  email: string;
  name: string | null;
  isExternal: boolean;
  isOrganizer: boolean;
}

export function toParticipant(raw: FellowParticipantRaw): FellowParticipant {
  return {
    email: raw.email.toLowerCase(),
    name: raw.name ?? null,
    // Default to internal: mislabelling a colleague as a customer would put
    // internal conversation into CRM suggestions, which is the worse error.
    isExternal: raw.is_external ?? false,
    isOrganizer: raw.is_organizer ?? false,
  };
}

export const FellowSummaryRaw = z
  .object({
    final_summary: z.string().optional(),
    summary: z.string().optional(),
  })
  .passthrough();

export const FellowMeetingRaw = z
  .object({
    meeting_id: z.string(),
    title: z.string().optional(),
    start_time: z.string().optional(),
    end_time: z.string().optional(),
    note_id: id.optional(),
    recording_id: id.optional(),
    note: z.string().optional(),
    url: z.string().optional(),
    meeting_link: z.string().optional(),
    video_url: z.string().optional(),
    media_type: z.string().optional(),
    summaries: z.array(FellowSummaryRaw).optional(),
    quotes: z.array(z.unknown()).optional(),
    recap_highlights: z.array(z.unknown()).optional(),
    // The meeting-search payload returns participants as bare display names;
    // the participants endpoint returns objects with emails. Accept both.
    participants: z
      .array(z.union([z.string(), FellowParticipantRaw]))
      .optional(),
  })
  .passthrough();
export type FellowMeetingRaw = z.infer<typeof FellowMeetingRaw>;

export interface FellowMeeting {
  meetingId: string;
  title: string | null;
  startedAt: Date;
  durationSec: number;
  noteId: string | null;
  recordingId: string | null;
  notes: string | null;
  summary: string | null;
  externalUrl: string | null;
  recordingUrl: string | null;
  participants: FellowParticipant[];
}

export function toMeeting(
  raw: FellowMeetingRaw,
  participants: FellowParticipant[] = [],
): FellowMeeting {
  const startedAt = parseIso(raw.start_time);
  const endedAt = raw.end_time ? parseIso(raw.end_time) : null;

  // Scheduled length, not talk time. Fellow reports calendar bounds; a meeting
  // that ended early still reports its booked window, so this is an upper
  // bound and the transcript is the truth about how long anyone spoke.
  const durationSec =
    endedAt && endedAt > startedAt
      ? Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)
      : 0;

  const inline = (raw.participants ?? []).filter(
    (p): p is FellowParticipantRaw => typeof p !== "string",
  );

  return {
    meetingId: raw.meeting_id,
    title: raw.title?.trim() || null,
    startedAt,
    durationSec,
    noteId: raw.note_id ?? null,
    recordingId: raw.recording_id ?? null,
    notes: raw.note?.trim() || null,
    summary:
      raw.summaries?.map((s) => s.final_summary ?? s.summary).find(Boolean) ??
      null,
    externalUrl: raw.url ?? raw.meeting_link ?? null,
    recordingUrl: raw.video_url ?? null,
    participants:
      participants.length > 0 ? participants : inline.map(toParticipant),
  };
}

/**
 * One transcript line.
 *
 * Unlike Dialpad, Fellow identifies the speaker by display name rather than by
 * side, so the agent/customer split has to be derived — see
 * matchSpeakerToParticipant().
 */
export const FellowTranscriptLineRaw = z
  .object({
    speaker: z.string().optional(),
    speaker_name: z.string().optional(),
    name: z.string().optional(),
    text: z.string().optional(),
    content: z.string().optional(),
    // Seconds from the start of this recording part.
    start_time: z.union([z.string(), z.number()]).optional(),
    timestamp: z.union([z.string(), z.number()]).optional(),
    recording_id: id.optional(),
  })
  .passthrough();
export type FellowTranscriptLineRaw = z.infer<typeof FellowTranscriptLineRaw>;

export interface FellowTranscriptLine {
  speakerName: string | null;
  startMs: number;
  text: string;
}

export function toTranscriptLines(
  raw: FellowTranscriptLineRaw[],
): FellowTranscriptLine[] {
  const lines: FellowTranscriptLine[] = [];
  for (const line of raw) {
    const text = (line.text ?? line.content ?? "").trim();
    if (!text) continue;
    lines.push({
      speakerName: line.speaker ?? line.speaker_name ?? line.name ?? null,
      startMs: toMs(line.start_time ?? line.timestamp),
      text,
    });
  }
  return lines;
}

/**
 * Parse the rendered `[HH:MM:SS] Speaker: text` transcript form.
 *
 * Kept because it is the shape the MCP connector returns and the shape captured
 * from the live workspace; if the REST endpoint returns structured JSON,
 * toTranscriptLines() handles that instead and this stays as the fallback.
 *
 * Continuation lines (no timestamp prefix) are appended to the previous
 * speaker's turn rather than dropped — a wrapped sentence is not a new turn.
 */
export function parseRenderedTranscript(text: string): FellowTranscriptLine[] {
  const lines: FellowTranscriptLine[] = [];
  const pattern = /^\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]\s*([^:]{1,80}?):\s*(.*)$/;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("<")) continue;

    const match = pattern.exec(line);
    if (!match) {
      if (lines.length > 0) lines[lines.length - 1].text += ` ${line}`;
      continue;
    }

    const [, a, b, c, speaker, content] = match;
    // Two-group form is MM:SS; three-group is HH:MM:SS.
    const startMs =
      c === undefined
        ? (Number(a) * 60 + Number(b)) * 1000
        : (Number(a) * 3600 + Number(b) * 60 + Number(c)) * 1000;

    const body = content.trim();
    if (!body) continue;
    lines.push({ speakerName: speaker.trim(), startMs, text: body });
  }
  return lines;
}

/**
 * Resolve a transcript speaker name to a participant.
 *
 * Needed because the two sides of the join disagree: the transcript has a
 * display name and no email, while a participant may have an email and no name
 * (externals invited by address routinely arrive that way). Matching therefore
 * falls back to the email local part — "Peter.dehaan@apex-cos.com" becomes
 * "peter dehaan", which matches the transcript's "Peter Dehaan".
 *
 * Returns null rather than guessing. An unmatched speaker becomes `unknown`,
 * which is excluded from agent-targeted rules — better a missed flag than
 * blaming a rep for what the customer said.
 */
export function matchSpeakerToParticipant(
  speakerName: string | null,
  participants: FellowParticipant[],
): FellowParticipant | null {
  if (!speakerName) return null;
  const needle = normalizeName(speakerName);
  if (!needle) return null;

  const identityOf = (p: FellowParticipant) =>
    normalizeName(p.name ?? emailLocalPart(p.email));

  /**
   * A bare first name is ambiguous whenever two participants share it, and
   * that holds regardless of which matching path would resolve it. "Ryan"
   * exactly equals the local part of ryan@acme.com, but if a Ryan Chen is also
   * on the call, accepting that exact match is a coin flip — and the losing
   * side of that flip attributes a customer's words to a rep. Bail before
   * trying any strategy.
   */
  if (!needle.includes(" ")) {
    const sharingFirstName = participants.filter(
      (p) => identityOf(p).split(" ")[0] === needle,
    );
    if (sharingFirstName.length > 1) return null;
  }

  const byName = participants.find(
    (p) => p.name && normalizeName(p.name) === needle,
  );
  if (byName) return byName;

  const byEmailLocal = participants.find(
    (p) => normalizeName(emailLocalPart(p.email)) === needle,
  );
  if (byEmailLocal) return byEmailLocal;

  // Last resort: a unique first-name match, so "Peter" and "Peter de Haan"
  // both reach "Peter Dehaan". Ambiguity is left unresolved — a wrong side is
  // worse than an unknown one.
  const firstName = needle.split(" ")[0];
  const firstMatches = participants.filter(
    (p) => identityOf(p).split(" ")[0] === firstName,
  );
  return firstMatches.length === 1 ? firstMatches[0] : null;
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[._-]+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function emailLocalPart(email: string): string {
  return email.split("@")[0] ?? "";
}

export function parseIso(value: string | undefined): Date {
  if (!value) return new Date(0);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function toMs(value: string | number | undefined): number {
  if (value === undefined) return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  // Values this large are already milliseconds; Fellow reports seconds.
  return n > 100_000 ? Math.round(n) : Math.round(n * 1000);
}

/** Action items Fellow extracted. Inputs to our analysis, not replacements. */
export const FellowActionItemRaw = z
  .object({
    id: id.optional(),
    text: z.string().optional(),
    title: z.string().optional(),
    assignee: z.string().optional(),
    assignee_email: z.string().optional(),
    due_date: z.string().optional(),
    completed: z.boolean().optional(),
  })
  .passthrough();
export type FellowActionItemRaw = z.infer<typeof FellowActionItemRaw>;

export interface FellowActionItem {
  text: string;
  assigneeEmail: string | null;
  dueDate: string | null;
  completed: boolean;
}

export function toActionItem(raw: FellowActionItemRaw): FellowActionItem | null {
  const text = (raw.text ?? raw.title ?? "").trim();
  if (!text) return null;
  return {
    text,
    assigneeEmail: raw.assignee_email?.toLowerCase() ?? null,
    dueDate: raw.due_date ?? null,
    completed: raw.completed ?? false,
  };
}
