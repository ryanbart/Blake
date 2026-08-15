import Link from "next/link";
import { prisma } from "@/lib/db";
import { ActorBadge, Card, EmptyState, PageHeader, formatDateTime } from "@/components/ui";
import type { Prisma } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

/**
 * The audit view.
 *
 * The filters are the questions people actually arrive with — "what did the AI
 * do?", "what did a person approve?", "what ran with nobody in the loop?" — so
 * they are first-class buttons rather than something to reconstruct by reading
 * rows.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const view = params.view ?? "all";

  const where: Prisma.AuditEventWhereInput =
    view === "ai"
      ? { OR: [{ proposedBy: { kind: "ai_agent" } }, { executedBy: { kind: "ai_agent" } }] }
      : view === "human"
        ? { authorizedBy: { kind: "human" } }
        : view === "autonomous"
          ? {
              // Something executed with no human anywhere in the chain. This is
              // the row a reviewer most needs to be able to find.
              authorizedByActorId: null,
              executedByActorId: { not: null },
              executedBy: { kind: { not: "human" } },
            }
          : {};

  const [events, total, counts] = await Promise.all([
    prisma.auditEvent.findMany({
      where,
      include: { proposedBy: true, authorizedBy: true, executedBy: true, action: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    prisma.auditEvent.count({ where }),
    prisma.auditEvent.groupBy({ by: ["eventType"], _count: { _all: true } }),
  ]);

  const views = [
    { key: "all", label: "Everything" },
    { key: "ai", label: "AI activity" },
    { key: "human", label: "Human approvals" },
    { key: "autonomous", label: "Fully autonomous" },
  ];

  return (
    <>
      <PageHeader
        title="Audit"
        description="Append-only. Enforced by a database trigger, so these rows cannot be edited or deleted."
      />

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {views.map((v) => (
          <Link
            key={v.key}
            href={v.key === "all" ? "/audit" : `/audit?view=${v.key}`}
            className={`rounded-[var(--radius-sm)] px-2.5 py-1 text-xs ${
              view === v.key
                ? "bg-[var(--surface-2)] font-medium"
                : "text-[var(--text-muted)] hover:text-[var(--text)]"
            }`}
          >
            {v.label}
          </Link>
        ))}
        <span className="ml-auto text-xs text-[var(--text-subtle)]">
          {total.toLocaleString()} event{total === 1 ? "" : "s"}
          {total > 100 && " · showing latest 100"}
        </span>
      </div>

      <Card>
        {events.length === 0 ? (
          <EmptyState
            title={
              view === "autonomous"
                ? "Nothing has executed without a human in the loop."
                : "No audit events."
            }
            hint={
              view === "autonomous"
                ? "That is the expected result while the kill switch is engaged."
                : undefined
            }
          />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {events.map((event) => (
              <li key={event.id} className="px-4 py-2.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <code className="text-xs font-medium">{event.eventType}</code>
                  <span className="text-xs text-[var(--text-subtle)]">
                    {formatDateTime(event.createdAt)}
                  </span>
                </div>
                {event.summary && (
                  <p className="mt-0.5 text-sm text-[var(--text-muted)]">{event.summary}</p>
                )}
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {event.proposedBy && (
                    <ActorBadge actor={event.proposedBy} prefix="proposed" />
                  )}
                  {event.authorizedBy && (
                    <ActorBadge actor={event.authorizedBy} prefix="approved" />
                  )}
                  {event.executedBy && (
                    <ActorBadge actor={event.executedBy} prefix="executed" />
                  )}
                  {event.targetType === "Conversation" && event.targetId && (
                    <Link
                      href={`/conversations/${event.targetId}`}
                      className="text-xs text-[var(--accent)] hover:underline"
                    >
                      view conversation
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {counts.length > 0 && (
        <Card className="mt-4">
          <div className="flex flex-wrap gap-x-6 gap-y-1.5 px-4 py-3 text-xs">
            {counts
              .sort((a, b) => b._count._all - a._count._all)
              .map((c) => (
                <span key={c.eventType} className="text-[var(--text-muted)]">
                  <code>{c.eventType}</code>{" "}
                  <span className="tabular font-medium text-[var(--text)]">
                    {c._count._all}
                  </span>
                </span>
              ))}
          </div>
        </Card>
      )}
    </>
  );
}
