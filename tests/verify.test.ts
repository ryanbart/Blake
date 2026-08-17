import { describe, expect, it, vi } from "vitest";
import { redact } from "../scripts/verify";
import { LiveDialpadClient, createDialpadClient } from "@/lib/dialpad/client";

/**
 * These cover the two things that make `npm run verify -- --dialpad` safe to
 * run on a laptop and paste into a chat: output that identifies nobody, and a
 * raw-field dump that reports names without values.
 */
describe("verify --redact", () => {
  it("masks an email but keeps the domain", () => {
    // The domain is the diagnostic half — it says whether the roster looks
    // right — while the local part identifies a person and says nothing.
    expect(redact("renata.alcazar@unitedmh.com")).toBe("r***@unitedmh.com");
  });

  it("masks the name in the Name<email> shape verify prints", () => {
    expect(redact("Renata Alcazar<renata.alcazar@unitedmh.com>")).toBe(
      "R. A.<r***@unitedmh.com>",
    );
  });

  it("masks every entry in a roster line", () => {
    const line =
      "12 users, 12 with an email. Sample: Renata Alcazar<renata@unitedmh.com>, " +
      "Tobias Lindqvist<tobias@unitedmh.com>";
    const out = redact(line);
    expect(out).not.toMatch(/Renata|Alcazar|Tobias|Lindqvist/);
    expect(out).not.toMatch(/renata@|tobias@/);
    expect(out).toContain("R. A.<r***@unitedmh.com>");
    expect(out).toContain("T. L.<t***@unitedmh.com>");
  });

  /**
   * The counterpart to the masking tests, and the more important one: over-
   * redacting would destroy exactly the output this tool exists to produce.
   */
  it("leaves counts, durations, and field names untouched", () => {
    const line =
      "4 calls. Field check on the first row: startedAt=2026-08-15T14:21:00.000Z " +
      "duration=140s direction=outbound agent=unmapped";
    expect(redact(line)).toBe(line);
  });

  it("leaves transcript shape output untouched", () => {
    const line = "available — 42 lines on call 8891. Speaker labels seen: agent, external";
    expect(redact(line)).toBe(line);
  });

  it("does not mangle a bare domain or a URL", () => {
    const line = "https://dialpad.com/api/v2 reachable";
    expect(redact(line)).toBe(line);
  });
});

describe("Dialpad raw-response hook", () => {
  function jsonResponse(body: unknown) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  it("reports the endpoint and parsed body once per request", async () => {
    const onRawResponse = vi.fn();
    const client = new LiveDialpadClient({
      apiKey: "test-key",
      onRawResponse,
      fetchImpl: (async () =>
        jsonResponse({ items: [{ id: "1", email: "a@b.com" }] })) as typeof fetch,
    });

    await client.listUsers();

    expect(onRawResponse).toHaveBeenCalledTimes(1);
    const [endpoint, body] = onRawResponse.mock.calls[0];
    expect(endpoint).toContain("/users");
    expect(body).toEqual({ items: [{ id: "1", email: "a@b.com" }] });
  });

  /** A diagnostic hook must never be able to take down a sync. */
  it("survives a callback that throws", async () => {
    const client = new LiveDialpadClient({
      apiKey: "test-key",
      onRawResponse: () => {
        throw new Error("boom");
      },
      fetchImpl: (async () => jsonResponse({ items: [] })) as typeof fetch,
    });

    await expect(client.listUsers()).resolves.toEqual([]);
  });

  it("is absent unless explicitly requested", () => {
    const client = createDialpadClient({
      ...process.env,
      DIALPAD_TRANSPORT: "live",
      DIALPAD_API_KEY: "test-key",
    });
    // Production paths construct the client without a hook; only verify --dump
    // passes one.
    expect(
      (client as unknown as { opts: { onRawResponse?: unknown } }).opts.onRawResponse,
    ).toBeUndefined();
  });
});
