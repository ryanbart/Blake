import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  FellowActionItemRaw,
  FellowMeetingRaw,
  FellowParticipantRaw,
  FellowTranscriptLineRaw,
  parseRenderedTranscript,
  toActionItem,
  toMeeting,
  toParticipant,
  toTranscriptLines,
  type FellowActionItem,
  type FellowMeeting,
  type FellowParticipant,
  type FellowTranscriptLine,
} from "./types";

const FIXTURE_DIR = path.join(process.cwd(), "fixtures", "fellow");

export class FellowError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "FellowError";
  }
}

/** Thrown when a meeting has no recording — a scheduled slot nobody joined. */
export class TranscriptUnavailableError extends FellowError {
  constructor(meetingId: string, status = 404) {
    super(
      `No transcript for Fellow meeting ${meetingId} (HTTP ${status}). The meeting may not have been recorded.`,
      status,
    );
    this.name = "TranscriptUnavailableError";
  }
}

export interface FellowClient {
  listMeetings(opts: { fromDate: Date; toDate: Date }): Promise<FellowMeeting[]>;
  /**
   * Fetch one meeting. The webhook path uses this rather than reading the
   * delivered payload, so a forged or stale body cannot inject conversation
   * content — at most it points us at a meeting to re-read from the API.
   */
  getMeeting(meetingId: string): Promise<FellowMeeting | null>;
  getParticipants(meetingId: string): Promise<FellowParticipant[]>;
  getTranscript(meetingId: string): Promise<FellowTranscriptLine[]>;
  getActionItems(meetingId: string): Promise<FellowActionItem[]>;
}

// ---------------------------------------------------------------------------
// Mock transport
// ---------------------------------------------------------------------------

/**
 * Reads fixtures/fellow, which were shaped from real payloads captured against
 * a live workspace. Fails the way the live API fails: a meeting with no
 * recording raises TranscriptUnavailable rather than returning empty.
 */
export class MockFellowClient implements FellowClient {
  constructor(private readonly fixtureDir: string = FIXTURE_DIR) {}

  private async readJson<T>(file: string): Promise<T> {
    const raw = await readFile(path.join(this.fixtureDir, file), "utf8");
    return JSON.parse(raw) as T;
  }

  async listMeetings(): Promise<FellowMeeting[]> {
    const data = await this.readJson<{ items: unknown[] }>("meetings.json");
    const meetings: FellowMeeting[] = [];
    for (const item of data.items) {
      const parsed = FellowMeetingRaw.safeParse(item);
      if (!parsed.success) continue;
      const participants = await this.getParticipants(parsed.data.meeting_id).catch(
        () => [],
      );
      meetings.push(toMeeting(parsed.data, participants));
    }
    return meetings;
  }

  async getMeeting(meetingId: string): Promise<FellowMeeting | null> {
    const data = await this.readJson<{ items: unknown[] }>("meetings.json");
    for (const item of data.items) {
      const parsed = FellowMeetingRaw.safeParse(item);
      if (!parsed.success || parsed.data.meeting_id !== meetingId) continue;
      const participants = await this.getParticipants(meetingId).catch(() => []);
      return toMeeting(parsed.data, participants);
    }
    return null;
  }

  async getParticipants(meetingId: string): Promise<FellowParticipant[]> {
    try {
      const data = await this.readJson<{ items: unknown[] }>(
        `participants/${meetingId}.json`,
      );
      return data.items
        .map((p) => FellowParticipantRaw.safeParse(p))
        .filter((r) => r.success)
        .map((r) => toParticipant(r.data));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async getTranscript(meetingId: string): Promise<FellowTranscriptLine[]> {
    try {
      const raw = await readFile(
        path.join(this.fixtureDir, "transcripts", `${meetingId}.txt`),
        "utf8",
      );
      return parseRenderedTranscript(raw);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new TranscriptUnavailableError(meetingId);
      }
      throw err;
    }
  }

  async getActionItems(meetingId: string): Promise<FellowActionItem[]> {
    try {
      const data = await this.readJson<{ items: unknown[] }>(
        `action-items/${meetingId}.json`,
      );
      return data.items
        .map((i) => FellowActionItemRaw.safeParse(i))
        .filter((r) => r.success)
        .map((r) => toActionItem(r.data))
        .filter((i): i is FellowActionItem => i !== null);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Live transport
// ---------------------------------------------------------------------------

export interface LiveFellowOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class LiveFellowClient implements FellowClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: LiveFellowOptions) {
    if (!opts.apiKey) {
      throw new FellowError("FELLOW_API_KEY is required for the live transport.");
    }
    this.baseUrl = (opts.baseUrl ?? "https://api.fellow.app/v1").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(pathname: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new FellowError(
        `Fellow GET ${pathname} failed: ${res.status} ${body.slice(0, 300)}`,
        res.status,
      );
    }
    return (await res.json()) as T;
  }

  /**
   * Envelope shape is the least-verified part of this client: the list may be
   * under `items`, `results`, or `meetings`, and the cursor key is unknown.
   * All three are accepted and pagination stops when nothing new arrives, so a
   * wrong guess degrades to one page rather than an infinite loop.
   */
  async listMeetings({
    fromDate,
    toDate,
  }: {
    fromDate: Date;
    toDate: Date;
  }): Promise<FellowMeeting[]> {
    const meetings: FellowMeeting[] = [];
    let cursor: string | undefined;
    let guard = 0;

    do {
      const query = new URLSearchParams({
        from_date: fromDate.toISOString().slice(0, 10),
        to_date: toDate.toISOString().slice(0, 10),
      });
      if (cursor) query.set("cursor", cursor);

      const body = await this.request<{
        items?: unknown[];
        results?: unknown[];
        meetings?: unknown[];
        cursor?: string | null;
        next_cursor?: string | null;
      }>(`/meetings?${query.toString()}`);

      const page = body.items ?? body.results ?? body.meetings ?? [];
      if (page.length === 0) break;

      for (const item of page) {
        const parsed = FellowMeetingRaw.safeParse(item);
        // Skip malformed rows rather than failing the whole sync.
        if (!parsed.success) continue;
        const participants = await this.getParticipants(
          parsed.data.meeting_id,
        ).catch(() => []);
        meetings.push(toMeeting(parsed.data, participants));
      }

      const next = body.next_cursor ?? body.cursor ?? undefined;
      cursor = next === cursor ? undefined : (next ?? undefined);
      guard += 1;
    } while (cursor && guard < 100);

    return meetings;
  }

  async getMeeting(meetingId: string): Promise<FellowMeeting | null> {
    try {
      const body = await this.request<unknown>(
        `/meetings/${encodeURIComponent(meetingId)}`,
      );
      // The single-meeting response may or may not be wrapped; unwrap one level
      // if it is, since a wrapper has no meeting_id of its own to match on.
      const envelope = body as { meeting?: unknown; data?: unknown };
      const candidate = envelope?.meeting ?? envelope?.data ?? body;
      const parsed = FellowMeetingRaw.safeParse(candidate);
      if (!parsed.success) return null;
      const participants = await this.getParticipants(meetingId).catch(() => []);
      return toMeeting(parsed.data, participants);
    } catch (err) {
      if (err instanceof FellowError && err.status === 404) return null;
      throw err;
    }
  }

  async getParticipants(meetingId: string): Promise<FellowParticipant[]> {
    const body = await this.request<{ items?: unknown[]; participants?: unknown[] }>(
      `/meetings/${encodeURIComponent(meetingId)}/participants`,
    );
    return (body.items ?? body.participants ?? [])
      .map((p) => FellowParticipantRaw.safeParse(p))
      .filter((r) => r.success)
      .map((r) => toParticipant(r.data));
  }

  async getTranscript(meetingId: string): Promise<FellowTranscriptLine[]> {
    try {
      const body = await this.request<{
        items?: unknown[];
        lines?: unknown[];
        transcript?: unknown[] | string;
      }>(`/meetings/${encodeURIComponent(meetingId)}/transcript`);

      // The transcript may come back structured or pre-rendered; both happen
      // depending on the surface, so handle either.
      if (typeof body.transcript === "string") {
        return parseRenderedTranscript(body.transcript);
      }
      const rows = body.items ?? body.lines ?? body.transcript ?? [];
      const parsed = rows
        .map((r) => FellowTranscriptLineRaw.safeParse(r))
        .filter((r) => r.success)
        .map((r) => r.data);
      return toTranscriptLines(parsed);
    } catch (err) {
      if (err instanceof FellowError && (err.status === 404 || err.status === 403)) {
        throw new TranscriptUnavailableError(meetingId, err.status);
      }
      throw err;
    }
  }

  async getActionItems(meetingId: string): Promise<FellowActionItem[]> {
    try {
      const body = await this.request<{ items?: unknown[]; action_items?: unknown[] }>(
        `/meetings/${encodeURIComponent(meetingId)}/action-items`,
      );
      return (body.items ?? body.action_items ?? [])
        .map((i) => FellowActionItemRaw.safeParse(i))
        .filter((r) => r.success)
        .map((r) => toActionItem(r.data))
        .filter((i): i is FellowActionItem => i !== null);
    } catch (err) {
      // Action items are enrichment, not the point; never fail a sync for them.
      if (err instanceof FellowError && err.status === 404) return [];
      throw err;
    }
  }
}

export function createFellowClient(env = process.env): FellowClient {
  const transport = (env.FELLOW_TRANSPORT ?? "mock").toLowerCase();
  if (transport === "live") {
    return new LiveFellowClient({
      apiKey: env.FELLOW_API_KEY ?? "",
      baseUrl: env.FELLOW_BASE_URL,
    });
  }
  return new MockFellowClient();
}
