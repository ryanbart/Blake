import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FellowWebhookError,
  parseEvent,
  signBody,
  verifySignature,
} from "@/lib/fellow/webhook";

const SECRET = "whsec_fellow_test_secret";
const BODY = JSON.stringify({ event: "meeting.completed", meeting_id: "fw_apex_0814" });

/** Minimal Headers stand-in so tests don't depend on a fetch Request. */
function headers(map: Record<string, string>) {
  const lower = new Map(
    Object.entries(map).map(([k, v]) => [k.toLowerCase(), v] as const),
  );
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

function hmac(payload: string, encoding: "hex" | "base64" = "hex") {
  return createHmac("sha256", SECRET).update(payload, "utf8").digest(encoding);
}

describe("Fellow webhook signature verification", () => {
  it("accepts a bare hex digest with a sha256= prefix", () => {
    const { header, value } = signBody(BODY, SECRET);
    expect(() =>
      verifySignature(BODY, headers({ [header]: value }), SECRET),
    ).not.toThrow();
  });

  it("accepts a composite t=,v1= header signed over timestamp.body", () => {
    const now = Date.UTC(2026, 7, 15, 12, 0, 0);
    const { header, value } = signBody(BODY, SECRET, { timestamp: now });
    expect(() =>
      verifySignature(BODY, headers({ [header]: value }), SECRET, now),
    ).not.toThrow();
  });

  /**
   * The scheme could not be confirmed against Fellow's docs, so the verifier
   * accepts several encodings. Each still has to be a real HMAC under the
   * secret — breadth of encoding is not breadth of trust.
   */
  it.each([
    ["bare hex, no prefix", () => hmac(BODY)],
    ["base64", () => hmac(BODY, "base64")],
    ["base64 with prefix", () => `sha256=${hmac(BODY, "base64")}`],
  ])("accepts %s", (_label, make) => {
    expect(() =>
      verifySignature(BODY, headers({ "x-fellow-signature": make() }), SECRET),
    ).not.toThrow();
  });

  it.each([
    "x-fellow-signature",
    "fellow-signature",
    "x-fellow-webhook-signature",
    "x-hub-signature-256",
    "x-signature",
  ])("finds the signature in %s", (name) => {
    expect(() =>
      verifySignature(BODY, headers({ [name]: hmac(BODY) }), SECRET),
    ).not.toThrow();
  });

  it("rejects a tampered body", () => {
    const { header, value } = signBody(BODY, SECRET);
    const tampered = JSON.stringify({
      event: "meeting.completed",
      meeting_id: "fw_someone_elses_meeting",
    });
    expect(() =>
      verifySignature(tampered, headers({ [header]: value }), SECRET),
    ).toThrow(FellowWebhookError);
  });

  it("rejects a signature made with a different secret", () => {
    const forged = createHmac("sha256", "not-the-secret")
      .update(BODY)
      .digest("hex");
    expect(() =>
      verifySignature(BODY, headers({ "x-fellow-signature": forged }), SECRET),
    ).toThrow(FellowWebhookError);
  });

  /**
   * The failure that matters most. An endpoint that writes to the database and
   * waves payloads through because the scheme is unconfirmed is worse than one
   * that rejects everything until it is configured.
   */
  it("refuses to verify when no secret is configured", () => {
    expect(() =>
      verifySignature(BODY, headers({ "x-fellow-signature": hmac(BODY) }), ""),
    ).toThrow(/not set/i);
  });

  it("rejects a payload carrying no signature header at all", () => {
    expect(() =>
      verifySignature(BODY, headers({ "content-type": "application/json" }), SECRET),
    ).toThrow(/no signature header/i);
  });

  it("rejects a correctly-signed replay outside the timestamp tolerance", () => {
    const signedAt = Date.UTC(2026, 7, 15, 12, 0, 0);
    const { header, value } = signBody(BODY, SECRET, { timestamp: signedAt });
    // Same valid signature, replayed an hour later.
    expect(() =>
      verifySignature(BODY, headers({ [header]: value }), SECRET, signedAt + 3_600_000),
    ).toThrow(/replay/i);
  });

  it("accepts a timestamp supplied in its own header", () => {
    const now = Date.UTC(2026, 7, 15, 12, 0, 0);
    const seconds = Math.floor(now / 1000);
    expect(() =>
      verifySignature(
        BODY,
        headers({
          "x-fellow-signature": hmac(`${seconds}.${BODY}`),
          "x-fellow-timestamp": String(seconds),
        }),
        SECRET,
        now,
      ),
    ).not.toThrow();
  });

  it("rejects a stale separate timestamp header even when the digest matches", () => {
    const signedAt = Date.UTC(2026, 7, 15, 12, 0, 0);
    const seconds = Math.floor(signedAt / 1000);
    expect(() =>
      verifySignature(
        BODY,
        headers({
          "x-fellow-signature": hmac(BODY),
          "x-fellow-timestamp": String(seconds),
        }),
        SECRET,
        signedAt + 3_600_000,
      ),
    ).toThrow(/replay/i);
  });
});

describe("Fellow webhook event parsing", () => {
  it.each([
    ["top level", { event: "meeting.completed", meeting_id: "m1" }],
    ["nested in data", { event_type: "meeting.completed", data: { meeting_id: "m1" } }],
    ["nested in data.meeting", { type: "x", data: { meeting: { meeting_id: "m1" } } }],
    ["nested in meeting", { event: "x", meeting: { meeting_id: "m1" } }],
  ])("finds the meeting id %s", (_label, body) => {
    expect(parseEvent(body).meetingId).toBe("m1");
  });

  it("reports the event type from whichever key carried it", () => {
    expect(parseEvent({ event_type: "transcript.ready", meeting_id: "m1" }).eventType)
      .toBe("transcript.ready");
    expect(parseEvent({ meeting_id: "m1" }).eventType).toBeNull();
  });

  it("rejects an event with no meeting id", () => {
    expect(() => parseEvent({ event: "meeting.completed" })).toThrow(/meeting_id/);
  });
});
