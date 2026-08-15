import Link from "next/link";
import type { ReactNode } from "react";

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] ${className}`}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-4 py-3">
      <div>
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {subtitle && (
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">{subtitle}</p>
        )}
      </div>
      {action}
    </div>
  );
}

/**
 * A single headline number. Per the form heuristic, one value with no
 * comparison is a stat tile rather than a one-bar chart.
 */
export function Stat({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "neutral" | "positive" | "negative";
}) {
  const color =
    tone === "positive"
      ? "text-[var(--positive)]"
      : tone === "negative"
        ? "text-[var(--negative)]"
        : "text-[var(--text)]";
  return (
    <Card className="px-4 py-3">
      <div className="text-xs font-medium text-[var(--text-muted)]">{label}</div>
      <div className={`tabular mt-1 text-2xl font-semibold tracking-tight ${color}`}>
        {value}
      </div>
      {hint && <div className="mt-0.5 text-xs text-[var(--text-subtle)]">{hint}</div>}
    </Card>
  );
}

const SEVERITY_STYLE: Record<string, { fg: string; bg: string; label: string }> = {
  low: { fg: "var(--sev-low)", bg: "var(--sev-low-bg)", label: "Low" },
  medium: { fg: "var(--sev-med)", bg: "var(--sev-med-bg)", label: "Medium" },
  high: { fg: "var(--sev-high)", bg: "var(--sev-high-bg)", label: "High" },
  critical: {
    fg: "var(--sev-critical)",
    bg: "var(--sev-critical-bg)",
    label: "Critical",
  },
};

/** Severity always ships with its label — the color never carries meaning alone. */
export function SeverityBadge({ severity }: { severity: string }) {
  const style = SEVERITY_STYLE[severity] ?? SEVERITY_STYLE.low;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ color: style.fg, background: style.bg }}
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: style.fg }}
      />
      {style.label}
    </span>
  );
}

export type ActorLike = {
  kind: string;
  displayName: string;
  model?: string | null;
  promptVersion?: string | null;
};

/**
 * Who produced this.
 *
 * Attribution is shown wherever a finding appears rather than being confined to
 * the audit log — a score whose origin you have to go looking for is a score
 * people quietly assume a human wrote.
 */
export function ActorBadge({
  actor,
  prefix,
}: {
  actor: ActorLike;
  prefix?: string;
}) {
  const style =
    actor.kind === "human"
      ? { fg: "var(--actor-human)", bg: "var(--actor-human-bg)", icon: "◆" }
      : actor.kind === "ai_agent"
        ? { fg: "var(--actor-ai)", bg: "var(--actor-ai-bg)", icon: "✦" }
        : { fg: "var(--actor-system)", bg: "var(--actor-system-bg)", icon: "▚" };

  const detail =
    actor.kind === "ai_agent" && actor.model
      ? `${actor.model}${actor.promptVersion ? ` · ${actor.promptVersion}` : ""}`
      : actor.kind === "system"
        ? "deterministic — not model output"
        : actor.displayName;

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] px-1.5 py-0.5 text-xs"
      style={{ color: style.fg, background: style.bg }}
      title={detail}
    >
      <span aria-hidden>{style.icon}</span>
      <span className="font-medium">
        {prefix ? `${prefix} ` : ""}
        {actor.displayName}
      </span>
    </span>
  );
}

export function ScorePill({ score }: { score: number | null }) {
  if (score === null) {
    return <span className="text-xs text-[var(--text-subtle)]">—</span>;
  }
  const tone =
    score >= 4 ? "var(--positive)" : score >= 2.5 ? "var(--text)" : "var(--negative)";
  return (
    <span className="tabular text-sm font-semibold" style={{ color: tone }}>
      {score.toFixed(1)}
    </span>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="text-sm text-[var(--text-muted)]">{title}</p>
      {hint && <p className="mt-1 text-xs text-[var(--text-subtle)]">{hint}</p>}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-[var(--text-muted)]">{description}</p>
        )}
      </div>
      {children}
    </div>
  );
}

export function NavLink({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded-[var(--radius-sm)] px-2.5 py-1.5 text-sm transition-colors ${
        active
          ? "bg-[var(--surface-2)] font-medium text-[var(--text)]"
          : "text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
      }`}
    >
      {label}
    </Link>
  );
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatDateTime(date: Date): string {
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
