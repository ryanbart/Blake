import Link from "next/link";
import { prisma } from "@/lib/db";
import { NavShell } from "@/components/nav-shell";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pendingActions = await prisma.action.count({
    where: { status: "pending_approval" },
  });

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--surface)]/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center gap-4 px-6 py-3">
          <Link href="/" className="flex items-center gap-2">
            <span
              aria-hidden
              className="grid h-6 w-6 place-items-center rounded-[var(--radius-sm)] bg-[var(--accent)] text-xs font-bold text-[var(--accent-fg)]"
            >
              B
            </span>
            <span className="text-sm font-semibold tracking-tight">Blake</span>
          </Link>
          <NavShell pendingActions={pendingActions} />
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] px-6 py-8">{children}</main>
    </div>
  );
}
