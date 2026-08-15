import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import {
  ActorBadge,
  Card,
  CardHeader,
  EmptyState,
  ScorePill,
  SeverityBadge,
  formatDateTime,
  formatDuration,
} from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function ConversationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const conversation = await prisma.conversation.findUnique({
    where: { id },
    include: {
      agent: true,
      participants: true,
      segments: { orderBy: { startMs: "asc" } },
      analysis: {
        include: {
          producedBy: true,
          scores: { include: { dimension: true } },
        },
      },
      flags: { include: { producedBy: true }, orderBy: { severity: "desc" } },
      themes: { include: { theme: true } },
      trainingOpportunities: true,
      actions: { include: { proposedBy: true } },
    },
  });

  if (!conversation) notFound();

  // Highlight the lines a flag was raised on, so evidence is visible in place
  // rather than only quoted in a side panel.
  const flaggedSegments = new Map(
    conversation.flags
      .filter((f) => f.segmentId)
      .map((f) => [f.segmentId as string, f]),
  );

  /**
   * Collapse duplicate findings.
   *
   * The rules engine and the analyzer independently flag the same moment, so an
   * un-deduped list shows "10 findings" on a nine-line call and a manager stops
   * reading it. Same severity on the same quote is one problem found twice, not
   * two problems -- so it collapses to one entry listing both producers, which
   * is also the more useful signal: two independent detectors agreeing.
   */
  const findings = Object.values(
    conversation.flags.reduce<
      Record<
        string,
        {
          key: string;
          title: string;
          severity: string;
          detail: string | null;
          quote: string | null;
          producers: typeof conversation.flags[number]["producedBy"][];
        }
      >
    >((acc, flag) => {
      const key = `${flag.severity}|${(flag.quote ?? flag.title).toLowerCase()}`;
      const existing = acc[key];
      if (existing) {
        if (!existing.producers.some((p) => p.id === flag.producedBy.id)) {
          existing.producers.push(flag.producedBy);
        }
        return acc;
      }
      acc[key] = {
        key,
        title: flag.title,
        severity: flag.severity,
        detail: flag.detail,
        quote: flag.quote,
        producers: [flag.producedBy],
      };
      return acc;
    }, {}),
  );

  const scores = [...conversation.analysis?.scores ?? []].sort(
    (a, b) => a.dimension.sortOrder - b.dimension.sortOrder,
  );

  return (
    <>
      <div className="mb-6">
        <Link
          href="/conversations"
          className="text-xs text-[var(--text-muted)] hover:underline"
        >
          ← Conversations
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">
          {conversation.title ?? "Untitled conversation"}
        </h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          {conversation.agent?.name ?? "Unassigned"} ·{" "}
          {formatDateTime(conversation.startedAt)} ·{" "}
          {formatDuration(conversation.durationSec)} · {conversation.direction} ·{" "}
          <span className="capitalize">{conversation.source}</span>
          {conversation.recordingUrl && (
            <>
              {" · "}
              <a
                href={conversation.recordingUrl}
                className="text-[var(--accent)] hover:underline"
              >
                Recording
              </a>
            </>
          )}
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          <Card>
            <CardHeader
              title="Transcript"
              subtitle={
                conversation.segments.length > 0
                  ? `${conversation.segments.length} lines · flagged lines are highlighted`
                  : undefined
              }
            />
            {conversation.segments.length === 0 ? (
              <EmptyState
                title="No transcript for this conversation."
                hint={
                  conversation.transcriptStatus === "unavailable"
                    ? "The provider had no transcript — usually a very short call, or Dialpad Ai not enabled."
                    : "The transcript has not arrived yet. The nightly sync will retry."
                }
              />
            ) : (
              <ol className="divide-y divide-[var(--border)]">
                {conversation.segments.map((segment) => {
                  const flag = flaggedSegments.get(segment.id);
                  return (
                    <li
                      key={segment.id}
                      className="px-4 py-2.5"
                      style={
                        flag
                          ? {
                              background: `var(--sev-${flag.severity === "medium" ? "med" : flag.severity}-bg)`,
                              boxShadow: `inset 3px 0 0 var(--sev-${flag.severity === "medium" ? "med" : flag.severity})`,
                            }
                          : undefined
                      }
                    >
                      <div className="flex items-baseline gap-2">
                        <span className="tabular w-10 shrink-0 text-xs text-[var(--text-subtle)]">
                          {formatOffset(segment.startMs)}
                        </span>
                        <span
                          className={`shrink-0 text-xs font-medium ${
                            segment.speakerRole === "agent"
                              ? "text-[var(--accent)]"
                              : "text-[var(--text-muted)]"
                          }`}
                        >
                          {segment.speakerRole === "agent"
                            ? "Rep"
                            : segment.speakerRole === "customer"
                              ? "Customer"
                              : "Unknown"}
                        </span>
                      </div>
                      <p className="mt-0.5 pl-12 text-sm">{segment.text}</p>
                      {flag && (
                        <p className="mt-1.5 pl-12 text-xs font-medium">
                          <SeverityBadge severity={flag.severity} />{" "}
                          <span className="ml-1 text-[var(--text-muted)]">
                            {flag.title}
                          </span>
                        </p>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          {conversation.analysis ? (
            <Card>
              <CardHeader
                title="Coaching scorecard"
                subtitle="Advisory — review the call before acting"
                action={<ScorePill score={conversation.analysis.overallScore} />}
              />
              <div className="space-y-2 px-4 py-3">
                <div className="mb-2">
                  <ActorBadge
                    actor={conversation.analysis.producedBy}
                    prefix="Produced by"
                  />
                </div>
                <p className="text-sm text-[var(--text-muted)]">
                  {conversation.analysis.summary}
                </p>
                <div className="mt-3 space-y-1.5">
                  {scores.map((score) => (
                    <div key={score.id} className="text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[var(--text-muted)]">
                          {score.dimension.label}
                        </span>
                        <span className="tabular font-medium">
                          {score.score.toFixed(1)}
                        </span>
                      </div>
                      {/* Bar doubles as the value's own label, so the number is
                          never the only way to read the score. */}
                      <div className="mt-1 h-1 rounded-full bg-[var(--surface-2)]">
                        <div
                          className="h-1 rounded-full"
                          style={{
                            width: `${(score.score / 5) * 100}%`,
                            background:
                              score.score >= 4
                                ? "var(--positive)"
                                : score.score >= 2.5
                                  ? "var(--viz-primary)"
                                  : "var(--negative)",
                          }}
                        />
                      </div>
                      {score.rationale && (
                        <p className="mt-0.5 text-xs text-[var(--text-subtle)]">
                          {score.rationale}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          ) : (
            <Card>
              <CardHeader title="Coaching scorecard" />
              {/* An internal meeting has no scorecard by design, not by backlog.
                  Saying "not analyzed yet" would read as a queue to work off. */}
              {conversation.direction === "internal" ? (
                <EmptyState
                  title="Internal meeting — not scored."
                  hint="No external attendee, so a sales rubric would produce numbers that mean nothing. The transcript is kept as conversation history."
                />
              ) : conversation.transcriptStatus === "unavailable" ? (
                <EmptyState
                  title="No transcript available."
                  hint="Coaching analysis needs a transcript. The recording link above, if present, is all this conversation carries."
                />
              ) : (
                <EmptyState title="Not analyzed yet." hint="Run `npm run analyze`." />
              )}
            </Card>
          )}

          <Card>
            <CardHeader
              title="Flags"
              subtitle={`${findings.length} finding${findings.length === 1 ? "" : "s"}`}
            />
            {findings.length === 0 ? (
              <EmptyState title="Nothing flagged on this conversation." />
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {findings.map((finding) => (
                  <li key={finding.key} className="px-4 py-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm font-medium">{finding.title}</span>
                      <SeverityBadge severity={finding.severity} />
                    </div>
                    {finding.detail && (
                      <p className="mt-1 text-xs text-[var(--text-muted)]">
                        {finding.detail}
                      </p>
                    )}
                    {finding.quote && (
                      <blockquote className="mt-1.5 border-l-2 border-[var(--border-strong)] pl-2 text-xs italic text-[var(--text-muted)]">
                        “{finding.quote}”
                      </blockquote>
                    )}
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {finding.producers.map((producer) => (
                        <ActorBadge key={producer.id} actor={producer} />
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {conversation.trainingOpportunities.length > 0 && (
            <Card>
              <CardHeader title="Training opportunities" />
              <ul className="divide-y divide-[var(--border)]">
                {conversation.trainingOpportunities.map((opp) => (
                  <li key={opp.id} className="px-4 py-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm font-medium capitalize">
                        {opp.skillSlug.replace(/_/g, " ")}
                      </span>
                      <SeverityBadge severity={opp.priority} />
                    </div>
                    <p className="mt-1 text-xs text-[var(--text-muted)]">
                      {opp.suggestion}
                    </p>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {conversation.themes.length > 0 && (
            <Card>
              <CardHeader title="Themes" />
              <ul className="divide-y divide-[var(--border)]">
                {conversation.themes.map((theme) => (
                  <li key={theme.id} className="px-4 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm">{theme.theme.label}</span>
                      <span className="text-xs capitalize text-[var(--text-muted)]">
                        {theme.sentiment}
                      </span>
                    </div>
                    {theme.quote && (
                      <p className="mt-0.5 text-xs italic text-[var(--text-subtle)]">
                        “{theme.quote}”
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card>
            <CardHeader
              title="CRM suggestions"
              subtitle="Nothing is written to Salesforce without approval"
            />
            {conversation.actions.length === 0 ? (
              <EmptyState
                title="No CRM suggestions yet."
                hint="Salesforce extraction arrives in Phase 3."
              />
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {conversation.actions.map((action) => (
                  <li key={action.id} className="px-4 py-2.5 text-sm">
                    <div className="font-medium">{action.actionType}</div>
                    <div className="mt-1">
                      <ActorBadge actor={action.proposedBy} prefix="Proposed by" />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function formatOffset(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
