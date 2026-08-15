import Link from "next/link";
import {
  SeverityBreakdown,
  ScoreTrend,
  Sparkline,
  ThemeDistribution,
  VolumeTrend,
} from "@/components/charts";
import {
  Card,
  CardHeader,
  EmptyState,
  PageHeader,
  ScorePill,
  SeverityBadge,
  Stat,
  formatDate,
} from "@/components/ui";
import {
  agentLeaderboard,
  flagsBySeverity,
  needsReview,
  overviewStats,
  scoreByDay,
  themeVolume,
  volumeByDay,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const [stats, volume, scores, severity, themes, leaderboard, review] =
    await Promise.all([
      overviewStats(30),
      volumeByDay(30),
      scoreByDay(30),
      flagsBySeverity(),
      themeVolume(),
      agentLeaderboard(90),
      needsReview(6),
    ]);

  const hasData = stats.conversations > 0;

  return (
    <>
      <PageHeader
        title="Overview"
        description="Last 30 days across Dialpad calls and Fellow meetings."
      />

      {!hasData ? (
        <Card>
          <EmptyState
            title="No conversations yet."
            hint="Run `npm run seed` for sample data, or `npm run sync` to pull from Dialpad."
          />
        </Card>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Stat label="Conversations" value={stats.conversations} hint="last 30 days" />
            <Stat
              label="Mean score"
              value={stats.meanScore ? stats.meanScore.toFixed(2) : "—"}
              hint="of 5 · advisory"
              tone={
                stats.meanScore === null
                  ? "neutral"
                  : stats.meanScore >= 3.5
                    ? "positive"
                    : stats.meanScore < 2.5
                      ? "negative"
                      : "neutral"
              }
            />
            <Stat
              label="Critical flags"
              value={stats.critical}
              hint="need a manager"
              tone={stats.critical > 0 ? "negative" : "positive"}
            />
            <Stat label="Awaiting review" value={stats.pendingActions} hint="CRM suggestions" />
            <Stat
              label="No transcript"
              value={stats.unavailable}
              hint="not analyzable"
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader
                title="Conversation volume"
                subtitle="Calls and meetings per day"
              />
              <VolumeTrend data={volume} />
            </Card>
            <Card>
              <CardHeader
                title="Mean coaching score"
                subtitle="Daily average across analyzed conversations, 0–5"
              />
              {scores.length > 1 ? (
                <ScoreTrend data={scores} />
              ) : (
                <EmptyState
                  title="Not enough analyzed conversations yet."
                  hint="Run `npm run analyze`."
                />
              )}
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader title="Flags by severity" subtitle="All time" />
              <SeverityBreakdown data={severity} />
            </Card>
            <Card className="lg:col-span-2">
              <CardHeader
                title="What customers are talking about"
                subtitle="Conversations mentioning each theme"
              />
              {themes.length > 0 ? (
                <ThemeDistribution data={themes} />
              ) : (
                <EmptyState title="No themes detected yet." />
              )}
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader
                title="Needs review"
                subtitle="Conversations carrying a high or critical flag"
                action={
                  <Link
                    href="/conversations?severity=critical"
                    className="text-xs text-[var(--accent)] hover:underline"
                  >
                    View all
                  </Link>
                }
              />
              {review.length === 0 ? (
                <EmptyState title="Nothing flagged for review." />
              ) : (
                <ul className="divide-y divide-[var(--border)]">
                  {review.map((conversation) => (
                    <li key={conversation.id}>
                      <Link
                        href={`/conversations/${conversation.id}`}
                        className="flex items-start gap-3 px-4 py-3 hover:bg-[var(--surface-2)]"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">
                            {conversation.title ?? "Untitled conversation"}
                          </div>
                          <div className="mt-0.5 text-xs text-[var(--text-muted)]">
                            {conversation.agent?.name ?? "Unassigned"} ·{" "}
                            {formatDate(conversation.startedAt)}
                          </div>
                          <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-1">
                            {/* The same rule can fire on several lines of one
                                call; listing the title twice reads as two
                                different problems. */}
                            {[...new Set(conversation.flags.map((f) => f.title))]
                              .slice(0, 2)
                              .map((title) => (
                                <span
                                  key={title}
                                  className="text-xs text-[var(--text-muted)]"
                                >
                                  {title}
                                </span>
                              ))}
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-1.5">
                          <SeverityBadge severity={conversation.flags[0].severity} />
                          <ScorePill score={conversation.analysis?.overallScore ?? null} />
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card>
              <CardHeader
                title="Agents"
                subtitle="Mean score over 90 days · trend is weekly"
                action={
                  <Link
                    href="/agents"
                    className="text-xs text-[var(--accent)] hover:underline"
                  >
                    View all
                  </Link>
                }
              />
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--text-muted)]">
                      <th className="px-4 py-2 font-medium">Rep</th>
                      <th className="px-2 py-2 text-right font-medium">Calls</th>
                      <th className="px-2 py-2 text-right font-medium">Score</th>
                      <th className="px-2 py-2 font-medium">Trend</th>
                      <th className="px-4 py-2 text-right font-medium">Critical</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {leaderboard.slice(0, 7).map((row) => (
                      <tr key={row.agentId} className="hover:bg-[var(--surface-2)]">
                        <td className="px-4 py-2">
                          <Link
                            href={`/agents/${row.agentId}`}
                            className="hover:underline"
                          >
                            {row.name}
                          </Link>
                          {row.team && (
                            <div className="text-xs text-[var(--text-subtle)]">
                              {row.team}
                            </div>
                          )}
                        </td>
                        <td className="tabular px-2 py-2 text-right text-[var(--text-muted)]">
                          {row.calls}
                        </td>
                        <td className="px-2 py-2 text-right">
                          <ScorePill score={row.meanScore} />
                        </td>
                        <td className="px-2 py-2">
                          <Sparkline data={row.trend} />
                        </td>
                        <td className="tabular px-4 py-2 text-right">
                          {row.criticalFlags > 0 ? (
                            <span className="text-[var(--negative)]">
                              {row.criticalFlags}
                            </span>
                          ) : (
                            <span className="text-[var(--text-subtle)]">0</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>

          <p className="text-xs text-[var(--text-subtle)]">
            Coaching scores are advisory and generated from transcripts. Review the
            conversation before acting on one, and do not use them for performance
            decisions without human review.
          </p>
        </div>
      )}
    </>
  );
}
