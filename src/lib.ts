import * as fs from "node:fs";

import Table from "cli-table3";
import { markdownTable } from "markdown-table";
import picomatch from "picomatch";
import prettyBytes from "pretty-bytes";

import type { Budget, Metric } from "./config.js";
import { parseRawStats, parseSnapshot, readJsonFile } from "./stats.js";

export const FORMATS = ["markdown", "terminal"] as const;
export type Format = (typeof FORMATS)[number];

export const MIN_DISPLAY = 250;

export type RouteStats = {
  bytes: number;
  chunks: number;
  compressedBytes: number | null;
};
export type Sizes = Map<string, RouteStats>;

export type LoadedSizes = {
  compressed: boolean;
  sizes: Sizes;
};

const routeMatcher = (exclude: string[]): ((route: string) => boolean) =>
  picomatch(exclude, { dot: true });

export const isExcluded = (route: string, exclude: string[]): boolean =>
  routeMatcher(exclude)(route);

export type Row = {
  route: string;
  current: RouteStats | null;
  baseline: RouteStats | null;
  delta: number;
  deltaPercent: number | null;
  chunkDelta: number;
  exceeded: boolean;
};

export const loadSizes = (filePath: string, exclude: string[]): LoadedSizes => {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Input file not found: ${filePath}. Expected a "measure" snapshot or a route-bundle-stats.json (a Turbopack production build on Next.js >= 16.2 writes one).`,
    );
  }

  const data = readJsonFile(filePath);
  const excluded = routeMatcher(exclude);
  const sizes: Sizes = new Map();

  if (Array.isArray(data)) {
    for (const entry of parseRawStats(data, filePath)) {
      if (excluded(entry.route)) {
        continue;
      }

      sizes.set(entry.route, {
        bytes: entry.firstLoadUncompressedJsBytes,
        chunks: entry.firstLoadChunkPaths?.length ?? 0,
        compressedBytes: null,
      });
    }

    return { compressed: false, sizes };
  }

  if (typeof data !== "object" || data === null || !("schemaVersion" in data)) {
    throw new Error(
      `Unrecognized input ${filePath}: expected a route-bundle-stats.json array or a route-bundle-size snapshot with "schemaVersion".`,
    );
  }

  for (const entry of parseSnapshot(data, filePath).routes) {
    if (excluded(entry.route)) {
      continue;
    }

    sizes.set(entry.route, {
      bytes: entry.rawBytes,
      chunks: entry.chunkPaths.length,
      compressedBytes: entry.compressedBytes,
    });
  }

  return { compressed: true, sizes };
};

export const hasCompressedData = (loaded: LoadedSizes): boolean =>
  loaded.compressed;

export const assertComparable = (
  current: LoadedSizes,
  baseline: LoadedSizes,
  metric: Metric,
): void => {
  if (metric !== "compressed") {
    return;
  }

  const uncompressed = [
    hasCompressedData(current) ? null : "current",
    hasCompressedData(baseline) ? null : "baseline",
  ].filter((side): side is string => side !== null);

  if (uncompressed.length > 0) {
    throw new Error(
      `Budget metric is "compressed" but ${uncompressed.join(" and ")} ${uncompressed.length > 1 ? "have" : "has"} no compressed data. Produce snapshots with the "measure" command, or set "budget.metric" to "raw" in the config.`,
    );
  }
};

const metricBytes = (stats: RouteStats, metric: Metric): number =>
  metric === "compressed" ? (stats.compressedBytes ?? 0) : stats.bytes;

export const buildRows = (
  current: Sizes,
  baseline: Sizes,
  budget: Budget,
): { rows: Row[]; anyExceeded: boolean } => {
  const allRoutes = new Set([...current.keys(), ...baseline.keys()]);
  const rows: Row[] = [];

  let anyExceeded = false;

  for (const route of allRoutes) {
    const cur = current.get(route) ?? null;
    const base = baseline.get(route) ?? null;

    const currentBytes = cur === null ? 0 : metricBytes(cur, budget.metric);
    const baselineBytes = base === null ? 0 : metricBytes(base, budget.metric);

    const delta = currentBytes - baselineBytes;
    const deltaPercent =
      base !== null && baselineBytes > 0 ? (delta / baselineBytes) * 100 : null;
    const chunkDelta = (cur?.chunks ?? 0) - (base?.chunks ?? 0);
    // New routes (no baseline) never exceeded — a fresh page legitimately ships
    // its full size as "delta", which would otherwise always trip the abs rule.
    const exceeded =
      base !== null &&
      delta > 0 &&
      (delta >= budget.maxIncrease ||
        (deltaPercent !== null && deltaPercent >= budget.maxIncreasePercent));

    if (exceeded) {
      anyExceeded = true;
    }

    rows.push({
      route,
      current: cur,
      baseline: base,
      delta,
      deltaPercent,
      chunkDelta,
      exceeded,
    });
  }

  rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return { rows, anyExceeded };
};

export type Summary = {
  // Total unique routes across both snapshots (current ∪ baseline). New routes
  // and removed routes both count once.
  totalRoutes: number;
  routesCurrent: number;
  routesBaseline: number;
  totalCurrent: number;
  totalBaseline: number;
  totalDelta: number;
  totalDeltaPercent: number | null;
  avgCurrent: number;
  avgBaseline: number;
  chunksCurrent: number;
  chunksBaseline: number;
};

export const buildSummary = (rows: Row[], metric: Metric): Summary => {
  let totalCurrent = 0;
  let totalBaseline = 0;
  let chunksCurrent = 0;
  let chunksBaseline = 0;
  let routesCurrent = 0;
  let routesBaseline = 0;

  for (const row of rows) {
    if (row.current !== null) {
      totalCurrent += metricBytes(row.current, metric);
      chunksCurrent += row.current.chunks;
      routesCurrent += 1;
    }
    if (row.baseline !== null) {
      totalBaseline += metricBytes(row.baseline, metric);
      chunksBaseline += row.baseline.chunks;
      routesBaseline += 1;
    }
  }

  const totalDelta = totalCurrent - totalBaseline;
  const totalDeltaPercent =
    totalBaseline > 0 ? (totalDelta / totalBaseline) * 100 : null;

  return {
    totalRoutes: rows.length,
    routesCurrent,
    routesBaseline,
    totalCurrent,
    totalBaseline,
    totalDelta,
    totalDeltaPercent,
    avgCurrent: routesCurrent > 0 ? totalCurrent / routesCurrent : 0,
    avgBaseline: routesBaseline > 0 ? totalBaseline / routesBaseline : 0,
    chunksCurrent,
    chunksBaseline,
  };
};

export const isNotableShrink = (row: Row, budget: Budget): boolean =>
  row.delta < 0 &&
  (row.delta <= -budget.maxIncrease ||
    (row.deltaPercent !== null &&
      row.deltaPercent <= -budget.maxIncreasePercent));

export const formatDelta = (row: Row, budget: Budget): string => {
  // Sub-threshold deltas (incl. zero) are visual noise — show as "no change".
  if (Math.abs(row.delta) < MIN_DISPLAY) {
    return "—";
  }

  const sign = row.delta > 0 ? "+" : "";
  const marker = row.exceeded
    ? " 🔴"
    : isNotableShrink(row, budget)
      ? " 🟢"
      : "";

  // Removed: the size column already says "(removed)"; -100% is noise.
  if (row.current === null) {
    return `${sign}${prettyBytes(row.delta)}${marker}`;
  }

  const percentLabel =
    row.deltaPercent === null
      ? "new"
      : `${sign}${row.deltaPercent.toFixed(1)}%`;
  return `${sign}${prettyBytes(row.delta)} (${percentLabel})${marker}`;
};

export const formatSignedBytes = (bytes: number): string => {
  if (bytes === 0) return "—";
  const sign = bytes > 0 ? "+" : "";
  return `${sign}${prettyBytes(bytes)}`;
};

export const formatPercent = (pct: number | null): string => {
  if (pct === null) return "—";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
};

export const formatSignedInt = (n: number): string => {
  if (n === 0) return "—";
  return n > 0 ? `+${n}` : `${n}`;
};

const budgetLegendSuffix = (budget: Budget): string =>
  budget.metric === "compressed" ? " compressed" : "";

export const renderMarkdown = (
  rows: Row[],
  summary: Summary,
  budget: Budget,
): string => {
  if (rows.length === 0) {
    return "## 📦 Bundle size\n\nNo client routes detected.";
  }

  const table = markdownTable([
    ["Route", "First Load JS", "Δ"],
    ...rows.map((r) => [
      `\`${r.route}\``,
      r.current === null
        ? "— (removed)"
        : prettyBytes(metricBytes(r.current, budget.metric)),
      formatDelta(r, budget),
    ]),
  ]);

  const summaryLines = [
    "",
    "### Summary",
    "",
    `- **Routes:** ${summary.totalRoutes}`,
    `- **Total:** ${prettyBytes(summary.totalBaseline)} → ${prettyBytes(summary.totalCurrent)} (${formatSignedBytes(summary.totalDelta)}, ${formatPercent(summary.totalDeltaPercent)})`,
    `- **Avg per route:** ${prettyBytes(summary.avgBaseline)} → ${prettyBytes(summary.avgCurrent)}`,
    `- **Chunks:** ${summary.chunksBaseline} → ${summary.chunksCurrent} (${formatSignedInt(summary.chunksCurrent - summary.chunksBaseline)})`,
  ];

  return [
    "## 📦 Bundle size",
    "",
    table,
    ...summaryLines,
    "",
    `🔴 exceeds \`+${prettyBytes(budget.maxIncrease)}\` OR \`+${budget.maxIncreasePercent}%\`${budgetLegendSuffix(budget)} · 🟢 notable improvement (≥${prettyBytes(budget.maxIncrease)} OR ≥${budget.maxIncreasePercent}% smaller)`,
  ].join("\n");
};

export const renderTerminal = (
  rows: Row[],
  summary: Summary,
  budget: Budget,
): string => {
  if (rows.length === 0) {
    return "📦 Bundle size: no client routes detected.";
  }

  const table = new Table({
    head: ["Route", "Baseline", "Current", "Δ bytes", "Δ chunks"],
    colAligns: ["left", "right", "right", "right", "right"],
    style: { head: [], border: [] },
  });

  for (const row of rows) {
    table.push([
      row.route,
      row.baseline === null
        ? "(new)"
        : prettyBytes(metricBytes(row.baseline, budget.metric)),
      row.current === null
        ? "(removed)"
        : prettyBytes(metricBytes(row.current, budget.metric)),
      formatDelta(row, budget),
      row.chunkDelta === 0
        ? "—"
        : `${row.chunkDelta > 0 ? "+" : ""}${row.chunkDelta}`,
    ]);
  }

  table.push([
    { content: "TOTAL", hAlign: "left" },
    prettyBytes(summary.totalBaseline),
    prettyBytes(summary.totalCurrent),
    `${formatSignedBytes(summary.totalDelta)} (${formatPercent(summary.totalDeltaPercent)})`,
    formatSignedInt(summary.chunksCurrent - summary.chunksBaseline),
  ]);
  table.push([
    { content: "avg per route", hAlign: "left" },
    prettyBytes(summary.avgBaseline),
    prettyBytes(summary.avgCurrent),
    "",
    "",
  ]);

  return [
    table.toString(),
    `🔴 exceeds +${prettyBytes(budget.maxIncrease)} OR +${budget.maxIncreasePercent}%${budgetLegendSuffix(budget)}   🟢 notable improvement   ${summary.totalRoutes} route(s)`,
  ].join("\n");
};

export const renderBootstrap = (sizes: Sizes): string => {
  const sorted = [...sizes.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
  const table = markdownTable([
    ["Route", "First Load JS"],
    ...sorted.map(([route, stats]) => [
      `\`${route}\``,
      prettyBytes(stats.bytes),
    ]),
  ]);

  return [
    "## 📦 Bundle size",
    "",
    `Baseline not yet established. ${sizes.size} routes captured.`,
    "",
    table,
  ].join("\n");
};
