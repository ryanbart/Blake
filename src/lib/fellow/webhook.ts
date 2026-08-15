import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Fellow webhook verification.
 *
 * Unlike Dialpad — where the scheme is known to be an HS256 JWT — Fellow's
 * webhook signing is the one thing in this integration that could not be
 * grounded: developers.fellow.ai is unreachable from here and no signed
 * delivery has been observed. So this does not guess a scheme and hope.
 *
 * It implements the two schemes essentially every vendor uses, tries both, and
 * **rejects anything that matches neither**. The failure mode that matters is
 * the one where an unverifiable payload gets waved through because "we're not
 * sure how they sign it yet" — a public endpoint that writes to the database.
 * Not knowing the scheme is a reason to reject more, not fewer, payloads.
 *
 * TODO(fellow): once a real delivery is captured, keep the matching scheme and
 * delete the other. `npm run verify -- --fellow` prints the headers of the last
 * received delivery to make that a five-minute job.
 */

export class FellowWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FellowWebhookError";
  }
}

/** Headers a signature has plausibly arrived in, most specific first. */
const SIGNATURE_HEADERS = [
  "x-fellow-signature",
  "fellow-signature",
  "x-fellow-webhook-signature",
  "x-hub-signature-256",
  "x-signature",
];

const TIMESTAMP_HEADERS = ["x-fellow-timestamp", "fellow-timestamp", "x-timestamp"];

/** Reject a delivery signed more than this long ago — bounds replay. */
const MAX_SKEW_SECONDS = 300;

export interface FellowWebhookHeaders {
  get(name: string): string | null;
}

/**
 * Constant-time compare of two candidate signatures.
 *
 * Length is compared first and non-constant-time, which is fine: signature
 * length is not secret, and a mismatched length cannot be fed to
 * timingSafeEqual at all.
 */
function matches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function hmac(secret: string, payload: string, encoding: "hex" | "base64"): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest(encoding);
}

/**
 * Strip a scheme prefix. `sha256=abc…` and `v1=abc…` both appear in the wild,
 * and a bare digest does too.
 */
function stripPrefix(value: string): string {
  const eq = value.indexOf("=");
  if (eq === -1) return value.trim();
  const prefix = value.slice(0, eq).trim().toLowerCase();
  return ["sha256", "sha-256", "v1", "s"].includes(prefix)
    ? value.slice(eq + 1).trim()
    : value.trim();
}

/** Parse the Stripe-style `t=<unix>,v1=<sig>` composite header, if that is what this is. */
function parseComposite(
  header: string,
): { timestamp: string; signatures: string[] } | null {
  if (!header.includes("=") || !header.includes(",")) return null;
  let timestamp: string | null = null;
  const signatures: string[] = [];

  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    if (key === "t") timestamp = value;
    else if (key.startsWith("v")) signatures.push(value);
  }

  return timestamp && signatures.length > 0 ? { timestamp, signatures } : null;
}

function assertFresh(timestamp: string, now: number): void {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) {
    throw new FellowWebhookError("Signature timestamp is not a number.");
  }
  // Accept seconds or milliseconds; the epoch in seconds passed 10^10 in 2286.
  const epochMs = seconds > 1e11 ? seconds : seconds * 1000;
  if (Math.abs(now - epochMs) > MAX_SKEW_SECONDS * 1000) {
    throw new FellowWebhookError(
      `Signature timestamp is outside the ${MAX_SKEW_SECONDS}s tolerance; treating as a replay.`,
    );
  }
}

/**
 * Verify a raw Fellow webhook body against the shared secret.
 *
 * Throws FellowWebhookError on anything short of a match. Callers must not
 * touch the database until this returns.
 */
export function verifySignature(
  rawBody: string,
  headers: FellowWebhookHeaders,
  secret: string,
  now: number = Date.now(),
): void {
  if (!secret) {
    throw new FellowWebhookError(
      "FELLOW_WEBHOOK_SECRET is not set; refusing to trust an unverifiable payload.",
    );
  }

  let header: string | null = null;
  for (const name of SIGNATURE_HEADERS) {
    header = headers.get(name);
    if (header) break;
  }
  if (!header) {
    throw new FellowWebhookError(
      `No signature header found (looked for: ${SIGNATURE_HEADERS.join(", ")}).`,
    );
  }

  // Scheme A: composite header carrying its own timestamp, signed over
  // `${timestamp}.${body}` so the timestamp cannot be edited independently.
  const composite = parseComposite(header);
  if (composite) {
    assertFresh(composite.timestamp, now);
    const signed = `${composite.timestamp}.${rawBody}`;
    for (const candidate of composite.signatures) {
      for (const encoding of ["hex", "base64"] as const) {
        if (matches(hmac(secret, signed, encoding), stripPrefix(candidate))) return;
      }
    }
    throw new FellowWebhookError("Signature does not match the request body.");
  }

  // Scheme B: a bare digest, optionally with the timestamp in its own header.
  const provided = stripPrefix(header);
  let timestamp: string | null = null;
  for (const name of TIMESTAMP_HEADERS) {
    timestamp = headers.get(name);
    if (timestamp) break;
  }
  if (timestamp) assertFresh(timestamp, now);

  // With a separate timestamp header, the signed payload may or may not include
  // it. Try both; both are HMACs under the same secret, so accepting either
  // widens the accepted set by nothing an attacker can reach without it.
  const payloads = timestamp ? [`${timestamp}.${rawBody}`, rawBody] : [rawBody];
  for (const payload of payloads) {
    for (const encoding of ["hex", "base64"] as const) {
      if (matches(hmac(secret, payload, encoding), provided)) return;
    }
  }

  throw new FellowWebhookError("Signature does not match the request body.");
}

/**
 * The event envelope.
 *
 * Only one field is load-bearing — which meeting changed. Everything else in
 * the payload is ignored in favour of re-fetching from the API, so a webhook
 * cannot inject conversation content: it can only tell us to go look.
 */
export const FellowWebhookEvent = z
  .object({
    event: z.string().optional(),
    event_type: z.string().optional(),
    type: z.string().optional(),
    meeting_id: z.string().optional(),
    data: z
      .object({
        meeting_id: z.string().optional(),
        meeting: z.object({ meeting_id: z.string().optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
    meeting: z.object({ meeting_id: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();
export type FellowWebhookEvent = z.infer<typeof FellowWebhookEvent>;

export interface ParsedFellowEvent {
  eventType: string | null;
  meetingId: string;
}

/** Pull the event type and meeting id out of whichever nesting Fellow used. */
export function parseEvent(body: unknown): ParsedFellowEvent {
  const parsed = FellowWebhookEvent.safeParse(body);
  if (!parsed.success) {
    throw new FellowWebhookError("Payload is not a Fellow webhook event.");
  }
  const e = parsed.data;

  const meetingId =
    e.meeting_id ??
    e.data?.meeting_id ??
    e.data?.meeting?.meeting_id ??
    e.meeting?.meeting_id;

  if (!meetingId) {
    throw new FellowWebhookError("Event carries no meeting_id.");
  }

  return {
    eventType: e.event ?? e.event_type ?? e.type ?? null,
    meetingId,
  };
}

/** Sign a body the way this verifier expects. Test helper — not a production path. */
export function signBody(
  rawBody: string,
  secret: string,
  { timestamp }: { timestamp?: number } = {},
): { header: string; value: string } {
  if (timestamp === undefined) {
    return {
      header: "x-fellow-signature",
      value: `sha256=${hmac(secret, rawBody, "hex")}`,
    };
  }
  const seconds = Math.floor(timestamp / 1000);
  return {
    header: "x-fellow-signature",
    value: `t=${seconds},v1=${hmac(secret, `${seconds}.${rawBody}`, "hex")}`,
  };
}
