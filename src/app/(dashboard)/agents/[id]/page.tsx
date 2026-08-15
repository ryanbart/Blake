import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import {
  Card, CardHeader, EmptyState, ScorePill, SeverityBadge, Stat,
  formatDate,
} from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function AgentDetailPage({
  params,
}: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agent = await prisma.agent.findUnique({ where: { id } });
  if (!agent) notFound();

  const [conversations, opportunities, flagRollup, stats] = await Promise.all([
    prisma.conversation.findMany({
      where: { agentId: id },
      include: { analysis: true, flags: { orderBy: { severity: "desc" }, take: 1 } },
      orderBy: { startedAt: "desc" },
      take: 20,
    }),
    prisma.trainingOpportunity.groupBy({
      by: ["skillSlug"],
      where: { agentId: id },
      _count: { _all: true },
      orderBy: { _count: { skillSlug: "desc" } },
    }),
    prisma.flag.groupBy({
      by: ["title"],
      where: { conversation: { agentId: id } },
      _count: { _all: true },
      orderBy: { _count: { title: "desc" } },
      take: 6,
    }),
    prisma.analysis.aggregate({
      _avg: { overallScore: true },
      _count: { _all: true },
      where: { conversation: { agentId: id } },
    }),
  ]);

  const dimensionAverages = await prisma.$queryRaw<
    Array<{ label: string; mean: number }>
  >`
    SELECT rd.label AS label, avg(si.score) AS mean
    FROM "ScoreItem" si
    JOIN "RubricDimension" rd ON rd.slug = si."dimensionSlug"
    JOIN "Analysis" a ON a.id = si."analysisId"
    JOIN "Conversation" c ON c.id = a."conversationId"
    WHERE c."agentId" = ${id}
    GROUP BY rd.label, rd."sortOrder" ORDER BY rd."sortOrder"
  `;

  const critical = flagRollup.reduce((n, f) => n + f._count._all, 0);

  return (
    <>
      <div className="mb-6">
        <Link href="/agents" className="text-xs text-[var(--text-muted)] hover:underline">
          ← Agents
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">{agent.name}</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          {agent.team ?? "No team"} · {agent.email}
        </p>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Analyzed calls" value={stats._count._all} />
        <Stat
          label="Mean score"
          value={stats._avg.overallScore ? stats._avg.overallScore.toFixed(2) : "—"}
          hint="of 5 · advisory"
        />
        <Stat label="Total flags" value={critical} />
        <Stat label="Training items" value={opportunities.reduce((n, o) => n + o._count._all, 0)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Scorecard by dimension" subtitle="Mean across all analyzed calls" />
          {dimensionAverages.length === 0 ? (
            <EmptyState title="No analyzed calls yet." />
          ) : (
            <div className="space-y-2.5 px-4 py-3">
              {dimensionAverages.map((row) => (
                <div key={row.label}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-[var(--text-muted)]">{row.label}</span>
                    <span className="tabular font-medium">{Number(row.mean).toFixed(1)}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-[var(--surface-2)]">
                    <div
                      className="h-1.5 rounded-full"
                      style={{
                        width: `${(Number(row.mean) / 5) * 100}%`,
                        background:
                          Number(row.mean) >= 4 ? "var(--positive)"
                          : Number(row.mean) >= 2.5 ? "var(--viz-primary)"
                          : "var(--negative)",
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Recurring flags" subtitle="What comes up more than once" />
          {flagRollup.length === 0 ? (
            <EmptyState title="No flags raised on this rep's calls." />
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {flagRollup.map((row) => (
                <li key={row.title} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span>{row.title}</span>
                  <span className="tabular text-[var(--text-muted)]">{row._count._all}×</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader title="Recent conversations" />
        {conversations.length === 0 ? (
          <EmptyState title="No conversations." />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {conversations.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/conversations/${c.id}`}
                  className="flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--surface-2)]"
                >
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {c.title ?? "Untitled"}
                  </span>
                  <span className="shrink-0 text-xs text-[var(--text-muted)]">
                    {formatDate(c.startedAt)}
                  </span>
                  {c.flags[0] && <SeverityBadge severity={c.flags[0].severity} />}
                  <ScorePill score={c.analysis?.overallScore ?? null} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
