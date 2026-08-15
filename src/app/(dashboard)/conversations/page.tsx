import Link from "next/link";
import { prisma } from "@/lib/db";
import {
  Card,
  EmptyState,
  PageHeader,
  ScorePill,
  SeverityBadge,
  formatDateTime,
  formatDuration,
} from "@/components/ui";
import type { Prisma, Severity } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

const SEVERITY_RANK: Severity[] = ["low", "medium", "high", "critical"];

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const severity = params.severity;
  const source = params.source;
  const agentId = params.agent;
  const status = params.status;

  const where: Prisma.ConversationWhereInput = {
    ...(severity && SEVERITY_RANK.includes(severity as Severity)
      ? { flags: { some: { severity: severity as Severity } } }
      : {}),
    ...(source === "dialpad" || source === "fellow" ? { source } : {}),
    ...(agentId ? { agentId } : {}),
    ...(status === "unanalyzed"
      ? { analysisStatus: { in: ["pending", "skipped", "failed"] } }
      : status === "no-transcript"
        ? { transcriptStatus: "unavailable" }
        : {}),
  };

  const [conversations, total, agents] = await Promise.all([
    prisma.conversation.findMany({
      where,
      include: {
        agent: true,
        analysis: true,
        flags: { orderBy: { severity: "desc" } },
        themes: { include: { theme: true } },
      },
      orderBy: { startedAt: "desc" },
      take: 100,
    }),
    prisma.conversation.count({ where }),
    prisma.agent.findMany({ orderBy: { name: "asc" } }),
  ]);

  const filters = [
    { key: "severity", label: "Severity", options: SEVERITY_RANK, current: severity },
    { key: "source", label: "Source", options: ["dialpad", "fellow"], current: source },
    {
      key: "status",
      label: "Status",
      options: ["unanalyzed", "no-transcript"],
      current: status,
    },
  ];

  function hrefWith(key: string, value?: string) {
    const next = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v) as [string, string][],
    );
    if (value) next.set(key, value);
    else next.delete(key);
    const qs = next.toString();
    return `/conversations${qs ? `?${qs}` : ""}`;
  }

  return (
    <>
      <PageHeader
        title="Conversations"
        description={`${total.toLocaleString()} matching · showing the most recent ${Math.min(total, 100)}`}
      />

      {/* Filters in one row above the table, per the interaction spec. */}
      <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5">
        {filters.map((filter) => (
          <div key={filter.key} className="flex items-center gap-1.5">
            <span className="text-xs font-medium text-[var(--text-muted)]">
              {filter.label}
            </span>
            <Link
              href={hrefWith(filter.key, undefined)}
              className={`rounded-[var(--radius-sm)] px-1.5 py-0.5 text-xs ${
                !filter.current
                  ? "bg-[var(--surface-2)] font-medium"
                  : "text-[var(--text-muted)] hover:text-[var(--text)]"
              }`}
            >
              All
            </Link>
            {filter.options.map((option) => (
              <Link
                key={option}
                href={hrefWith(filter.key, option)}
                className={`rounded-[var(--radius-sm)] px-1.5 py-0.5 text-xs capitalize ${
                  filter.current === option
                    ? "bg-[var(--surface-2)] font-medium"
                    : "text-[var(--text-muted)] hover:text-[var(--text)]"
                }`}
              >
                {option.replace("-", " ")}
              </Link>
            ))}
          </div>
        ))}
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-[var(--text-muted)]">Rep</span>
          <Link
            href={hrefWith("agent", undefined)}
            className={`rounded-[var(--radius-sm)] px-1.5 py-0.5 text-xs ${
              !agentId ? "bg-[var(--surface-2)] font-medium" : "text-[var(--text-muted)]"
            }`}
          >
            All
          </Link>
          {agents.slice(0, 6).map((agent) => (
            <Link
              key={agent.id}
              href={hrefWith("agent", agent.id)}
              className={`rounded-[var(--radius-sm)] px-1.5 py-0.5 text-xs ${
                agentId === agent.id
                  ? "bg-[var(--surface-2)] font-medium"
                  : "text-[var(--text-muted)] hover:text-[var(--text)]"
              }`}
            >
              {agent.name.split(" ")[0]}
            </Link>
          ))}
        </div>
      </div>

      <Card>
        {conversations.length === 0 ? (
          <EmptyState
            title="No conversations match these filters."
            hint="Clear a filter, or run `npm run sync` to pull more."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--text-muted)]">
                  <th className="px-4 py-2.5 font-medium">Conversation</th>
                  <th className="px-2 py-2.5 font-medium">Rep</th>
                  <th className="px-2 py-2.5 font-medium">When</th>
                  <th className="px-2 py-2.5 text-right font-medium">Length</th>
                  <th className="px-2 py-2.5 text-right font-medium">Score</th>
                  <th className="px-4 py-2.5 font-medium">Flags</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {conversations.map((conversation) => {
                  const worst = conversation.flags[0];
                  return (
                    <tr key={conversation.id} className="hover:bg-[var(--surface-2)]">
                      <td className="max-w-[320px] px-4 py-2.5">
                        <Link
                          href={`/conversations/${conversation.id}`}
                          className="block truncate font-medium hover:underline"
                        >
                          {conversation.title ?? "Untitled conversation"}
                        </Link>
                        <div className="mt-0.5 flex flex-wrap gap-1.5">
                          {conversation.themes.slice(0, 3).map((t) => (
                            <span
                              key={t.id}
                              className="text-xs text-[var(--text-subtle)]"
                            >
                              {t.theme.label}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-2 py-2.5 text-[var(--text-muted)]">
                        {conversation.agent?.name ?? "—"}
                      </td>
                      <td className="px-2 py-2.5 text-xs text-[var(--text-muted)]">
                        {formatDateTime(conversation.startedAt)}
                      </td>
                      <td className="tabular px-2 py-2.5 text-right text-xs text-[var(--text-muted)]">
                        {formatDuration(conversation.durationSec)}
                      </td>
                      <td className="px-2 py-2.5 text-right">
                        {conversation.transcriptStatus === "unavailable" ? (
                          <span
                            className="text-xs text-[var(--text-subtle)]"
                            title="No transcript, so this call could not be analyzed"
                          >
                            no transcript
                          </span>
                        ) : (
                          <ScorePill score={conversation.analysis?.overallScore ?? null} />
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {worst ? (
                          <div className="flex items-center gap-2">
                            <SeverityBadge severity={worst.severity} />
                            {conversation.flags.length > 1 && (
                              <span className="text-xs text-[var(--text-subtle)]">
                                +{conversation.flags.length - 1}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-[var(--text-subtle)]">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
