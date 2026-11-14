import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "@jest/globals";

import type { Budget } from "./src/config";
import {
  assertComparable,
  buildRows,
  buildSummary,
  findUnmatchedOverrides,
  formatBytes,
  formatDelta,
  formatFailure,
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
  "/preview/**",
  "/test/**",
  "/docs/legacy/**",
  "/account",
  "/account/**",
];

const rawBudget: Budget = {
  metric: "raw",
  maxIncrease: 51_200,
  maxIncreasePercent: 10,
  maxSize: null,
  overrides: [],
};

const compressedBudget: Budget = {
  metric: "compressed",
  maxIncrease: 30 * 1024,
  maxIncreasePercent: 10,
  maxSize: null,
  overrides: [],
};

const zeroBudget: Budget = {
  metric: "raw",
  maxIncrease: 0,
  maxIncreasePercent: 0,
  maxSize: null,
  overrides: [],
};

const withBudget = (changes: Partial<Budget>): Budget => ({
  ...rawBudget,
  ...changes,
});

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
    `route-bundle-size-lib-${process.pid}-${Math.random()}.json`,
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
  limits: { maxIncrease: 51_200, maxIncreasePercent: 10, maxSize: null },
  exceeded: false,
  overMaxSize: false,
  ...overrides,
});

describe("isExcluded", () => {
  it("matches every pattern, including nested, dynamic and dot segments", () => {
    expect(isExcluded("/api/foo", APP_EXCLUDE)).toBe(true);
    expect(isExcluded("/preview/post", APP_EXCLUDE)).toBe(true);
    expect(isExcluded("/test/widget", APP_EXCLUDE)).toBe(true);
    expect(isExcluded("/docs/legacy/x", APP_EXCLUDE)).toBe(true);
    expect(isExcluded("/account/anything", APP_EXCLUDE)).toBe(true);
    expect(isExcluded("/api/foo/bar/baz", APP_EXCLUDE)).toBe(true);
    expect(isExcluded("/api/[...slug]", APP_EXCLUDE)).toBe(true);
    // Route paths are URLs, not files: a leading dot is an ordinary segment.
    expect(isExcluded("/api/.well-known", APP_EXCLUDE)).toBe(true);
    expect(isExcluded("/test/.hidden/x", APP_EXCLUDE)).toBe(true);
    expect(isExcluded("/api/v1.2/x", APP_EXCLUDE)).toBe(true);
  });

  it("does not match routes outside the list, container siblings, or an empty list", () => {
    expect(isExcluded("/", APP_EXCLUDE)).toBe(false);
    expect(isExcluded("/project/123", APP_EXCLUDE)).toBe(false);
    expect(isExcluded("/projects/[id]", APP_EXCLUDE)).toBe(false);
    // /docs alone is NOT excluded, only /docs/legacy/.
    expect(isExcluded("/docs", APP_EXCLUDE)).toBe(false);
    expect(isExcluded("/docs/intro", APP_EXCLUDE)).toBe(false);
    expect(isExcluded("/docs/guide", APP_EXCLUDE)).toBe(false);
    // The empty list is the default: it must exclude nothing at all.
    expect(isExcluded("/api/foo", [])).toBe(false);
  });

  it("does not match a lookalike route that only shares a prefix", () => {
    expect(isExcluded("/apiary", APP_EXCLUDE)).toBe(false);
    expect(isExcluded("/api-docs", APP_EXCLUDE)).toBe(false);
    expect(isExcluded("/previews", APP_EXCLUDE)).toBe(false);
    expect(isExcluded("/testimonials", APP_EXCLUDE)).toBe(false);
    expect(isExcluded("/accounting", APP_EXCLUDE)).toBe(false);
  });

  it("treats a `/x/**` pattern as also covering the container route itself", () => {
    expect(isExcluded("/api", APP_EXCLUDE)).toBe(true);
    expect(isExcluded("/test", APP_EXCLUDE)).toBe(true);
    expect(isExcluded("/docs/legacy", APP_EXCLUDE)).toBe(true);
    expect(isExcluded("/account", APP_EXCLUDE)).toBe(true);
  });

  it("a bracketed segment in a pattern matches only the dynamic route", () => {
    expect(isExcluded("/blog/[slug]", ["/blog/[slug]"])).toBe(true);
    expect(isExcluded("/blog/s", ["/blog/[slug]"])).toBe(false);
    expect(isExcluded("/blog/g", ["/blog/[slug]"])).toBe(false);
  });

  it("a catch-all route pattern matches itself", () => {
    expect(isExcluded("/docs/[[...path]]", ["/docs/[[...path]]"])).toBe(true);
    expect(isExcluded("/shop/[...all]", ["/shop/[...all]"])).toBe(true);
    expect(isExcluded("/[locale]/settings", ["/[locale]/**"])).toBe(true);
    expect(isExcluded("/e/settings", ["/[locale]/**"])).toBe(false);
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
    expect(loaded.compressed).toBe(false);
    expect(loaded.sizes.get("/")?.compressedBytes).toBeNull();
    expect([...loadSizes(rawStatsFile, APP_EXCLUDE).sizes.keys()]).toEqual([
      "/",
    ]);
  });

  it("reads a snapshot with compressed bytes and applies excludes", () => {
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
    expect(loaded.compressed).toBe(true);
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

describe("budget limits", () => {
  it("uses the first matching override for a route", () => {
    const budget = withBudget({
      overrides: [
        { match: "/blog/**", maxIncrease: 100_000, maxIncreasePercent: 100 },
        { match: "/blog/*", maxIncrease: 0, maxIncreasePercent: 0 },
      ],
    });
    const { rows, anyExceeded } = buildRows(
      sizes([["/blog/post", 1_500]]),
      sizes([["/blog/post", 1_000]]),
      budget,
    );

    expect(anyExceeded).toBe(false);
    expect(rows[0]?.limits).toEqual({
      maxIncrease: 100_000,
      maxIncreasePercent: 100,
      maxSize: null,
    });
  });

  it("merges an override over the global budget key by key", () => {
    const budget = withBudget({
      maxSize: 2_000_000,
      overrides: [{ match: "/a", maxIncreasePercent: 50 }],
    });
    const { rows } = buildRows(sizes([["/a", 1_000]]), sizes([]), budget);

    expect(rows[0]?.limits).toEqual({
      maxIncrease: 51_200,
      maxIncreasePercent: 50,
      maxSize: 2_000_000,
    });
  });

  it("keeps the global budget for a route that matches no override", () => {
    const budget = withBudget({
      overrides: [{ match: "/blog/**", maxIncreasePercent: 100 }],
    });
    const { rows, anyExceeded } = buildRows(
      sizes([["/pricing", 1_500]]),
      sizes([["/pricing", 1_000]]),
      budget,
    );

    expect(anyExceeded).toBe(true);
    expect(rows[0]?.limits).toEqual({
      maxIncrease: 51_200,
      maxIncreasePercent: 10,
      maxSize: null,
    });
  });

  it("matches a dynamic route written as /blog/[slug]", () => {
    const budget = withBudget({
      overrides: [{ match: "/blog/[slug]", maxIncreasePercent: 100 }],
    });
    const { anyExceeded } = buildRows(
      sizes([["/blog/[slug]", 1_500]]),
      sizes([["/blog/[slug]", 1_000]]),
      budget,
    );

    expect(anyExceeded).toBe(false);
  });

  it("does not apply a /blog/[slug] override to a static /blog/s route", () => {
    const budget = withBudget({
      overrides: [{ match: "/blog/[slug]", maxIncreasePercent: 100 }],
    });
    const { anyExceeded } = buildRows(
      sizes([["/blog/s", 1_500]]),
      sizes([["/blog/s", 1_000]]),
      budget,
    );

    expect(anyExceeded).toBe(true);
  });

  it("flags a route above maxSize even when it did not grow", () => {
    const { rows, anyExceeded } = buildRows(
      sizes([["/", 1_000_000]]),
      sizes([["/", 1_000_000]]),
      withBudget({ maxSize: 900_000 }),
    );

    expect(anyExceeded).toBe(true);
    expect(rows[0]?.exceeded).toBe(false);
    expect(rows[0]?.overMaxSize).toBe(true);
  });

  it("does not flag a route exactly at maxSize", () => {
    const { anyExceeded } = buildRows(
      sizes([["/", 1_000_000]]),
      sizes([["/", 1_000_000]]),
      withBudget({ maxSize: 1_000_000 }),
    );

    expect(anyExceeded).toBe(false);
  });

  it("flags a new route above maxSize", () => {
    const { rows, anyExceeded } = buildRows(
      sizes([["/added", 1_000_000]]),
      sizes([]),
      withBudget({ maxSize: 900_000 }),
    );

    expect(anyExceeded).toBe(true);
    expect(rows[0]?.overMaxSize).toBe(true);
  });

  it("never flags a removed route for maxSize", () => {
    const { rows, anyExceeded } = buildRows(
      sizes([]),
      sizes([["/gone", 1_000_000]]),
      withBudget({ maxSize: 0 }),
    );

    expect(anyExceeded).toBe(false);
    expect(rows[0]?.overMaxSize).toBe(false);
  });

  it("sorts failing rows first, then by absolute delta", () => {
    const { rows } = buildRows(
      sizes([
        ["/big-drop", 100_000],
        ["/capped", 600_000],
        ["/grown", 1_100],
        ["/small-drop", 900_000],
      ]),
      sizes([
        ["/big-drop", 900_000],
        ["/capped", 600_000],
        ["/grown", 1_000],
        ["/small-drop", 1_000_000],
      ]),
      withBudget({ overrides: [{ match: "/capped", maxSize: 500_000 }] }),
    );

    expect(rows.map((r) => r.route)).toEqual([
      "/grown",
      "/capped",
      "/big-drop",
      "/small-drop",
    ]);
  });

  it("marks a notable shrink using the route's own limits", () => {
    const { rows } = buildRows(
      sizes([
        ["/a", 98_000],
        ["/b", 98_000],
      ]),
      sizes([
        ["/a", 100_000],
        ["/b", 100_000],
      ]),
      withBudget({ overrides: [{ match: "/a", maxIncrease: 1_000 }] }),
    );
    const byRoute = new Map(rows.map((r) => [r.route, r]));

    expect(formatDelta(byRoute.get("/a")!)).toMatch(/🟢/);
    expect(formatDelta(byRoute.get("/b")!)).not.toMatch(/🟢/);
  });

  it("reports overrides that match no route", () => {
    const { rows } = buildRows(
      sizes([["/dashboard", 1_000]]),
      sizes([["/old", 1_000]]),
      rawBudget,
    );

    expect(
      findUnmatchedOverrides(rows, [
        { match: "/dashbord" },
        { match: "/dashboard" },
        { match: "/old" },
      ]),
    ).toEqual(["/dashbord"]);
  });
});

describe("formatFailure", () => {
  const KiB = 1024;

  it("failure message names each route with the limit it broke", () => {
    const budget: Budget = {
      ...compressedBudget,
      overrides: [{ match: "/editor", maxSize: 450 * KiB }],
    };
    const { rows } = buildRows(
      sizes([
        ["/dashboard", 0, 0, 290 * KiB],
        ["/editor", 0, 0, 460 * KiB],
      ]),
      sizes([
        ["/dashboard", 0, 0, 250 * KiB],
        ["/editor", 0, 0, 460 * KiB],
      ]),
      budget,
    );

    expect(formatFailure(rows)).toBe(
      "Bundle size budget exceeded for 2 route(s): /dashboard (limit +30 KiB or +10%), /editor (max size 450 KiB)",
    );

    const both = buildRows(
      sizes([["/editor", 0, 0, 460 * KiB]]),
      sizes([["/editor", 0, 0, 400 * KiB]]),
      budget,
    );

    expect(formatFailure(both.rows)).toBe(
      "Bundle size budget exceeded for 1 route(s): /editor (limit +30 KiB or +10%, max size 450 KiB)",
    );
  });

  it("failure message lists the first five routes and counts the rest", () => {
    const { rows } = buildRows(
      sizes([1, 2, 3, 4, 5, 6, 7].map((n) => [`/r${n}`, n * 1_000])),
      sizes([]),
      withBudget({ maxSize: 0 }),
    );

    expect(formatFailure(rows)).toBe(
      "Bundle size budget exceeded for 7 route(s): /r7 (max size 0 B), /r6 (max size 0 B), /r5 (max size 0 B), /r4 (max size 0 B), /r3 (max size 0 B) (and 2 more)",
    );
  });
});

describe("buildSummary", () => {
  it("computes per-route averages", () => {
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
      avgCurrent: 150,
      avgBaseline: 150,
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

  it("averages compressed bytes under the compressed metric", () => {
    const { rows } = buildRows(
      sizes([["/a", 2_000, 1, 900]]),
      sizes([["/a", 2_000, 1, 700]]), // raw identical: only compressed counts
      compressedBudget,
    );
    expect(buildSummary(rows, "compressed")).toMatchObject({
      avgCurrent: 900,
      avgBaseline: 700,
    });
  });
});

describe("formatDelta", () => {
  it("returns em-dash for sub-threshold deltas (incl. zero)", () => {
    expect(formatDelta(row({ delta: 0 }))).toBe("—");
    expect(formatDelta(row({ delta: 200 }))).toBe("—");
    expect(formatDelta(row({ delta: -200 }))).toBe("—");
  });

  it("keeps the delta visible for an exceeded row under 250 bytes", () => {
    const exceeded = row({ delta: 200, deltaPercent: 20, exceeded: true });
    expect(formatDelta(exceeded)).toBe("+200 B (+20.0%) 🔴");
  });

  it("marks exceeded growth with 🔴 and notable shrink with 🟢", () => {
    const exceeded = row({ delta: 60_000, deltaPercent: 6, exceeded: true });
    const shrunk = row({ delta: -60_000, deltaPercent: -6 });
    expect(formatDelta(exceeded)).toMatch(/\+58\.6 KiB.*🔴/);
    expect(formatDelta(shrunk)).toMatch(/-58\.6 KiB.*🟢/);
  });

  it("labels new routes '(new)' and drops the percent for removed routes", () => {
    // Size column already says "(removed)"; -100% on the delta is noise.
    const gone = row({ current: null, delta: -1_000_000, deltaPercent: -100 });
    const added = row({ baseline: null, delta: 1_000_000, deltaPercent: null });
    expect(formatDelta(gone)).not.toMatch(/-100|%|🟢/);
    expect(formatDelta(added)).toMatch(/\(new\)/);
  });
});

describe("isNotableShrink", () => {
  it("trips on absolute or percentage threshold (whichever first)", () => {
    const abs = row({ delta: -52_000, deltaPercent: -5 });
    const percent = row({ delta: -1_000, deltaPercent: -11 });
    const neither = row({ delta: -1_000, deltaPercent: -5 });
    expect(isNotableShrink(abs)).toBe(true);
    expect(isNotableShrink(percent)).toBe(true);
    expect(isNotableShrink(neither)).toBe(false);
  });

  it("never trips on growth, nor on an unchanged route under a zero budget", () => {
    const grown = row({ delta: 60_000, deltaPercent: 6 });
    expect(isNotableShrink(grown)).toBe(false);
    const zeroLimits = { maxIncrease: 0, maxIncreasePercent: 0, maxSize: null };
    expect(isNotableShrink(row({ delta: 0, limits: zeroLimits }))).toBe(false);
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
    const bootstrap = buildRows(
      sizes([["/", 1_000_000]]),
      new Map(),
      rawBudget,
    );
    const out = renderBootstrap(bootstrap.rows, "raw");
    expect(out).toMatch(/Baseline not yet established/);
    expect(out).toMatch(/1 route\(s\) captured\. Sizes are raw\./);
    expect(out).toMatch(/\| 977 KiB +\|/);
  });

  it("renderMarkdown emits a pipe-delimited table, summary block and legend", () => {
    const out = renderMarkdown(rows, summary, compressedBudget);
    expect(out).toMatch(/## Bundle size/);
    expect(out).toMatch(/\| `\/` +\|/);
    expect(out).toMatch(/\| 391 KiB +\| \+97\.7 KiB \(\+33\.3%\) 🔴 \|/);
    expect(out).toMatch(/### Summary/);
    expect(out).toContain(
      "🔴 grew by at least 30 KiB or 10% (compressed) · 🟢 notable improvement",
    );
  });

  it("renderTerminal emits a cli-table3 box", () => {
    const out = renderTerminal(rows, summary, compressedBudget);
    // Box-drawing chars show that the terminal format was used.
    expect(out).toMatch(/[┌┐└┘│─]/);
  });

  it("prints no total row and no chunk summary", () => {
    const terminal = renderTerminal(rows, summary, compressedBudget);
    const markdown = renderMarkdown(rows, summary, compressedBudget);
    expect(terminal).not.toMatch(/TOTAL/);
    expect(terminal).toContain("Avg per route: 293 KiB → 391 KiB");
    expect(markdown).not.toMatch(/\*\*Total:\*\*/);
    expect(markdown).not.toMatch(/\*\*Chunks:\*\*/);
    expect(markdown).toMatch(/\*\*Routes:\*\* 1/);
    expect(markdown).toMatch(/\*\*Avg per route:\*\* 293 KiB → 391 KiB/);
  });

  it("renders raw byte cells and an unqualified legend under the raw budget", () => {
    const raw = buildRows(
      sizes([["/", 1_500_000]]),
      sizes([["/", 1_000_000]]),
      rawBudget,
    );
    const rawSummary = buildSummary(raw.rows, "raw");

    const markdown = renderMarkdown(raw.rows, rawSummary, rawBudget);
    expect(markdown).toMatch(/\| 1\.43 MiB +\| \+488 KiB \(\+50\.0%\) 🔴 \|/);
    expect(markdown).toContain(
      "🔴 grew by at least 50 KiB or 10% · 🟢 notable improvement",
    );
    expect(markdown).not.toMatch(/compressed/);

    expect(renderTerminal(raw.rows, rawSummary, rawBudget)).toMatch(
      /1\.43 MiB/,
    );
  });

  it("prints sizes in 1024 based units", () => {
    expect(formatBytes(30 * 1024)).toBe("30 KiB");
    expect(formatBytes(500_000)).toBe("488 KiB");
    expect(formatBytes(1_500_000)).toBe("1.43 MiB");
  });

  it("puts the red mark on the size cell for a route above maxSize", () => {
    const capped = buildRows(
      sizes([["/", 1_000_000]]),
      sizes([["/", 1_000_000]]),
      withBudget({ maxSize: 900_000 }),
    );
    const cappedSummary = buildSummary(capped.rows, "raw");

    expect(renderMarkdown(capped.rows, cappedSummary, rawBudget)).toMatch(
      /\| 977 KiB 🔴 +\| — +\|/,
    );
    expect(renderTerminal(capped.rows, cappedSummary, rawBudget)).toMatch(
      /977 KiB 🔴 +│ +— +│/,
    );
  });

  it("legend names maxSize when it is set", () => {
    const budget = { ...compressedBudget, maxSize: 300 * 1024 };

    expect(renderMarkdown(rows, summary, budget)).toContain(
      "🔴 grew by at least 30 KiB or 10%, or is larger than 300 KiB (compressed) · 🟢 notable improvement",
    );
    expect(renderTerminal(rows, summary, budget)).toContain(
      "🔴 grew by at least 30 KiB or 10%, or is larger than 300 KiB (compressed)   🟢 notable improvement   1 route(s)",
    );
  });

  it("legend says some routes have their own limits when overrides exist", () => {
    const overrides = [{ match: "/blog/**", maxIncreasePercent: 20 }];

    expect(
      renderMarkdown(rows, summary, {
        ...compressedBudget,
        maxSize: 300 * 1024,
        overrides,
      }),
    ).toContain(
      "🔴 grew by at least 30 KiB or 10%, or is larger than 300 KiB (compressed; some routes have their own limits)",
    );
    expect(
      renderMarkdown(rows, summary, { ...compressedBudget, overrides }),
    ).toContain(
      "🔴 grew by at least 30 KiB or 10% (compressed; some routes have their own limits)",
    );
  });
});
