import Link from "next/link";
import { prisma } from "@/lib/db";
import { ThemeDistribution } from "@/components/charts";
import { Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import { themeVolume } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function ThemesPage() {
  const [volume, themes] = await Promise.all([
    themeVolume(),
    prisma.theme.findMany({
      where: { enabled: true },
      orderBy: { sortOrder: "asc" },
      include: {
        conversations: {
          include: { conversation: { include: { agent: true } } },
          orderBy: { confidence: "desc" },
          take: 3,
        },
        _count: { select: { conversations: true } },
      },
    }),
  ]);

  const sentimentCounts = await prisma.conversationTheme.groupBy({
    by: ["themeSlug", "sentiment"],
    _count: { _all: true },
  });

  return (
    <>
      <PageHeader
        title="Themes"
        description="What customers raised, drawn from a fixed taxonomy so the trend lines stay comparable."
      />

      <Card className="mb-4">
        <CardHeader title="Volume by theme" subtitle="Conversations mentioning each" />
        {volume.length > 0 ? (
          <ThemeDistribution data={volume} />
        ) : (
          <EmptyState title="No themes detected yet." hint="Run `npm run analyze`." />
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {themes.map((theme) => {
          const sentiments = sentimentCounts.filter((s) => s.themeSlug === theme.slug);
          const negative = sentiments.find((s) => s.sentiment === "negative")?._count._all ?? 0;
          return (
            <Card key={theme.slug}>
              <CardHeader
                title={theme.label}
                subtitle={theme.description}
                action={
                  <span className="tabular shrink-0 text-sm font-semibold">
                    {theme._count.conversations}
                  </span>
                }
              />
              <div className="px-4 py-3">
                {negative > 0 && (
                  <p className="mb-2 text-xs text-[var(--negative)]">
                    {negative} conversation{negative === 1 ? "" : "s"} where the customer
                    was negative on this
                  </p>
                )}
                {theme.conversations.length === 0 ? (
                  <p className="text-xs text-[var(--text-subtle)]">
                    Not mentioned in any analyzed conversation yet.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {theme.conversations.map((link) => (
                      <li key={link.id} className="text-xs">
                        {link.quote && (
                          <blockquote className="border-l-2 border-[var(--border-strong)] pl-2 italic text-[var(--text-muted)]">
                            “{link.quote}”
                          </blockquote>
                        )}
                        <Link
                          href={`/conversations/${link.conversationId}`}
                          className="mt-0.5 inline-block text-[var(--accent)] hover:underline"
                        >
                          {link.conversation.agent?.name ?? "Unassigned"} ·{" "}
                          {link.conversation.title ?? "Untitled"}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}
