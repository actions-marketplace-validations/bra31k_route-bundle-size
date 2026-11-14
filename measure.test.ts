import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";

import { afterEach, describe, expect, it } from "@jest/globals";

import { defaultStatsFile, measure, writeSnapshot } from "./src/measure";
import type { RawEntry } from "./src/stats";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const CHUNK_TEXT = {
  shared: "shared".repeat(500),
  home: "home".repeat(500),
  projects: "projects".repeat(500),
};

const makeAppDir = (
  entries: RawEntry[],
  options: { writeChunks?: boolean; writeStats?: boolean } = {},
): { appDir: string; statsFile: string } => {
  const appDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "route-bundle-size-measure-"),
  );
  created.push(appDir);

  const chunkDir = path.join(appDir, ".next", "static", "chunks");
  fs.mkdirSync(chunkDir, { recursive: true });

  if (options.writeChunks !== false) {
    fs.writeFileSync(path.join(chunkDir, "shared.js"), CHUNK_TEXT.shared);
    fs.writeFileSync(path.join(chunkDir, "home.js"), CHUNK_TEXT.home);
    fs.writeFileSync(path.join(chunkDir, "projects.js"), CHUNK_TEXT.projects);
  }

  const statsFile = defaultStatsFile(appDir);

  if (options.writeStats !== false) {
    fs.mkdirSync(path.dirname(statsFile), { recursive: true });
    fs.writeFileSync(statsFile, JSON.stringify(entries));
  }

  return { appDir, statsFile };
};

const twoRoutes: RawEntry[] = [
  {
    route: "/",
    firstLoadUncompressedJsBytes: 4000,
    firstLoadChunkPaths: [
      ".next/static/chunks/shared.js",
      ".next/static/chunks/home.js",
    ],
  },
  {
    route: "/projects/[id]",
    firstLoadUncompressedJsBytes: 8000,
    firstLoadChunkPaths: [
      ".next/static/chunks/shared.js",
      ".next/static/chunks/projects.js",
    ],
  },
];

const gzipSize = (text: string): number => zlib.gzipSync(text).byteLength;

describe("measure", () => {
  it("compresses each unique chunk once and sums per route", () => {
    const { appDir, statsFile } = makeAppDir(twoRoutes);
    const { snapshot, uniqueChunkCount } = measure({ appDir, statsFile });

    // 4 chunk references across 2 routes, but only 3 distinct files.
    expect(uniqueChunkCount).toBe(3);
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.routes).toEqual([
      {
        route: "/",
        rawBytes: 4000,
        compressedBytes:
          gzipSize(CHUNK_TEXT.shared) + gzipSize(CHUNK_TEXT.home),
        chunkPaths: [
          ".next/static/chunks/shared.js",
          ".next/static/chunks/home.js",
        ],
      },
      {
        route: "/projects/[id]",
        rawBytes: 8000,
        compressedBytes:
          gzipSize(CHUNK_TEXT.shared) + gzipSize(CHUNK_TEXT.projects),
        chunkPaths: [
          ".next/static/chunks/shared.js",
          ".next/static/chunks/projects.js",
        ],
      },
    ]);
  });

  it("throws when a sized route has no chunk paths at all", () => {
    const { appDir, statsFile } = makeAppDir([
      { route: "/heavy", firstLoadUncompressedJsBytes: 1_000_000 },
    ]);

    expect(() => measure({ appDir, statsFile })).toThrow(/\/heavy/);
    expect(() => measure({ appDir, statsFile })).toThrow(/understate/);
  });

  it("throws when a sized route has an empty chunk path array", () => {
    const { appDir, statsFile } = makeAppDir([
      {
        route: "/heavy",
        firstLoadUncompressedJsBytes: 1_000_000,
        firstLoadChunkPaths: [],
      },
    ]);

    expect(() => measure({ appDir, statsFile })).toThrow(/\/heavy/);
  });

  it("accepts a zero-byte route with no chunks", () => {
    const { appDir, statsFile } = makeAppDir([
      { route: "/server-only", firstLoadUncompressedJsBytes: 0 },
    ]);

    expect(measure({ appDir, statsFile }).snapshot.routes).toEqual([
      {
        route: "/server-only",
        rawBytes: 0,
        compressedBytes: 0,
        chunkPaths: [],
      },
    ]);
  });

  it("throws listing missing chunks and mentioning --app-dir", () => {
    const { appDir, statsFile } = makeAppDir(twoRoutes, { writeChunks: false });

    expect(() => measure({ appDir, statsFile })).toThrow(/--app-dir/);
    expect(() => measure({ appDir, statsFile })).toThrow(
      /\.next\/static\/chunks\/shared\.js/,
    );
  });

  it("explains how to produce the stats file when it is absent", () => {
    const { appDir, statsFile } = makeAppDir(twoRoutes, { writeStats: false });

    expect(() => measure({ appDir, statsFile })).toThrow(/--app-dir/);
    expect(() => measure({ appDir, statsFile })).toThrow(
      /next build --webpack/,
    );
    expect(() => measure({ appDir, statsFile })).toThrow(
      /--stats <app-dir>\/<distDir>\/diagnostics\/route-bundle-stats\.json/,
    );
  });

  it("validates the raw stats shape, naming the file and the entry index", () => {
    const { appDir, statsFile } = makeAppDir([]);
    fs.writeFileSync(
      statsFile,
      JSON.stringify([
        { route: "/", firstLoadUncompressedJsBytes: 1 },
        { route: 42, firstLoadUncompressedJsBytes: 1 },
      ]),
    );

    expect(() => measure({ appDir, statsFile })).toThrow(/entry 1/);
    expect(() => measure({ appDir, statsFile })).toThrow(statsFile);
  });

  it("measure rejects firstLoadChunkPaths that is not an array of strings", () => {
    const { appDir, statsFile } = makeAppDir([]);
    fs.writeFileSync(
      statsFile,
      JSON.stringify([
        {
          route: "/",
          firstLoadUncompressedJsBytes: 0,
          firstLoadChunkPaths: null,
        },
        {
          route: "/a",
          firstLoadUncompressedJsBytes: 1,
          firstLoadChunkPaths: "a.js",
        },
      ]),
    );

    expect(() => measure({ appDir, statsFile })).toThrow(/entry 1/);
    expect(() => measure({ appDir, statsFile })).toThrow(/firstLoadChunkPaths/);
    expect(() => measure({ appDir, statsFile })).toThrow(statsFile);
  });

  it("rejects a stats file that is not an array", () => {
    const { appDir, statsFile } = makeAppDir([]);
    fs.writeFileSync(statsFile, JSON.stringify({ routes: [] }));

    expect(() => measure({ appDir, statsFile })).toThrow(/top-level array/);
  });

  it("writeSnapshot round-trips through JSON", () => {
    const { appDir, statsFile } = makeAppDir(twoRoutes);
    const { snapshot } = measure({ appDir, statsFile });
    const out = path.join(appDir, "nested", "snapshot.json");

    writeSnapshot(out, snapshot);

    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual(snapshot);
  });
});
