import Link from "next/link";
import { Sparkline } from "@/components/charts";
import { Card, EmptyState, PageHeader, ScorePill } from "@/components/ui";
import { agentLeaderboard } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const rows = await agentLeaderboard(90);

  return (
    <>
      <PageHeader
        title="Agents"
        description="Mean coaching score over the last 90 days. Scores are advisory."
      />
      <Card>
        {rows.length === 0 ? (
          <EmptyState title="No agents with conversations yet." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--text-muted)]">
                  <th className="px-4 py-2.5 font-medium">Rep</th>
                  <th className="px-2 py-2.5 font-medium">Team</th>
                  <th className="px-2 py-2.5 text-right font-medium">Calls</th>
                  <th className="px-2 py-2.5 text-right font-medium">Mean score</th>
                  <th className="px-2 py-2.5 font-medium">Weekly trend</th>
                  <th className="px-2 py-2.5 text-right font-medium">Flags</th>
                  <th className="px-4 py-2.5 text-right font-medium">Critical</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {rows.map((row) => (
                  <tr key={row.agentId} className="hover:bg-[var(--surface-2)]">
                    <td className="px-4 py-2.5 font-medium">
                      <Link href={`/agents/${row.agentId}`} className="hover:underline">
                        {row.name}
                      </Link>
                    </td>
                    <td className="px-2 py-2.5 text-[var(--text-muted)]">
                      {row.team ?? "—"}
                    </td>
                    <td className="tabular px-2 py-2.5 text-right text-[var(--text-muted)]">
                      {row.calls}
                    </td>
                    <td className="px-2 py-2.5 text-right">
                      <ScorePill score={row.meanScore} />
                    </td>
                    <td className="px-2 py-2.5">
                      <Sparkline data={row.trend} />
                    </td>
                    <td className="tabular px-2 py-2.5 text-right text-[var(--text-muted)]">
                      {row.flags}
                    </td>
                    <td className="tabular px-4 py-2.5 text-right">
                      {row.criticalFlags > 0 ? (
                        <span className="font-medium text-[var(--negative)]">
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
        )}
      </Card>
      <p className="mt-4 text-xs text-[var(--text-subtle)]">
        These scores come from automated transcript analysis and are intended for
        coaching conversations, not performance decisions. Read the underlying calls
        before drawing a conclusion about a rep.
      </p>
    </>
  );
}
