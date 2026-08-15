"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ReactNode } from "react";

/**
 * Chart primitives.
 *
 * Every chart here plots ONE measure, so each carries a single hue rather than
 * a categorical palette — color is doing no identity work, and cycling hues
 * across bars that all mean "count of conversations" would imply a distinction
 * that does not exist. The only multi-color scale is severity, which is ordered
 * and therefore a one-hue ordinal ramp (see globals.css for the validation).
 */

const AXIS = { fontSize: 11, fill: "var(--viz-ink-muted)" };

function ChartTooltip({
  active,
  payload,
  label,
  formatter,
}: {
  active?: boolean;
  payload?: Array<{ value: number; name: string; payload: Record<string, unknown> }>;
  label?: string | number;
  formatter?: (value: number, row: Record<string, unknown>) => ReactNode;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0];
  return (
    <div className="rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface)] px-2.5 py-1.5 text-xs shadow-sm">
      {label !== undefined && (
        <div className="font-medium text-[var(--text)]">{String(label)}</div>
      )}
      <div className="tabular mt-0.5 text-[var(--text-muted)]">
        {formatter ? formatter(row.value, row.payload) : `${row.value} ${row.name}`}
      </div>
    </div>
  );
}

export interface TimePoint {
  date: string;
  value: number;
}

/** Volume over time. Area rather than bars: continuous time, one measure. */
export function VolumeTrend({ data }: { data: TimePoint[] }) {
  return (
    <div className="h-56 w-full px-2 pb-2 pt-4">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: -18 }}>
          <defs>
            <linearGradient id="volumeFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--viz-primary)" stopOpacity={0.22} />
              <stop offset="100%" stopColor="var(--viz-primary)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid
            stroke="var(--viz-grid)"
            strokeDasharray="0"
            vertical={false}
          />
          <XAxis
            dataKey="date"
            tick={AXIS}
            tickLine={false}
            axisLine={{ stroke: "var(--viz-axis)" }}
            minTickGap={28}
          />
          <YAxis
            tick={AXIS}
            tickLine={false}
            axisLine={false}
            width={44}
            allowDecimals={false}
          />
          <Tooltip
            cursor={{ stroke: "var(--viz-axis)", strokeWidth: 1 }}
            content={
              <ChartTooltip
                formatter={(v) => `${v} conversation${v === 1 ? "" : "s"}`}
              />
            }
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke="var(--viz-primary)"
            strokeWidth={2}
            fill="url(#volumeFill)"
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Mean coaching score over time. Fixed 0-5 domain so the trend is not exaggerated. */
export function ScoreTrend({ data }: { data: TimePoint[] }) {
  return (
    <div className="h-56 w-full px-2 pb-2 pt-4">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: -18 }}>
          <CartesianGrid stroke="var(--viz-grid)" vertical={false} />
          <XAxis
            dataKey="date"
            tick={AXIS}
            tickLine={false}
            axisLine={{ stroke: "var(--viz-axis)" }}
            minTickGap={28}
          />
          <YAxis
            tick={AXIS}
            tickLine={false}
            axisLine={false}
            width={44}
            // Anchored to the rubric's real range: a 3.2-3.6 window auto-scaled
            // would read as a dramatic swing when it is a rounding difference.
            domain={[0, 5]}
            ticks={[0, 1, 2, 3, 4, 5]}
          />
          <Tooltip
            cursor={{ stroke: "var(--viz-axis)", strokeWidth: 1 }}
            content={<ChartTooltip formatter={(v) => `${v.toFixed(2)} / 5 mean score`} />}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke="var(--viz-primary)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

const SEVERITY_ORDER = ["low", "medium", "high", "critical"] as const;
const SEVERITY_RAMP: Record<string, string> = {
  low: "var(--viz-sev-1)",
  medium: "var(--viz-sev-2)",
  high: "var(--viz-sev-3)",
  critical: "var(--viz-sev-4)",
};

/**
 * Flags by severity. Ordered categories with one measure, so the bars carry the
 * ordinal ramp and are always drawn low → critical regardless of magnitude:
 * sorting an ordered scale by size destroys the order it exists to show.
 */
export function SeverityBreakdown({
  data,
}: {
  data: Array<{ severity: string; count: number }>;
}) {
  const ordered = SEVERITY_ORDER.map((severity) => ({
    severity,
    label: severity[0].toUpperCase() + severity.slice(1),
    count: data.find((d) => d.severity === severity)?.count ?? 0,
  }));

  return (
    <div className="h-56 w-full px-2 pb-2 pt-4">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={ordered} margin={{ top: 4, right: 12, bottom: 0, left: -4 }}>
          <CartesianGrid stroke="var(--viz-grid)" vertical={false} />
          <XAxis
            dataKey="label"
            tick={AXIS}
            tickLine={false}
            axisLine={{ stroke: "var(--viz-axis)" }}
          />
          {/* Wide enough for 3-digit counts; a clipped axis label is worse than a wider gutter. */}
          <YAxis tick={AXIS} tickLine={false} axisLine={false} width={52} allowDecimals={false} />
          <Tooltip
            cursor={{ fill: "var(--surface-2)" }}
            content={<ChartTooltip formatter={(v) => `${v} flag${v === 1 ? "" : "s"}`} />}
          />
          <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={56}>
            {ordered.map((row) => (
              <Cell key={row.severity} fill={SEVERITY_RAMP[row.severity]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Theme volume. Horizontal because the labels are words, and single-hue
 * because the measure is the same for every row — hue would encode nothing.
 */
export function ThemeDistribution({
  data,
}: {
  data: Array<{ label: string; count: number }>;
}) {
  const height = Math.max(180, data.length * 32 + 24);
  return (
    <div className="w-full px-2 pb-2 pt-4" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 0, right: 28, bottom: 0, left: 8 }}
        >
          <CartesianGrid stroke="var(--viz-grid)" horizontal={false} />
          <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
          <YAxis
            type="category"
            dataKey="label"
            tick={{ ...AXIS, fill: "var(--viz-ink)" }}
            tickLine={false}
            axisLine={{ stroke: "var(--viz-axis)" }}
            width={152}
          />
          <Tooltip
            cursor={{ fill: "var(--surface-2)" }}
            content={
              <ChartTooltip formatter={(v) => `${v} conversation${v === 1 ? "" : "s"}`} />
            }
          />
          <Bar
            dataKey="count"
            fill="var(--viz-primary)"
            radius={[0, 4, 4, 0]}
            maxBarSize={18}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Inline trend for a table row. No axes — it reads as shape, not as values. */
export function Sparkline({
  data,
  width = 88,
  height = 24,
}: {
  data: number[];
  width?: number;
  height?: number;
}) {
  if (data.length < 2) {
    return <span className="text-xs text-[var(--text-subtle)]">—</span>;
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const step = width / (data.length - 1);
  const points = data
    .map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / span) * height).toFixed(1)}`)
    .join(" ");

  const trend = data[data.length - 1] - data[0];
  const stroke =
    trend > 0.15
      ? "var(--positive)"
      : trend < -0.15
        ? "var(--negative)"
        : "var(--viz-ink-muted)";

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Trend from ${data[0].toFixed(1)} to ${data[data.length - 1].toFixed(1)}`}
      className="overflow-visible"
    >
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
