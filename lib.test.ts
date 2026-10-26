import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "@jest/globals";

import type { Budget } from "./src/config";
import {
  assertComparable,
  buildRows,
  buildSummary,
  formatDelta,
  hasCompressedData,
  isExcluded,
  isNotableShrink,
  loadSizes,
  renderBootstrap,
  renderMarkdown,
  renderTerminal,
  type Row,
  type Sizes,
} from "./src/lib";
import type { SnapshotRoute } from "./src/stats";

const APP_EXCLUDE = [
  "/api/**",
  "/auth/**",
  "/debug/**",
  "/embed/redirect/**",
  "/admin",
  "/admin/**",
];

const rawBudget: Budget = {
  metric: "raw",
  maxIncrease: 51_200,
  maxIncreasePercent: 10,
};

const compressedBudget: Budget = {
  metric: "compressed",
  maxIncrease: 30 * 1024,
  maxIncreasePercent: 10,
};

const zeroBudget: Budget = {
  metric: "raw",
  maxIncrease: 0,
  maxIncreasePercent: 0,
};

const sizes = (
  entries: Array<[string, number, number?, (number | null)?]>,
): Sizes =>
  new Map(
    entries.map(([route, bytes, chunks, compressedBytes]) => [
      route,
      { bytes, chunks: chunks ?? 0, compressedBytes: compressedBytes ?? null },
    ]),
  );

const written: string[] = [];
afterAll(() => written.forEach((file) => fs.unlinkSync(file)));

const tmpFile = (contents: unknown): string => {
  const file = path.join(
    os.tmpdir(),
    `bundle-size-lib-${process.pid}-${Math.random()}.json`,
  );
  fs.writeFileSync(file, JSON.stringify(contents));
  written.push(file);
  return file;
};

const writeFixture = (
  entries: Array<{
    route: string;
    firstLoadUncompressedJsBytes: number;
    firstLoadChunkPaths?: string[];
  }>,
): string => tmpFile(entries.map((e) => ({ firstLoadChunkPaths: [], ...e })));

const writeSnapshotFixture = (
  routes: Array<
    Omit<SnapshotRoute, "compressedBytes"> & {
      compressedBytes: number | null;
    }
  >,
): string => tmpFile({ schemaVersion: 1, routes });

const row = (overrides: Partial<Row>): Row => ({
  route: "/",
  current: { bytes: 1000, chunks: 0, compressedBytes: null },
  baseline: { bytes: 1000, chunks: 0, compressedBytes: null },
  delta: 0,
  deltaPercent: 0,
  chunkDelta: 0,
  exceeded: false,
  ...overrides,
});

describe("isExcluded", () => {
  it("matches every pattern — nested, dynamic and dot segments included", () => {
    expect(isExcluded("/api/foo", APP_EXCLUDE)).toBe(true);
    expect(isExcluded("/auth/login", APP_EXCLUDE)).toBe(true);
    expect(isExcluded("/debug/widget", APP_EXCLUDE)).toBe(true);
    expect(isExcluded("/embed/redirect/x", APP_EXCLUDE)).toBe(true);
    expect(isExcluded("/admin/anything", APP_EXCLUDE)).toBe(true);
    expect(isExcluded("/api/foo/bar/baz", APP_EXCLUDE)).toBe(true);
    expect(isExcluded("/api/[...slug]", APP_EXCLUDE)).toBe(true);
    // Route paths are URLs, not files: a leading dot is an ordinary segment.
    expect(isExcluded("/api/.well-known", APP_EXCLUDE)).toBe(true);
    expect(isExcluded("/debug/.hidden/x", APP_EXCLUDE)).toBe(true);
    expect(isExcluded("/api/v1.2/x", APP_EXCLUDE)).toBe(true);
  });

  it("does not match routes outside the list, container siblings, or an empty list", () => {
    expect(isExcluded("/", APP_EXCLUDE)).toBe(false);
    expect(isExcluded("/project/123", APP_EXCLUDE)).toBe(false);
    expect(isExcluded("/projects/[id]", APP_EXCLUDE)).toBe(false);
    // /embed/ alone is NOT excluded — only /embed/redirect/.
    expect(isExcluded("/embed", APP_EXCLUDE)).toBe(false);
    expect(isExcluded("/embed/onboarding", APP_EXCLUDE)).toBe(false);
    expect(isExcluded("/embed/webapp", APP_EXCLUDE)).toBe(false);
    // The empty list is the default: it must exclude nothing at all.
    expect(isExcluded("/api/foo", [])).toBe(false);
  });

  it("does not leak past segment boundaries the way prefix matching did", () => {
    // These patterns replaced `route.startsWith(prefix)`. A lookalike sibling
    // must not be swept in: startsWith("/admin") also matched
    // "/administrator", which was never intended.
    expect(isExcluded("/apiary", APP_EXCLUDE)).toBe(false);
    expect(isExcluded("/api-docs", APP_EXCLUDE)).toBe(false);
    expect(isExcluded("/authenticate", APP_EXCLUDE)).toBe(false);
    expect(isExcluded("/debugger", APP_EXCLUDE)).toBe(false);
    expect(isExcluded("/administrator", APP_EXCLUDE)).toBe(false);
  });

  it("treats a `/x/**` pattern as also covering the container route itself", () => {
    expect(isExcluded("/api", APP_EXCLUDE)).toBe(true);
    expect(isExcluded("/debug", APP_EXCLUDE)).toBe(true);
    expect(isExcluded("/embed/redirect", APP_EXCLUDE)).toBe(true);
    expect(isExcluded("/admin", APP_EXCLUDE)).toBe(true);
  });
});

describe("loadSizes", () => {
  const rawStatsFile = writeFixture([
    {
      route: "/",
      firstLoadUncompressedJsBytes: 1000,
      firstLoadChunkPaths: ["a.js", "b.js", "c.js"],
    },
    { route: "/api/foo", firstLoadUncompressedJsBytes: 999 },
  ]);

  it("reads raw stats: chunk counts, no compressed data, exclude filtering", () => {
    const loaded = loadSizes(rawStatsFile, []);
    expect([...loaded.sizes.keys()].sort()).toEqual(["/", "/api/foo"]);
    expect(loaded.sizes.get("/")?.chunks).toBe(3);
    expect(hasCompressedData(loaded)).toBe(false);
    expect(loaded.sizes.get("/")?.compressedBytes).toBeNull();
    expect([...loadSizes(rawStatsFile, APP_EXCLUDE).sizes.keys()]).toEqual([
      "/",
    ]);
  });

  it("reads a snapshot with compressed bytes, honouring excludes", () => {
    const file = writeSnapshotFixture([
      {
        route: "/",
        rawBytes: 1000,
        compressedBytes: 400,
        chunkPaths: ["a.js", "b.js"],
      },
      {
        route: "/api/x",
        rawBytes: 10,
        compressedBytes: 5,
        chunkPaths: ["a.js"],
      },
    ]);
    const loaded = loadSizes(file, APP_EXCLUDE);
    expect(hasCompressedData(loaded)).toBe(true);
    expect([...loaded.sizes.keys()]).toEqual(["/"]);
    const root = loaded.sizes.get("/");
    expect(root).toEqual({ bytes: 1000, chunks: 2, compressedBytes: 400 });
  });

  it("reports a helpful hint when the input file is missing", () => {
    expect(() => loadSizes("/nope/route-bundle-stats.json", [])).toThrow(
      /Input file not found: \/nope\/route-bundle-stats\.json\. Expected a "measure" snapshot or a route-bundle-stats\.json \(a Turbopack production build on Next\.js >= 16\.2 writes one\)\./,
    );
  });

  it("rejects a snapshot route with missing or negative compressedBytes", () => {
    const hollow = writeSnapshotFixture([
      { route: "/", rawBytes: 10, compressedBytes: 4, chunkPaths: ["a.js"] },
      {
        route: "/hollow",
        rawBytes: 10,
        compressedBytes: null,
        chunkPaths: ["a.js"],
      },
    ]);
    const negative = writeSnapshotFixture([
      { route: "/x", rawBytes: 10, compressedBytes: -1, chunkPaths: ["a.js"] },
    ]);
    expect(() => loadSizes(hollow, [])).toThrow(/route 1/);
    expect(() => loadSizes(hollow, [])).toThrow(/compressedBytes/);
    expect(() => loadSizes(negative, [])).toThrow(/compressedBytes/);
  });

  it("rejects a snapshot route whose chunkPaths is missing or not strings", () => {
    const missing = tmpFile({
      schemaVersion: 1,
      routes: [{ route: "/", rawBytes: 10, compressedBytes: 4 }],
    });
    const notStrings = tmpFile({
      schemaVersion: 1,
      routes: [
        { route: "/", rawBytes: 10, compressedBytes: 4, chunkPaths: [2] },
      ],
    });
    const notArray = tmpFile({
      schemaVersion: 1,
      routes: [{ route: "/", rawBytes: 10, compressedBytes: 4, chunkPaths: 2 }],
    });
    expect(() => loadSizes(missing, [])).toThrow(/chunkPaths/);
    expect(() => loadSizes(notStrings, [])).toThrow(/chunkPaths/);
    expect(() => loadSizes(notArray, [])).toThrow(/chunkPaths/);
  });

  it("rejects input that is neither raw stats nor a supported snapshot", () => {
    const badVersion = tmpFile({ schemaVersion: 99, routes: [] });
    const noVersion = tmpFile({ routes: [] });
    const badRoutes = tmpFile({ schemaVersion: 1, routes: {} });
    expect(() => loadSizes(badVersion, [])).toThrow(/schemaVersion/);
    expect(() => loadSizes(noVersion, [])).toThrow(/schemaVersion/);
    expect(() => loadSizes(badRoutes, [])).toThrow(/"routes" must be an array/);
  });

  it("rejects raw stats with an invalid entry, naming the index", () => {
    const file = tmpFile([
      { route: "/", firstLoadUncompressedJsBytes: 1000 },
      { route: "/broken", firstLoadUncompressedJsBytes: "big" },
    ]);
    expect(() => loadSizes(file, [])).toThrow(
      /entry 1 must have a string "route" and a finite "firstLoadUncompressedJsBytes"/,
    );
  });
});

describe("assertComparable", () => {
  const snap = { compressed: true, sizes: sizes([["/", 1000, 0, 400]]) };
  const raw = { compressed: false, sizes: sizes([["/", 1000]]) };

  it("refuses the compressed metric when a side has no compressed data", () => {
    expect(() => assertComparable(snap, raw, "compressed")).toThrow(
      /baseline has no compressed data/,
    );
    expect(() => assertComparable(raw, raw, "compressed")).toThrow(
      /measure|metric/,
    );
  });

  it("accepts snapshots for the compressed metric and raw stats for raw", () => {
    expect(() => assertComparable(snap, snap, "compressed")).not.toThrow();
    expect(() => assertComparable(raw, raw, "raw")).not.toThrow();
  });
});

describe("buildRows", () => {
  const big = sizes([["/", 1_000_000]]);
  const small = sizes([["/", 100_000]]);
  const none = sizes([]);

  it("flags +50 KB absolute growth as exceeded", () => {
    const abs = buildRows(sizes([["/", 1_051_201]]), big, rawBudget);
    expect(abs.anyExceeded).toBe(true);
    expect(abs.rows[0]?.exceeded).toBe(true);
  });

  it("flags +10% growth as exceeded even under 50 KB", () => {
    const percent = buildRows(sizes([["/", 110_000]]), small, rawBudget);
    expect(percent.anyExceeded).toBe(true);
  });

  it("does not flag growth below both thresholds", () => {
    // +10 KB, +1% — below both.
    const below = buildRows(sizes([["/", 1_010_000]]), big, rawBudget);
    expect(below.anyExceeded).toBe(false);
  });

  it("never flags new or removed routes as exceeded", () => {
    // A brand-new route ships its full size as delta — that would always trip
    // the absolute rule. Explicitly excluded.
    const added = buildRows(sizes([["/added", 5_000_000]]), none, rawBudget);
    const gone = buildRows(none, sizes([["/gone", 5_000_000]]), rawBudget);
    expect(added.anyExceeded).toBe(false);
    expect(added.rows[0]?.baseline).toBeNull();
    expect(added.rows[0]?.deltaPercent).toBeNull();
    expect(gone.anyExceeded).toBe(false);
    expect(gone.rows[0]?.current).toBeNull();
  });

  it("returns deltaPercent=null when baseline is zero (avoids NaN/Infinity)", () => {
    const { rows } = buildRows(big, sizes([["/", 0]]), rawBudget);
    expect(rows[0]?.deltaPercent).toBeNull();
  });

  it("sorts by absolute delta magnitude (descending)", () => {
    const { rows } = buildRows(
      sizes([
        ["/up", 2_000_000],
        ["/tiny", 99_000],
        ["/down", 500_000],
      ]),
      sizes([
        ["/up", 1_000_000],
        ["/tiny", 100_000],
        ["/down", 1_500_000],
      ]),
      rawBudget,
    );
    expect(rows.map((r) => r.route)).toEqual(["/up", "/down", "/tiny"]);
  });

  it("gates on compressed bytes, not raw, when the metric is compressed", () => {
    const under = buildRows(
      sizes([["/", 5_000_000, 0, 400_000]]),
      sizes([["/", 1_000_000, 0, 399_000]]), // +1 KB compressed, +1% — under
      compressedBudget,
    );
    expect(under.anyExceeded).toBe(false);
    expect(under.rows[0]?.delta).toBe(1_000);

    const over = buildRows(
      sizes([["/", 1_000_100, 0, 480_000]]),
      sizes([["/", 1_000_000, 0, 400_000]]),
      compressedBudget,
    );
    expect(over.anyExceeded).toBe(true);
    expect(over.rows[0]?.delta).toBe(80_000);
  });

  it("under a zero budget flags added bytes only, never unchanged or shrunk", () => {
    expect(buildRows(big, big, zeroBudget).anyExceeded).toBe(false);
    expect(
      buildRows(sizes([["/", 999_999]]), big, zeroBudget).anyExceeded,
    ).toBe(false);
    expect(
      buildRows(sizes([["/", 1_000_001]]), big, zeroBudget).anyExceeded,
    ).toBe(true);
  });
});

describe("buildSummary", () => {
  it("aggregates totals and per-route averages", () => {
    const { rows } = buildRows(
      sizes([
        ["/a", 100, 2],
        ["/b", 200, 3],
      ]),
      sizes([
        ["/a", 80, 1],
        ["/b", 220, 4],
      ]),
      rawBudget,
    );
    expect(buildSummary(rows, "raw")).toMatchObject({
      totalCurrent: 300,
      totalBaseline: 300,
      totalDelta: 0,
      avgCurrent: 150,
      avgBaseline: 150,
      chunksCurrent: 5,
      chunksBaseline: 5,
    });
  });

  it("counts new and removed routes once each, per side", () => {
    const { rows } = buildRows(
      sizes([["/new", 100]]),
      sizes([["/gone", 50]]),
      rawBudget,
    );
    expect(buildSummary(rows, "raw")).toMatchObject({
      routesCurrent: 1,
      routesBaseline: 1,
      totalRoutes: 2,
    });
  });

  it("returns null totalDeltaPercent when baseline is empty", () => {
    const { rows } = buildRows(sizes([["/new", 100]]), sizes([]), rawBudget);
    expect(buildSummary(rows, "raw").totalDeltaPercent).toBeNull();
  });

  it("totals compressed bytes under the compressed metric", () => {
    const { rows } = buildRows(
      sizes([["/a", 2_000, 1, 900]]),
      sizes([["/a", 2_000, 1, 700]]), // raw identical: only compressed counts
      compressedBudget,
    );
    expect(buildSummary(rows, "compressed")).toMatchObject({
      totalCurrent: 900,
      totalBaseline: 700,
      totalDelta: 200,
    });
  });
});

describe("formatDelta", () => {
  it("returns em-dash for sub-threshold deltas (incl. zero)", () => {
    expect(formatDelta(row({ delta: 0 }), rawBudget)).toBe("—");
    expect(formatDelta(row({ delta: 200 }), rawBudget)).toBe("—");
    expect(formatDelta(row({ delta: -200 }), rawBudget)).toBe("—");
  });

  it("marks exceeded growth with 🔴 and notable shrink with 🟢", () => {
    const exceeded = row({ delta: 60_000, deltaPercent: 6, exceeded: true });
    const shrunk = row({ delta: -60_000, deltaPercent: -6 });
    expect(formatDelta(exceeded, rawBudget)).toMatch(/\+60 kB.*🔴/);
    expect(formatDelta(shrunk, rawBudget)).toMatch(/-60 kB.*🟢/);
  });

  it("labels new routes '(new)' and drops the percent for removed routes", () => {
    // Size column already says "(removed)"; -100% on the delta is noise.
    const gone = row({ current: null, delta: -1_000_000, deltaPercent: -100 });
    const added = row({ baseline: null, delta: 1_000_000, deltaPercent: null });
    expect(formatDelta(gone, rawBudget)).not.toMatch(/-100|%/);
    expect(formatDelta(added, rawBudget)).toMatch(/\(new\)/);
  });
});

describe("isNotableShrink", () => {
  it("trips on absolute or percentage threshold (whichever first)", () => {
    const abs = row({ delta: -52_000, deltaPercent: -5 });
    const percent = row({ delta: -1_000, deltaPercent: -11 });
    const neither = row({ delta: -1_000, deltaPercent: -5 });
    expect(isNotableShrink(abs, rawBudget)).toBe(true);
    expect(isNotableShrink(percent, rawBudget)).toBe(true);
    expect(isNotableShrink(neither, rawBudget)).toBe(false);
  });

  it("never trips on growth, nor on an unchanged route under a zero budget", () => {
    const grown = row({ delta: 60_000, deltaPercent: 6 });
    expect(isNotableShrink(grown, rawBudget)).toBe(false);
    expect(isNotableShrink(row({ delta: 0 }), zeroBudget)).toBe(false);
  });
});

describe("renderers (smoke)", () => {
  const { rows } = buildRows(
    sizes([["/", 1_500_000, 0, 400_000]]),
    sizes([["/", 1_000_000, 0, 300_000]]),
    compressedBudget,
  );
  const summary = buildSummary(rows, "compressed");

  it("renderBootstrap emits a 'baseline pending' message", () => {
    const out = renderBootstrap(sizes([["/", 1_000_000]]));
    expect(out).toMatch(/Baseline not yet established/);
    expect(out).toMatch(/1 routes captured/);
  });

  it("renderMarkdown emits a pipe-delimited table, summary block and legend", () => {
    const out = renderMarkdown(rows, summary, compressedBudget);
    expect(out).toMatch(/## 📦 Bundle size/);
    expect(out).toMatch(/\| `\/` +\|/);
    expect(out).toMatch(/\| 400 kB +\| \+100 kB \(\+33\.3%\) 🔴 \|/);
    expect(out).toMatch(/### Summary/);
    expect(out).toMatch(/🔴 exceeds `\+30.7 kB` OR `\+10%` compressed/);
  });

  it("renderTerminal emits a cli-table3 box with a TOTAL row", () => {
    const out = renderTerminal(rows, summary, compressedBudget);
    // Box-drawing chars are the load-bearing terminal signal.
    expect(out).toMatch(/[┌┐└┘│─]/);
    expect(out).toMatch(/TOTAL/);
  });

  it("renders raw byte cells and an unqualified legend under the raw budget", () => {
    const raw = buildRows(
      sizes([["/", 1_500_000]]),
      sizes([["/", 1_000_000]]),
      rawBudget,
    );
    const rawSummary = buildSummary(raw.rows, "raw");

    const markdown = renderMarkdown(raw.rows, rawSummary, rawBudget);
    expect(markdown).toMatch(/\| 1\.5 MB +\| \+500 kB \(\+50\.0%\) 🔴 \|/);
    expect(markdown).toMatch(/🔴 exceeds `\+51\.2 kB` OR `\+10%`/);
    expect(markdown).not.toMatch(/compressed/);

    expect(renderTerminal(raw.rows, rawSummary, rawBudget)).toMatch(/1\.5 MB/);
  });
});
