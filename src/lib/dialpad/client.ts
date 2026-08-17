import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  DialpadCallRecord,
  DialpadStatsJob,
  DialpadTranscriptRaw,
  DialpadUserRaw,
  toCall,
  toTranscript,
  toUser,
  type DialpadUser,
  type NormalizedCall,
  type TranscriptLine,
} from "./types";
import { parseCsvRecords } from "./csv";

const FIXTURE_DIR = path.join(process.cwd(), "fixtures", "dialpad");

export class DialpadError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DialpadError";
  }
}

/** Thrown when transcripts are unavailable — usually Dialpad Ai not on the plan. */
export class TranscriptUnavailableError extends DialpadError {
  constructor(callId: string, status: number) {
    super(
      `No transcript for call ${callId} (HTTP ${status}). This usually means Dialpad Ai is not enabled on the plan.`,
      status,
    );
    this.name = "TranscriptUnavailableError";
  }
}

export interface DialpadClient {
  listUsers(): Promise<DialpadUser[]>;
  /** Pull calls for a day window. `daysAgoStart` 0 is today. */
  listCalls(opts: { daysAgoStart: number; daysAgoEnd: number }): Promise<NormalizedCall[]>;
  getTranscript(callId: string): Promise<TranscriptLine[]>;
}

// ---------------------------------------------------------------------------
// Mock transport
// ---------------------------------------------------------------------------

/**
 * Reads fixtures/dialpad. This is what the seed, the tests, and a first-time
 * contributor with no credentials all run against, so it has to behave like the
 * real thing — including failing the way the real thing fails.
 */
export class MockDialpadClient implements DialpadClient {
  constructor(private readonly fixtureDir: string = FIXTURE_DIR) {}

  private async readJson<T>(file: string): Promise<T> {
    const raw = await readFile(path.join(this.fixtureDir, file), "utf8");
    return JSON.parse(raw) as T;
  }

  async listUsers(): Promise<DialpadUser[]> {
    const data = await this.readJson<{ items: unknown[] }>("users.json");
    return data.items.map((u) => toUser(DialpadUserRaw.parse(u)));
  }

  async listCalls(): Promise<NormalizedCall[]> {
    const csv = await readFile(path.join(this.fixtureDir, "calls.csv"), "utf8");
    return parseCsvRecords(csv).map((row) => toCall(DialpadCallRecord.parse(row)));
  }

  async getTranscript(callId: string): Promise<TranscriptLine[]> {
    try {
      const data = await this.readJson<unknown>(`transcripts/${callId}.json`);
      return toTranscript(DialpadTranscriptRaw.parse(data));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Mirrors the live 404 so callers exercise the same degraded path.
        throw new TranscriptUnavailableError(callId, 404);
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Live transport
// ---------------------------------------------------------------------------

export interface LiveDialpadOptions {
  apiKey: string;
  baseUrl?: string;
  /** Poll budget for the async stats export. */
  statsTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  /**
   * Observe raw responses before they are mapped.
   *
   * Exists for `npm run verify -- --dump`, which reports the *field names*
   * Dialpad actually returned. The mappers here were written without access to
   * the API docs, so when one misses, the mapped value is null and the output
   * cannot say why — the raw key list is what turns that into a one-line fix.
   *
   * Diagnostic only: absent in every production path, and never awaited, so a
   * throwing callback cannot break a sync.
   */
  onRawResponse?: (endpoint: string, body: unknown) => void;
}

export class LiveDialpadClient implements DialpadClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: LiveDialpadOptions) {
    if (!opts.apiKey) {
      throw new DialpadError("DIALPAD_API_KEY is required for the live transport.");
    }
    this.baseUrl = (opts.baseUrl ?? "https://dialpad.com/api/v2").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(
    pathname: string,
    init: RequestInit = {},
  ): Promise<{ status: number; body: T }> {
    const res = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new DialpadError(
        `Dialpad ${init.method ?? "GET"} ${pathname} failed: ${res.status} ${text.slice(0, 400)}`,
        res.status,
      );
    }
    const body = (await res.json()) as T;
    if (this.opts.onRawResponse) {
      // Never let a diagnostic hook take down a sync.
      try {
        this.opts.onRawResponse(pathname, body);
      } catch {
        /* ignore */
      }
    }
    return { status: res.status, body };
  }

  async listUsers(): Promise<DialpadUser[]> {
    const users: DialpadUser[] = [];
    let cursor: string | undefined;

    do {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const { body } = await this.request<{
        items?: unknown[];
        users?: unknown[];
        cursor?: string | null;
      }>(`/users${query}`);

      for (const item of body.items ?? body.users ?? []) {
        const parsed = DialpadUserRaw.safeParse(item);
        if (parsed.success) users.push(toUser(parsed.data));
      }
      cursor = body.cursor ?? undefined;
    } while (cursor);

    return users;
  }

  /**
   * Historical calls via the async stats export: request a job, poll until the
   * CSV is ready, download and parse it.
   *
   * Dialpad refreshes the historical tables every few hours, which is why the
   * nightly backfill uses an overlapping window rather than only yesterday.
   */
  async listCalls({
    daysAgoStart,
    daysAgoEnd,
  }: {
    daysAgoStart: number;
    daysAgoEnd: number;
  }): Promise<NormalizedCall[]> {
    const { body: created } = await this.request<unknown>("/stats", {
      method: "POST",
      body: JSON.stringify({
        export_type: "records",
        stat_type: "calls",
        days_ago_start: daysAgoStart,
        days_ago_end: daysAgoEnd,
        timezone: "UTC",
      }),
    });

    const job = DialpadStatsJob.parse(created);
    const downloadUrl = await this.pollStats(job.request_id);

    const res = await this.fetchImpl(downloadUrl);
    if (!res.ok) {
      throw new DialpadError(
        `Stats download failed: ${res.status}`,
        res.status,
      );
    }
    const csv = await res.text();

    const calls: NormalizedCall[] = [];
    for (const row of parseCsvRecords(csv)) {
      const parsed = DialpadCallRecord.safeParse(row);
      // Skip malformed rows rather than failing the whole backfill — one bad
      // row should not cost a night's ingest.
      if (parsed.success) calls.push(toCall(parsed.data));
    }
    return calls;
  }

  private async pollStats(requestId: string): Promise<string> {
    const deadline = Date.now() + (this.opts.statsTimeoutMs ?? 5 * 60_000);
    let delay = 1_000;

    while (Date.now() < deadline) {
      const { body } = await this.request<unknown>(`/stats/${requestId}`);
      const job = DialpadStatsJob.parse(body);
      const status = (job.status ?? "").toLowerCase();

      if (job.download_url) return job.download_url;
      if (status === "failed" || status === "error") {
        throw new DialpadError(`Stats export ${requestId} failed.`);
      }

      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 15_000);
    }
    throw new DialpadError(`Stats export ${requestId} timed out.`);
  }

  async getTranscript(callId: string): Promise<TranscriptLine[]> {
    try {
      const { body } = await this.request<unknown>(`/transcripts/${callId}`);
      return toTranscript(DialpadTranscriptRaw.parse(body));
    } catch (err) {
      if (
        err instanceof DialpadError &&
        (err.status === 404 || err.status === 403)
      ) {
        throw new TranscriptUnavailableError(callId, err.status);
      }
      throw err;
    }
  }
}

/** Pick a transport from the environment. Defaults to mock so nothing calls out by accident. */
export function createDialpadClient(
  env = process.env,
  // Diagnostic overrides. Only `verify --dump` passes anything here; the mock
  // transport makes no HTTP requests, so the hook simply never fires there.
  opts: Pick<LiveDialpadOptions, "onRawResponse"> = {},
): DialpadClient {
  const transport = (env.DIALPAD_TRANSPORT ?? "mock").toLowerCase();
  if (transport === "live") {
    return new LiveDialpadClient({
      apiKey: env.DIALPAD_API_KEY ?? "",
      baseUrl: env.DIALPAD_BASE_URL,
      onRawResponse: opts.onRawResponse,
    });
  }
  return new MockDialpadClient();
}
