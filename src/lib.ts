import * as fs from "node:fs";

import Table from "cli-table3";
import { markdownTable } from "markdown-table";
import picomatch from "picomatch";
import prettyBytes from "pretty-bytes";

import type { Budget, Limits, Metric, Override } from "./config.js";
import { parseRawStats, parseSnapshot, readJsonFile } from "./stats.js";

export const FORMATS = ["markdown", "terminal"] as const;
export type Format = (typeof FORMATS)[number];

const MIN_DISPLAY = 250;
const MAX_LISTED_ROUTES = 5;

export const formatBytes = (bytes: number): string =>
  prettyBytes(bytes, { binary: true });

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

const escapeBrackets = (pattern: string): string =>
  pattern.replace(/[[\]]/g, "\\$&");

const routeMatcher = (exclude: string[]): ((route: string) => boolean) =>
  picomatch(exclude.map(escapeBrackets), { dot: true });

export const isExcluded = (route: string, exclude: string[]): boolean =>
  routeMatcher(exclude)(route);

export type Row = {
  route: string;
  current: RouteStats | null;
  baseline: RouteStats | null;
  delta: number;
  deltaPercent: number | null;
  chunkDelta: number;
  limits: Limits;
  exceeded: boolean;
  overMaxSize: boolean;
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

const noCompressedDataError = (sides: string[]): Error =>
  new Error(
    `Budget metric is "compressed" but ${sides.join(" and ")} ${sides.length > 1 ? "have" : "has"} no compressed data. Produce snapshots with the "measure" command, or set "budget.metric" to "raw" in the config.`,
  );

export const assertComparable = (
  current: LoadedSizes,
  baseline: LoadedSizes,
  metric: Metric,
): void => {
  if (metric !== "compressed") {
    return;
  }

  const uncompressed = [
    current.compressed ? null : "current",
    baseline.compressed ? null : "baseline",
  ].filter((side): side is string => side !== null);

  if (uncompressed.length > 0) {
    throw noCompressedDataError(uncompressed);
  }
};

export const assertMaxSizeComparable = (
  current: LoadedSizes,
  budget: Budget,
): void => {
  const hasMaxSize =
    budget.maxSize !== null ||
    budget.overrides.some((override) => override.maxSize !== undefined);

  if (hasMaxSize && budget.metric === "compressed" && !current.compressed) {
    throw noCompressedDataError(["current"]);
  }
};

const metricBytes = (stats: RouteStats, metric: Metric): number =>
  metric === "compressed" ? (stats.compressedBytes ?? 0) : stats.bytes;

const isFailing = (row: Row): boolean => row.exceeded || row.overMaxSize;

export const buildRows = (
  current: Sizes,
  baseline: Sizes,
  budget: Budget,
): { rows: Row[]; anyExceeded: boolean } => {
  const allRoutes = new Set([...current.keys(), ...baseline.keys()]);
  const rows: Row[] = [];
  const globalLimits: Limits = {
    maxIncrease: budget.maxIncrease,
    maxIncreasePercent: budget.maxIncreasePercent,
    maxSize: budget.maxSize,
  };
  const overrides = budget.overrides.map(({ match, ...limits }) => ({
    matches: routeMatcher([match]),
    limits,
  }));

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
    const limits: Limits = {
      ...globalLimits,
      ...overrides.find((override) => override.matches(route))?.limits,
    };
    // New routes (no baseline) never exceeded — a fresh page legitimately ships
    // its full size as "delta", which would otherwise always trip the abs rule.
    const exceeded =
      base !== null &&
      delta > 0 &&
      (delta >= limits.maxIncrease ||
        (deltaPercent !== null && deltaPercent >= limits.maxIncreasePercent));
    const overMaxSize =
      cur !== null && limits.maxSize !== null && currentBytes > limits.maxSize;

    if (exceeded || overMaxSize) {
      anyExceeded = true;
    }

    rows.push({
      route,
      current: cur,
      baseline: base,
      delta,
      deltaPercent,
      chunkDelta,
      limits,
      exceeded,
      overMaxSize,
    });
  }

  rows.sort(
    (a, b) =>
      Number(isFailing(b)) - Number(isFailing(a)) ||
      Math.abs(b.delta) - Math.abs(a.delta),
  );

  return { rows, anyExceeded };
};

export const findUnmatchedOverrides = (
  rows: Row[],
  overrides: Override[],
): string[] =>
  overrides
    .map((override) => override.match)
    .filter((match) => {
      const matches = routeMatcher([match]);
      return !rows.some((row) => matches(row.route));
    });

export type Summary = {
  // Total unique routes across both snapshots (current ∪ baseline). New routes
  // and removed routes both count once.
  totalRoutes: number;
  routesCurrent: number;
  routesBaseline: number;
  avgCurrent: number;
  avgBaseline: number;
};

export const buildSummary = (rows: Row[], metric: Metric): Summary => {
  let totalCurrent = 0;
  let totalBaseline = 0;
  let routesCurrent = 0;
  let routesBaseline = 0;

  for (const row of rows) {
    if (row.current !== null) {
      totalCurrent += metricBytes(row.current, metric);
      routesCurrent += 1;
    }
    if (row.baseline !== null) {
      totalBaseline += metricBytes(row.baseline, metric);
      routesBaseline += 1;
    }
  }

  return {
    totalRoutes: rows.length,
    routesCurrent,
    routesBaseline,
    avgCurrent: routesCurrent > 0 ? totalCurrent / routesCurrent : 0,
    avgBaseline: routesBaseline > 0 ? totalBaseline / routesBaseline : 0,
  };
};

export const isNotableShrink = (row: Row): boolean =>
  row.current !== null &&
  row.delta < 0 &&
  (row.delta <= -row.limits.maxIncrease ||
    (row.deltaPercent !== null &&
      row.deltaPercent <= -row.limits.maxIncreasePercent));

export const formatDelta = (row: Row): string => {
  // Sub-threshold deltas (incl. zero) are visual noise — show as "no change".
  if (!row.exceeded && Math.abs(row.delta) < MIN_DISPLAY) {
    return "—";
  }

  const sign = row.delta > 0 ? "+" : "";
  const marker = row.exceeded ? " 🔴" : isNotableShrink(row) ? " 🟢" : "";

  // Removed: the size column already says "(removed)"; -100% is noise.
  if (row.current === null) {
    return `${sign}${formatBytes(row.delta)}${marker}`;
  }

  const percentLabel =
    row.deltaPercent === null
      ? "new"
      : `${sign}${row.deltaPercent.toFixed(1)}%`;
  return `${sign}${formatBytes(row.delta)} (${percentLabel})${marker}`;
};

const formatSignedInt = (n: number): string => {
  if (n === 0) return "—";
  return n > 0 ? `+${n}` : `${n}`;
};

const formatCurrent = (
  row: Row,
  metric: Metric,
  removedLabel: string,
): string => {
  if (row.current === null) {
    return removedLabel;
  }

  const marker = row.overMaxSize ? " 🔴" : "";
  return `${formatBytes(metricBytes(row.current, metric))}${marker}`;
};

const budgetLegend = (budget: Budget): string => {
  const maxSize =
    budget.maxSize === null
      ? ""
      : `, or is larger than ${formatBytes(budget.maxSize)}`;
  const notes = [
    budget.metric === "compressed" ? "compressed" : null,
    budget.overrides.length > 0 ? "some routes have their own limits" : null,
  ].filter((note): note is string => note !== null);
  const suffix = notes.length > 0 ? ` (${notes.join("; ")})` : "";

  return `🔴 grew by at least ${formatBytes(budget.maxIncrease)} or ${budget.maxIncreasePercent}%${maxSize}${suffix}`;
};

const brokenLimits = ({ exceeded, overMaxSize, limits }: Row): string => {
  const broken: string[] = [];

  if (exceeded) {
    broken.push(
      `limit +${formatBytes(limits.maxIncrease)} or +${limits.maxIncreasePercent}%`,
    );
  }

  if (overMaxSize && limits.maxSize !== null) {
    broken.push(`max size ${formatBytes(limits.maxSize)}`);
  }

  return broken.join(", ");
};

export const formatFailure = (rows: Row[]): string => {
  const failing = rows.filter(isFailing);
  const listed = failing
    .slice(0, MAX_LISTED_ROUTES)
    .map((row) => `${row.route} (${brokenLimits(row)})`)
    .join(", ");
  const more =
    failing.length > MAX_LISTED_ROUTES
      ? ` (and ${failing.length - MAX_LISTED_ROUTES} more)`
      : "";

  return `Bundle size budget exceeded for ${failing.length} route(s): ${listed}${more}`;
};

export const renderMarkdown = (
  rows: Row[],
  summary: Summary,
  budget: Budget,
): string => {
  if (rows.length === 0) {
    return "## Bundle size\n\nNo client routes detected.";
  }

  const table = markdownTable([
    ["Route", "First Load JS", "Δ"],
    ...rows.map((r) => [
      `\`${r.route}\``,
      formatCurrent(r, budget.metric, "— (removed)"),
      formatDelta(r),
    ]),
  ]);

  const summaryLines = [
    "",
    "### Summary",
    "",
    `- **Routes:** ${summary.totalRoutes}`,
    `- **Avg per route:** ${formatBytes(summary.avgBaseline)} → ${formatBytes(summary.avgCurrent)}`,
  ];

  return [
    "## Bundle size",
    "",
    table,
    ...summaryLines,
    "",
    `${budgetLegend(budget)} · 🟢 notable improvement`,
  ].join("\n");
};

export const renderTerminal = (
  rows: Row[],
  summary: Summary,
  budget: Budget,
): string => {
  if (rows.length === 0) {
    return "Bundle size: no client routes detected.";
  }

  const table = new Table({
    head: ["Route", "Baseline", "Current", "Δ bytes", "Δ chunks"],
    colAligns: ["left", "right", "right", "right", "right"],
    style: { head: [], border: [], compact: true },
  });

  for (const row of rows) {
    table.push([
      row.route,
      row.baseline === null
        ? "(new)"
        : formatBytes(metricBytes(row.baseline, budget.metric)),
      formatCurrent(row, budget.metric, "(removed)"),
      formatDelta(row),
      formatSignedInt(row.chunkDelta),
    ]);
  }

  return [
    table.toString(),
    `Avg per route: ${formatBytes(summary.avgBaseline)} → ${formatBytes(summary.avgCurrent)}`,
    `${budgetLegend(budget)}   🟢 notable improvement   ${summary.totalRoutes} route(s)`,
  ].join("\n");
};

export const renderBootstrap = (rows: Row[], metric: Metric): string => {
  const table = markdownTable([
    ["Route", "First Load JS"],
    ...rows.map((row) => [
      `\`${row.route}\``,
      formatCurrent(row, metric, "(removed)"),
    ]),
  ]);
  const legend = rows.some((row) => row.overMaxSize)
    ? ["", "🔴 larger than its max size"]
    : [];

  return [
    "## Bundle size",
    "",
    `Baseline not yet established. ${rows.length} route(s) captured. Sizes are ${metric}.`,
    "",
    table,
    ...legend,
  ].join("\n");
};
