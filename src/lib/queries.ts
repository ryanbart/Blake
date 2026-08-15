import { prisma } from "@/lib/db";

/**
 * Read models for the dashboard.
 *
 * Aggregation happens in SQL rather than by loading rows into Node: the
 * conversation table grows without bound, and a dashboard that pulls every row
 * to count them stops working exactly when the product starts succeeding.
 */

export interface DayBucket {
  date: string;
  value: number;
}

/**
 * Customer conversations per day. Gaps are filled with zero so the axis stays
 * continuous.
 *
 * Internal meetings are excluded here and everywhere else on the overview.
 * They are real conversations and worth storing, but this dashboard answers
 * "how much are we talking to customers" — folding standups into that number
 * inflates it with attendance.
 */
export async function volumeByDay(days = 30): Promise<DayBucket[]> {
  const rows = await prisma.$queryRaw<Array<{ day: Date; count: bigint }>>`
    SELECT date_trunc('day', "startedAt") AS day, count(*) AS count
    FROM "Conversation"
    WHERE "startedAt" >= now() - make_interval(days => ${days})
      AND "direction" <> 'internal'
    GROUP BY day ORDER BY day
  `;
  return fillDays(rows.map((r) => ({ day: r.day, value: Number(r.count) })), days);
}

/** Mean coaching score per day, over conversations that have an analysis. */
export async function scoreByDay(days = 30): Promise<DayBucket[]> {
  const rows = await prisma.$queryRaw<Array<{ day: Date; avg: number | null }>>`
    SELECT date_trunc('day', c."startedAt") AS day, avg(a."overallScore") AS avg
    FROM "Analysis" a
    JOIN "Conversation" c ON c.id = a."conversationId"
    WHERE c."startedAt" >= now() - make_interval(days => ${days})
    GROUP BY day ORDER BY day
  `;
  // Unscored days are omitted rather than zero-filled: a day with no analyzed
  // calls has no mean, and plotting 0 would invent a catastrophic score.
  return rows
    .filter((r) => r.avg !== null)
    .map((r) => ({ date: shortDate(r.day), value: Number(r.avg) }));
}

export async function flagsBySeverity(): Promise<
  Array<{ severity: string; count: number }>
> {
  const rows = await prisma.flag.groupBy({
    by: ["severity"],
    _count: { _all: true },
  });
  return rows.map((r) => ({ severity: r.severity, count: r._count._all }));
}

export async function themeVolume(): Promise<Array<{ label: string; count: number }>> {
  const rows = await prisma.$queryRaw<Array<{ label: string; count: bigint }>>`
    SELECT t.label AS label, count(*) AS count
    FROM "ConversationTheme" ct
    JOIN "Theme" t ON t.slug = ct."themeSlug"
    GROUP BY t.label ORDER BY count DESC
  `;
  return rows.map((r) => ({ label: r.label, count: Number(r.count) }));
}

export interface LeaderboardRow {
  agentId: string;
  name: string;
  team: string | null;
  calls: number;
  meanScore: number | null;
  flags: number;
  criticalFlags: number;
  trend: number[];
}

/** Agent leaderboard with a weekly score trend for each rep's sparkline. */
export async function agentLeaderboard(days = 90): Promise<LeaderboardRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      agentId: string;
      name: string;
      team: string | null;
      calls: bigint;
      mean: number | null;
      flags: bigint;
      critical: bigint;
    }>
  >`
    SELECT ag.id AS "agentId", ag.name, ag.team,
           count(DISTINCT c.id) AS calls,
           avg(an."overallScore") AS mean,
           count(f.id) AS flags,
           count(f.id) FILTER (WHERE f.severity = 'critical') AS critical
    FROM "Agent" ag
    LEFT JOIN "Conversation" c
      ON c."agentId" = ag.id
     AND c."startedAt" >= now() - make_interval(days => ${days})
     -- Attending a standup is not a customer conversation; counting it would
     -- rank reps partly on calendar load.
     AND c."direction" <> 'internal'
    LEFT JOIN "Analysis" an ON an."conversationId" = c.id
    LEFT JOIN "Flag" f ON f."conversationId" = c.id
    GROUP BY ag.id, ag.name, ag.team
    HAVING count(DISTINCT c.id) > 0
    ORDER BY mean DESC NULLS LAST
  `;

  const trends = await prisma.$queryRaw<
    Array<{ agentId: string; week: Date; mean: number }>
  >`
    SELECT c."agentId" AS "agentId",
           date_trunc('week', c."startedAt") AS week,
           avg(an."overallScore") AS mean
    FROM "Analysis" an
    JOIN "Conversation" c ON c.id = an."conversationId"
    WHERE c."startedAt" >= now() - make_interval(days => ${days})
      AND c."agentId" IS NOT NULL
    GROUP BY c."agentId", week ORDER BY week
  `;

  const byAgent = new Map<string, number[]>();
  for (const t of trends) {
    const list = byAgent.get(t.agentId) ?? [];
    list.push(Number(t.mean));
    byAgent.set(t.agentId, list);
  }

  return rows.map((r) => ({
    agentId: r.agentId,
    name: r.name,
    team: r.team,
    calls: Number(r.calls),
    meanScore: r.mean === null ? null : Number(r.mean),
    flags: Number(r.flags),
    criticalFlags: Number(r.critical),
    trend: byAgent.get(r.agentId) ?? [],
  }));
}

export async function overviewStats(days = 30) {
  const since = new Date(Date.now() - days * 86_400_000);
  // Internal meetings are never analyzed by design, so counting them in the
  // denominator would peg analysis coverage permanently below 100% and make a
  // healthy pipeline look like a backlog.
  const customerFacing = {
    startedAt: { gte: since },
    direction: { not: "internal" as const },
  };
  const [conversations, analyzed, critical, pendingActions, meanScore, unavailable] =
    await Promise.all([
      prisma.conversation.count({ where: customerFacing }),
      prisma.conversation.count({
        where: { ...customerFacing, analysisStatus: "analyzed" },
      }),
      prisma.flag.count({
        where: { severity: "critical", conversation: { startedAt: { gte: since } } },
      }),
      prisma.action.count({ where: { status: "pending_approval" } }),
      prisma.analysis.aggregate({
        _avg: { overallScore: true },
        where: { conversation: { startedAt: { gte: since } } },
      }),
      prisma.conversation.count({
        where: { ...customerFacing, transcriptStatus: "unavailable" },
      }),
    ]);

  return {
    conversations,
    analyzed,
    critical,
    pendingActions,
    unavailable,
    meanScore: meanScore._avg.overallScore,
  };
}

/** Calls a manager should look at first: highest severity, then lowest score. */
export async function needsReview(limit = 8) {
  return prisma.conversation.findMany({
    where: { flags: { some: { severity: { in: ["high", "critical"] } } } },
    include: {
      agent: true,
      analysis: true,
      flags: { orderBy: { severity: "desc" }, take: 3 },
    },
    orderBy: { startedAt: "desc" },
    take: limit,
  });
}

function shortDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fillDays(
  rows: Array<{ day: Date; value: number }>,
  days: number,
): DayBucket[] {
  const byKey = new Map(rows.map((r) => [r.day.toISOString().slice(0, 10), r.value]));
  const out: DayBucket[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    out.push({ date: shortDate(d), value: byKey.get(key) ?? 0 });
  }
  return out;
}
