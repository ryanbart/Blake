"use client";

import { usePathname } from "next/navigation";
import { NavLink } from "@/components/ui";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/conversations", label: "Conversations" },
  { href: "/agents", label: "Agents" },
  { href: "/themes", label: "Themes" },
  { href: "/rules", label: "Rules" },
  { href: "/audit", label: "Audit" },
];

export function NavShell({ pendingActions }: { pendingActions: number }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-1 items-center gap-1">
      {LINKS.map((link) => (
        <NavLink
          key={link.href}
          href={link.href}
          label={link.label}
          active={
            link.href === "/" ? pathname === "/" : pathname.startsWith(link.href)
          }
        />
      ))}
      <div className="ml-auto">
        {pendingActions > 0 && (
          <span className="rounded-full bg-[var(--accent-subtle)] px-2.5 py-1 text-xs font-medium text-[var(--accent)]">
            {pendingActions} awaiting review
          </span>
        )}
      </div>
    </nav>
  );
}
