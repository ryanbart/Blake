import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { resetDb, disconnect } from "./helpers/db";
import { POST } from "@/app/api/dialpad/webhook/route";
import { signCallEvent } from "@/lib/dialpad/webhook";

const SECRET = "route-test-secret";

function post(body: string): Request {
  return new Request("http://localhost/api/dialpad/webhook", {
    method: "POST",
    body,
  });
}

beforeEach(async () => {
  await resetDb();
  process.env.DIALPAD_WEBHOOK_SECRET = SECRET;
  process.env.DIALPAD_TRANSPORT = "mock";
  await prisma.agent.create({
    data: { name: "Dana Whitfield", email: "dana@example.com", dialpadUserId: "5001" },
  });
});

afterAll(disconnect);

const event = {
  call_id: "dp_1001",
  state: "hangup",
  direction: "outbound",
  duration: 412,
  date_started: "1755172800",
  target: { id: "5001", name: "Dana Whitfield" },
  contact: { name: "Peter De Haan", phone: "+15025550142" },
};

describe("POST /api/dialpad/webhook", () => {
  it("ingests a correctly signed call event", async () => {
    const res = await POST(post(await signCallEvent(event, SECRET)));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.created).toBe(true);

    const stored = await prisma.conversation.findUniqueOrThrow({
      where: { id: body.conversationId },
      include: { segments: true },
    });
    expect(stored.sourceId).toBe("dp_1001");
    // The mock has a transcript for dp_1001, so it should have landed too.
    expect(stored.segments.length).toBeGreaterThan(0);
  });

  it("rejects a payload signed with the wrong secret and writes nothing", async () => {
    const res = await POST(post(await signCallEvent(event, "wrong-secret")));
    expect(res.status).toBe(401);
    expect(await prisma.conversation.count()).toBe(0);
  });

  it("does not reveal why verification failed", async () => {
    const res = await POST(post("garbage"));
    const body = await res.json();
    // A probing client should not learn whether it got the secret or the shape
    // wrong; the specifics go to our logs instead.
    expect(body.error).toBe("Invalid signature");
    expect(JSON.stringify(body)).not.toMatch(/secret|jwt|payload/i);
  });

  it("ignores non-terminal call states", async () => {
    const res = await POST(
      post(await signCallEvent({ ...event, state: "ringing" }, SECRET)),
    );
    const body = await res.json();
    // A ringing event has no duration, recording, or transcript to ingest.
    expect(body.ignored).toBe("ringing");
    expect(await prisma.conversation.count()).toBe(0);
  });

  it("is idempotent across duplicate deliveries", async () => {
    const token = await signCallEvent(event, SECRET);
    const first = await (await POST(post(token))).json();
    const second = await (await POST(post(token))).json();

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.conversationId).toBe(first.conversationId);
    expect(await prisma.conversation.count()).toBe(1);
  });

  it("marks transcripts unavailable when the provider has none", async () => {
    // dp_1003 is the no-answer call; the mock 404s it like the live API does.
    const res = await POST(
      post(await signCallEvent({ ...event, call_id: "dp_1003", duration: 27 }, SECRET)),
    );
    const body = await res.json();
    const stored = await prisma.conversation.findUniqueOrThrow({
      where: { id: body.conversationId },
    });
    expect(stored.transcriptStatus).toBe("unavailable");
    expect(stored.analysisStatus).toBe("skipped");
  });
});
