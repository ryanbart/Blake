import { describe, expect, it } from "vitest";
import { parseCsv, parseCsvRecords } from "@/lib/dialpad/csv";
import {
  MockDialpadClient,
  TranscriptUnavailableError,
} from "@/lib/dialpad/client";
import {
  signCallEvent,
  verifyCallEvent,
  WebhookVerificationError,
} from "@/lib/dialpad/webhook";
import {
  callEventToCall,
  parseTimestamp,
  toCall,
  toTranscript,
  toUser,
} from "@/lib/dialpad/types";

const SECRET = "test-webhook-secret";

describe("CSV parsing", () => {
  it("keeps commas inside quoted fields", () => {
    const rows = parseCsv('a,b,c\n1,"two, still two",3\n');
    expect(rows[1]).toEqual(["1", "two, still two", "3"]);
  });

  it("handles escaped quotes", () => {
    const rows = parseCsv('note\n"he said ""this is unacceptable"" twice"\n');
    expect(rows[1][0]).toBe('he said "this is unacceptable" twice');
  });

  it("handles newlines inside quoted fields", () => {
    // Rep-typed disposition notes routinely contain hard newlines.
    const rows = parseCsv('id,note\n1,"line one\nline two"\n');
    expect(rows).toHaveLength(2);
    expect(rows[1][1]).toBe("line one\nline two");
  });

  it("handles CRLF line endings and a BOM", () => {
    const rows = parseCsv('﻿a,b\r\n1,2\r\n');
    expect(rows[0]).toEqual(["a", "b"]);
    expect(rows[1]).toEqual(["1", "2"]);
  });

  it("pads short rows instead of dropping them", () => {
    // A rep who left the trailing notes column empty should still yield a call.
    const records = parseCsvRecords("call_id,disposition,notes\ndp_9,Connected\n");
    expect(records).toHaveLength(1);
    expect(records[0].call_id).toBe("dp_9");
    expect(records[0].notes).toBe("");
  });

  it("parses a final row with no trailing newline", () => {
    const records = parseCsvRecords("a,b\n1,2");
    expect(records).toEqual([{ a: "1", b: "2" }]);
  });
});

describe("timestamp parsing", () => {
  it("accepts epoch seconds, epoch milliseconds, and ISO strings", () => {
    expect(parseTimestamp("1755172800").toISOString()).toBe(
      "2025-08-14T12:00:00.000Z",
    );
    expect(parseTimestamp("1755172800000").toISOString()).toBe(
      "2025-08-14T12:00:00.000Z",
    );
    expect(parseTimestamp("2025-08-14T12:00:00Z").toISOString()).toBe(
      "2025-08-14T12:00:00.000Z",
    );
  });

  it("never throws on junk", () => {
    expect(parseTimestamp(undefined).getTime()).toBe(0);
    expect(parseTimestamp("not a date").getTime()).toBe(0);
  });
});

describe("record normalization", () => {
  it("builds a display name from first and last when display_name is absent", () => {
    const user = toUser({ id: "1", first_name: "Marcus", last_name: "Oyelaran" });
    expect(user.name).toBe("Marcus Oyelaran");
  });

  it("treats a duration over 24h as milliseconds", () => {
    // The export reports seconds on some plans and milliseconds on others.
    const asMs = toCall({ call_id: "x", duration: "412000" });
    expect(asMs.durationSec).toBe(412);

    const asSec = toCall({ call_id: "x", duration: "412" });
    expect(asSec.durationSec).toBe(412);
  });

  it("defaults an unrecognized direction to outbound", () => {
    expect(toCall({ call_id: "x", direction: "" }).direction).toBe("outbound");
    expect(toCall({ call_id: "x", direction: "Inbound" }).direction).toBe("inbound");
  });

  it("drops non-speech lines and rebases timestamps to call start", () => {
    const lines = toTranscript({
      lines: [
        { type: "callevent", content: "Call started", time: 1000 },
        { type: "transcript", content: "Hello", time: 3000, name: "Dana" },
        { type: "transcript", content: "   ", time: 4000 },
        { type: "transcript", content: "Hi", time: 9000, name: "Peter" },
      ],
    });
    expect(lines).toHaveLength(2);
    // Offsets are relative to the first *speech* line, not the call event.
    expect(lines[0].startMs).toBe(0);
    expect(lines[1].startMs).toBe(6000);
  });

  it("prefers an explicit recording url over the admin share link", () => {
    const call = callEventToCall({
      call_id: "1",
      recording_url: "https://a",
      admin_call_recording_share_link: "https://b",
    });
    expect(call.recordingUrl).toBe("https://a");
  });
});

describe("mock transport", () => {
  const client = new MockDialpadClient();

  it("lists users from fixtures, including a suspended one", async () => {
    const users = await client.listUsers();
    expect(users).toHaveLength(3);
    expect(users.find((u) => u.name === "Marcus Oyelaran")?.email).toBe(
      "marcus.oyelaran@unitedmh.example",
    );
    expect(users.find((u) => u.name === "Priya Raghunathan")?.active).toBe(false);
  });

  it("parses the calls export including quoted notes", async () => {
    const calls = await client.listCalls();
    expect(calls).toHaveLength(4);

    const complaint = calls.find((c) => c.sourceId === "dp_1002");
    expect(complaint?.dispositionNotes).toContain('"this is unacceptable"');
    expect(complaint?.direction).toBe("inbound");
  });

  it("returns transcript lines for a call that has one", async () => {
    const lines = await client.getTranscript("dp_1001");
    expect(lines.length).toBeGreaterThan(5);
    expect(lines[0].speakerLabel).toBe("agent");
  });

  it("raises TranscriptUnavailable for a call with no transcript", async () => {
    // dp_1003 is a 27-second no-answer; the live API 404s the same way.
    await expect(client.getTranscript("dp_1003")).rejects.toBeInstanceOf(
      TranscriptUnavailableError,
    );
  });
});

describe("webhook signature verification", () => {
  const event = {
    call_id: "dp_2001",
    state: "hangup",
    direction: "outbound",
    duration: 300,
  };

  it("accepts a correctly signed payload", async () => {
    const token = await signCallEvent(event, SECRET);
    const verified = await verifyCallEvent(token, SECRET);
    expect(verified.call_id).toBe("dp_2001");
  });

  it("rejects a payload signed with the wrong secret", async () => {
    const token = await signCallEvent(event, "attacker-secret");
    await expect(verifyCallEvent(token, SECRET)).rejects.toBeInstanceOf(
      WebhookVerificationError,
    );
  });

  it("rejects a tampered payload", async () => {
    const token = await signCallEvent(event, SECRET);
    const [header, , signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...event, call_id: "dp_9999" }),
    ).toString("base64url");
    await expect(
      verifyCallEvent(`${header}.${forged}.${signature}`, SECRET),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it("rejects an expired token", async () => {
    const token = await signCallEvent(event, SECRET, { expiresIn: "-10m" });
    await expect(verifyCallEvent(token, SECRET)).rejects.toThrow(/verification failed/i);
  });

  it("refuses to verify when no secret is configured", async () => {
    const token = await signCallEvent(event, SECRET);
    // An unverifiable payload is indistinguishable from an attacker's.
    await expect(verifyCallEvent(token, "")).rejects.toThrow(/not set/i);
  });

  it("rejects a non-JWT body", async () => {
    await expect(verifyCallEvent("not-a-jwt", SECRET)).rejects.toThrow(/not a JWT/i);
  });

  it("rejects an alg:none token even with a valid structure", async () => {
    // The classic JWT downgrade: unsigned token claiming no algorithm.
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
      "base64url",
    );
    const body = Buffer.from(JSON.stringify(event)).toString("base64url");
    await expect(verifyCallEvent(`${header}.${body}.`, SECRET)).rejects.toBeInstanceOf(
      WebhookVerificationError,
    );
  });

  it("rejects a valid signature carrying a non-call-event payload", async () => {
    const token = await signCallEvent({ hello: "world" }, SECRET);
    await expect(verifyCallEvent(token, SECRET)).rejects.toThrow(
      /not a call event/i,
    );
  });
});
