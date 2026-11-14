import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

import {
  isStringArray,
  readRawStats,
  type Snapshot,
  SNAPSHOT_SCHEMA_VERSION,
} from "./stats.js";

export const defaultStatsFile = (appDir: string): string =>
  path.join(appDir, ".next", "diagnostics", "route-bundle-stats.json");

export type MeasureOptions = {
  appDir: string;
  statsFile: string;
};

export type MeasureResult = {
  snapshot: Snapshot;
  uniqueChunkCount: number;
};

const MISSING_CHUNKS_SHOWN = 5;

export const measure = (options: MeasureOptions): MeasureResult => {
  const entries = readRawStats(options.statsFile);
  const invalidChunkPathsIndex = entries.findIndex(
    (entry) => !isStringArray(entry.firstLoadChunkPaths ?? []),
  );

  if (invalidChunkPathsIndex !== -1) {
    throw new Error(
      `Invalid stats file ${options.statsFile}: entry ${invalidChunkPathsIndex} must have "firstLoadChunkPaths" as an array of strings.`,
    );
  }

  const sizedWithoutChunks = entries.filter(
    (entry) =>
      entry.firstLoadUncompressedJsBytes > 0 &&
      (entry.firstLoadChunkPaths ?? []).length === 0,
  );

  if (sizedWithoutChunks.length > 0) {
    throw new Error(
      `${sizedWithoutChunks.length} route(s) in ${options.statsFile} report first-load JS but list no "firstLoadChunkPaths": ${sizedWithoutChunks.map((entry) => entry.route).join(", ")}. Their compressed size would be recorded as 0 and the snapshot would understate their size, so the budget could not see them grow.`,
    );
  }

  const uniqueChunks = [
    ...new Set(entries.flatMap((entry) => entry.firstLoadChunkPaths ?? [])),
  ];

  const missing = uniqueChunks.filter(
    (chunk) => !fs.existsSync(path.resolve(options.appDir, chunk)),
  );

  if (missing.length > 0) {
    const shown = missing.slice(0, MISSING_CHUNKS_SHOWN).join(", ");
    const rest =
      missing.length > MISSING_CHUNKS_SHOWN
        ? ` (and ${missing.length - MISSING_CHUNKS_SHOWN} more)`
        : "";

    throw new Error(
      `${missing.length} chunk file(s) referenced by ${options.statsFile} are missing under --app-dir ${options.appDir}: ${shown}${rest}. Point --app-dir at the app root that the stats paths resolve against.`,
    );
  }

  const compressedByChunk = new Map<string, number>();

  for (const chunk of uniqueChunks) {
    compressedByChunk.set(
      chunk,
      zlib.gzipSync(fs.readFileSync(path.resolve(options.appDir, chunk)))
        .byteLength,
    );
  }

  const snapshot: Snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    routes: entries.map((entry) => {
      const chunks = entry.firstLoadChunkPaths ?? [];

      return {
        route: entry.route,
        rawBytes: entry.firstLoadUncompressedJsBytes,
        compressedBytes: chunks.reduce(
          (total, chunk) => total + (compressedByChunk.get(chunk) ?? 0),
          0,
        ),
        chunkPaths: chunks,
      };
    }),
  };

  return { snapshot, uniqueChunkCount: uniqueChunks.length };
};

export const writeSnapshot = (filePath: string, snapshot: Snapshot): void => {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(snapshot, null, 2)}\n`);
};
