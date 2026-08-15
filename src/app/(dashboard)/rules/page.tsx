import { prisma } from "@/lib/db";
import { Card, CardHeader, EmptyState, PageHeader, SeverityBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function RulesPage() {
  const rules = await prisma.rule.findMany({
    orderBy: [{ severity: "desc" }, { name: "asc" }],
    include: { _count: { select: { flags: true } } },
  });

  return (
    <>
      <PageHeader
        title="Rules"
        description="Deterministic checks that run on every conversation, with or without an API key."
      />

      <Card>
        <CardHeader
          title="Active rules"
          subtitle="These run before the model, so compliance flagging never depends on model availability"
        />
        {rules.length === 0 ? (
          <EmptyState title="No rules configured." hint="Run `npm run seed`." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--text-muted)]">
                  <th className="px-4 py-2.5 font-medium">Rule</th>
                  <th className="px-2 py-2.5 font-medium">Applies to</th>
                  <th className="px-2 py-2.5 font-medium">Category</th>
                  <th className="px-2 py-2.5 font-medium">Severity</th>
                  <th className="px-4 py-2.5 text-right font-medium">Times fired</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {rules.map((rule) => (
                  <tr key={rule.id} className="hover:bg-[var(--surface-2)]">
                    <td className="max-w-[420px] px-4 py-2.5">
                      <div className="font-medium">{rule.name}</div>
                      {rule.description && (
                        <div className="mt-0.5 text-xs text-[var(--text-muted)]">
                          {rule.description}
                        </div>
                      )}
                      <code className="mt-1 block truncate text-xs text-[var(--text-subtle)]">
                        {rule.pattern}
                      </code>
                    </td>
                    <td className="px-2 py-2.5 capitalize text-[var(--text-muted)]">
                      {rule.appliesTo}
                    </td>
                    <td className="px-2 py-2.5 capitalize text-[var(--text-muted)]">
                      {rule.category}
                    </td>
                    <td className="px-2 py-2.5">
                      <SeverityBadge severity={rule.severity} />
                    </td>
                    <td className="tabular px-4 py-2.5 text-right">
                      {rule._count.flags}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="mt-4 text-xs text-[var(--text-subtle)]">
        Editing rules from this screen, with a preview against recent conversations,
        is not built yet — patterns are seeded from code today.
      </p>
    </>
  );
}
