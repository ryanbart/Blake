import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { resetDb, disconnect } from "./helpers/db";
import {
  MockFellowClient,
  TranscriptUnavailableError,
} from "@/lib/fellow/client";
import {
  matchSpeakerToParticipant,
  parseRenderedTranscript,
  toMeeting,
  toParticipant,
  type FellowParticipant,
} from "@/lib/fellow/types";
import { normalizeMeeting, upsertMeeting } from "@/lib/fellow/normalize";
import { getIntegrationActor, INTEGRATION_ACTORS } from "@/lib/provenance/actors";
import { SpeakerRole } from "@/generated/prisma/client";

const client = new MockFellowClient();

const RYAN: FellowParticipant = {
  email: "ryan@unitedmh.com",
  name: "Ryan Bartlett",
  isExternal: false,
  isOrganizer: true,
};
// Externals invited by address arrive with an email and no display name.
const PETER: FellowParticipant = {
  email: "Peter.dehaan@apex-cos.com".toLowerCase(),
  name: null,
  isExternal: true,
  isOrganizer: false,
};

describe("participant mapping", () => {
  it("defaults an unlabelled participant to internal", () => {
    // Mislabelling a colleague as a customer would feed internal conversation
    // into CRM suggestions, which is the worse error.
    const p = toParticipant({ email: "someone@unitedmh.com" });
    expect(p.isExternal).toBe(false);
  });

  it("lowercases emails so matching is case-insensitive", () => {
    expect(toParticipant({ email: "Peter.DeHaan@Apex-Cos.com" }).email).toBe(
      "peter.dehaan@apex-cos.com",
    );
  });
});

describe("speaker to participant matching", () => {
  it("matches on display name", () => {
    expect(matchSpeakerToParticipant("Ryan Bartlett", [RYAN, PETER])).toBe(RYAN);
  });

  it("matches a named speaker to a participant that has only an email", () => {
    // The join the live data actually requires: transcript has "Peter Dehaan",
    // the participant record has no name at all.
    expect(matchSpeakerToParticipant("Peter Dehaan", [RYAN, PETER])).toBe(PETER);
  });

  it("is insensitive to case and to punctuation in the email local part", () => {
    expect(matchSpeakerToParticipant("PETER DEHAAN", [RYAN, PETER])).toBe(PETER);
    // Fellow renders "Peter Dehaan"; a human might write "Peter de Haan".
    expect(matchSpeakerToParticipant("peter de haan", [RYAN, PETER])).toBe(PETER);
  });

  it("falls back to a unique first name", () => {
    expect(matchSpeakerToParticipant("Ryan", [RYAN, PETER])).toBe(RYAN);
  });

  it("refuses a bare first name shared by two participants", () => {
    const otherRyan: FellowParticipant = {
      email: "ryan.chen@apex-cos.com",
      name: "Ryan Chen",
      isExternal: true,
      isOrganizer: false,
    };
    // RYAN's email local part is exactly "ryan", so an exact-match strategy
    // would happily resolve this -- and be guessing. One Ryan is internal and
    // the other is the customer, so the losing side of that coin flip
    // attributes a customer's words to a rep.
    expect(matchSpeakerToParticipant("Ryan", [RYAN, otherRyan])).toBeNull();
    // A full name is still unambiguous.
    expect(matchSpeakerToParticipant("Ryan Chen", [RYAN, otherRyan])).toBe(otherRyan);
  });

  it("returns null for an unknown speaker", () => {
    expect(matchSpeakerToParticipant("Unknown Person", [RYAN, PETER])).toBeNull();
    expect(matchSpeakerToParticipant(null, [RYAN, PETER])).toBeNull();
  });
});

describe("rendered transcript parsing", () => {
  it("parses timestamps, speakers, and text", () => {
    const lines = parseRenderedTranscript(
      "[00:00:12] Ryan Bartlett: Hey Peter.\n[00:01:05] Peter Dehaan: Hello.",
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      speakerName: "Ryan Bartlett",
      startMs: 12_000,
      text: "Hey Peter.",
    });
    expect(lines[1].startMs).toBe(65_000);
  });

  it("accepts MM:SS as well as HH:MM:SS", () => {
    const lines = parseRenderedTranscript("[04:18] Peter Dehaan: Hey Ryan.");
    expect(lines[0].startMs).toBe(258_000);
  });

  it("appends a wrapped continuation line to the previous turn", () => {
    // A wrapped sentence is not a new turn; dropping it would lose content.
    const lines = parseRenderedTranscript(
      "[00:01:22] Peter Dehaan: We lost most of a shift,\n  and that is why we are shopping.",
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toContain("why we are shopping");
  });

  it("ignores XML wrappers and blank lines", () => {
    const lines = parseRenderedTranscript(
      '<meeting_transcript note_id="1">\n\n[00:00:01] Ryan Bartlett: Hi.\n</meeting_transcript>',
    );
    expect(lines).toHaveLength(1);
  });

  it("does not treat a colon inside speech as a speaker delimiter", () => {
    const lines = parseRenderedTranscript(
      "[00:00:10] Ryan Bartlett: Here is the deal: we ship Thursday.",
    );
    expect(lines[0].speakerName).toBe("Ryan Bartlett");
    expect(lines[0].text).toBe("Here is the deal: we ship Thursday.");
  });
});

describe("meeting normalization", () => {
  it("assigns sides from participant externality, not from the transcript", async () => {
    const meetings = await client.listMeetings();
    const apex = meetings.find((m) => m.meetingId === "fw_apex_0814")!;
    const transcript = await client.getTranscript("fw_apex_0814");
    const result = normalizeMeeting(apex, transcript);

    expect(result.isCustomerFacing).toBe(true);
    expect(result.unmatchedSpeakerRatio).toBe(0);

    const roles = new Set(result.segments.map((s) => s.speakerRole));
    expect(roles).toEqual(new Set([SpeakerRole.agent, SpeakerRole.customer]));

    const customerLines = result.segments.filter(
      (s) => s.speakerRole === SpeakerRole.customer,
    );
    expect(customerLines[0].text).toContain("cold storage aisles");
  });

  it("marks an all-internal meeting as not customer facing", async () => {
    const meetings = await client.listMeetings();
    const standup = meetings.find((m) => m.meetingId === "fw_standup_0813")!;
    const transcript = await client.getTranscript("fw_standup_0813");
    const result = normalizeMeeting(standup, transcript);

    expect(result.isCustomerFacing).toBe(false);
    // Everyone internal means every line is our side.
    expect(
      result.segments.every((s) => s.speakerRole === SpeakerRole.agent),
    ).toBe(true);
  });

  it("leaves an unmatched speaker unknown rather than guessing a side", () => {
    const result = normalizeMeeting(
      {
        meetingId: "m1",
        title: null,
        startedAt: new Date(),
        durationSec: 600,
        noteId: null,
        recordingId: null,
        notes: null,
        summary: null,
        externalUrl: null,
        recordingUrl: null,
        participants: [RYAN, PETER],
      },
      [{ speakerName: "Someone Else", startMs: 0, text: "Hello." }],
    );
    expect(result.segments[0].speakerRole).toBe(SpeakerRole.unknown);
    expect(result.unmatchedSpeakerRatio).toBe(1);
  });
});

describe("mock transport", () => {
  it("reads meetings with participants resolved", async () => {
    const meetings = await client.listMeetings();
    expect(meetings).toHaveLength(3);
    const apex = meetings.find((m) => m.meetingId === "fw_apex_0814")!;
    expect(apex.participants).toHaveLength(2);
    expect(apex.summary).toContain("uptime");
    expect(apex.durationSec).toBe(1800);
  });

  it("raises TranscriptUnavailable for an unrecorded meeting", async () => {
    // A scheduled slot nobody joined; the live API 404s the same way.
    await expect(client.getTranscript("fw_noshow_0812")).rejects.toBeInstanceOf(
      TranscriptUnavailableError,
    );
  });

  it("returns Fellow's own action items", async () => {
    const items = await client.getActionItems("fw_apex_0814");
    expect(items).toHaveLength(2);
    expect(items[0].dueDate).toBe("2026-08-20");
  });

  it("returns no action items rather than failing when there are none", async () => {
    expect(await client.getActionItems("fw_standup_0813")).toEqual([]);
  });

  it("computes duration from the calendar window", () => {
    const meeting = toMeeting({
      meeting_id: "x",
      start_time: "2026-08-14T14:30:00-04:00",
      end_time: "2026-08-14T15:15:00-04:00",
    });
    expect(meeting.durationSec).toBe(2700);
  });
});

describe("meeting ingest", () => {
  beforeEach(async () => {
    await resetDb();
    await prisma.agent.create({
      data: { name: "Ryan Bartlett", email: "ryan@unitedmh.com" },
    });
  });
  afterAll(disconnect);

  async function actorId() {
    return (await getIntegrationActor(INTEGRATION_ACTORS.fellowBackfill)).id;
  }

  async function ingest(meetingId: string) {
    const meetings = await client.listMeetings();
    const meeting = meetings.find((m) => m.meetingId === meetingId)!;
    const transcript = await client.getTranscript(meetingId).catch(() => null);
    return upsertMeeting({
      meeting,
      transcript,
      transcriptUnavailable: transcript === null,
      actorId: await actorId(),
    });
  }

  it("stores a customer meeting as analyzable and links the rep", async () => {
    const result = await ingest("fw_apex_0814");
    expect(result.created).toBe(true);
    expect(result.isCustomerFacing).toBe(true);

    const stored = await prisma.conversation.findUniqueOrThrow({
      where: { id: result.conversationId },
      include: { agent: true, participants: true, segments: true },
    });
    expect(stored.source).toBe("fellow");
    expect(stored.analysisStatus).toBe("pending");
    expect(stored.agent?.name).toBe("Ryan Bartlett");
    expect(stored.participants.filter((p) => p.isExternal)).toHaveLength(1);
    expect(stored.segments.length).toBeGreaterThan(5);
    // Fellow's own summary is stored as context, not as our analysis.
    expect(stored.providerSummary).toContain("uptime");
    // Ingest never scores; the meeting is queued for analysis, not analyzed.
    expect(
      await prisma.analysis.count({ where: { conversationId: stored.id } }),
    ).toBe(0);
  });

  it("stores an internal meeting but never queues it for scoring", async () => {
    const result = await ingest("fw_standup_0813");
    expect(result.skippedInternal).toBe(true);

    const stored = await prisma.conversation.findUniqueOrThrow({
      where: { id: result.conversationId },
    });
    // A standup run through a sales rubric produces meaningless numbers that
    // drag down a rep's average.
    expect(stored.analysisStatus).toBe("skipped");
    expect(stored.direction).toBe("internal");
  });

  it("marks an unrecorded meeting unavailable rather than pending", async () => {
    const result = await ingest("fw_noshow_0812");
    const stored = await prisma.conversation.findUniqueOrThrow({
      where: { id: result.conversationId },
    });
    expect(stored.transcriptStatus).toBe("unavailable");
    expect(
      await prisma.transcriptSegment.count({
        where: { conversationId: stored.id },
      }),
    ).toBe(0);
  });

  it("is idempotent across replays", async () => {
    const first = await ingest("fw_apex_0814");
    const second = await ingest("fw_apex_0814");

    expect(second.created).toBe(false);
    expect(second.conversationId).toBe(first.conversationId);
    expect(await prisma.conversation.count()).toBe(1);

    const segments = await prisma.transcriptSegment.count();
    const again = await ingest("fw_apex_0814");
    expect(again.transcriptWritten).toBe(false);
    expect(await prisma.transcriptSegment.count()).toBe(segments);
  });

  it("does not collide with a Dialpad call carrying the same source id", async () => {
    const meetings = await client.listMeetings();
    const meeting = meetings.find((m) => m.meetingId === "fw_apex_0814")!;
    await upsertMeeting({
      meeting,
      transcript: null,
      actorId: await actorId(),
    });
    await prisma.conversation.create({
      data: {
        source: "dialpad",
        sourceId: "fw_apex_0814",
        startedAt: new Date(),
      },
    });
    expect(await prisma.conversation.count()).toBe(2);
  });

  it("attributes ingest to a Fellow integration actor with an audit row", async () => {
    const result = await ingest("fw_apex_0814");
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { targetId: result.conversationId },
      include: { executedBy: true },
    });
    expect(event.executedBy?.integration).toBe(INTEGRATION_ACTORS.fellowBackfill);
  });
});
