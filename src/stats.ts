import * as fs from "node:fs";

export const SNAPSHOT_SCHEMA_VERSION = 1;

export type RawEntry = {
  route: string;
  firstLoadUncompressedJsBytes: number;
  firstLoadChunkPaths?: string[];
};

export type SnapshotRoute = {
  route: string;
  rawBytes: number;
  compressedBytes: number;
  chunkPaths: string[];
};

export type Snapshot = {
  schemaVersion: number;
  routes: SnapshotRoute[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export const parseRawStats = (value: unknown, source: string): RawEntry[] => {
  if (!Array.isArray(value)) {
    throw new Error(
      `Invalid stats file ${source}: expected a top-level array of route entries.`,
    );
  }

  return value.map((entry, index): RawEntry => {
    const { route, firstLoadUncompressedJsBytes, firstLoadChunkPaths } =
      (entry ?? {}) as Partial<RawEntry>;

    if (
      typeof route !== "string" ||
      !isFiniteNumber(firstLoadUncompressedJsBytes)
    ) {
      throw new Error(
        `Invalid stats file ${source}: entry ${index} must have a string "route" and a finite "firstLoadUncompressedJsBytes".`,
      );
    }

    return { route, firstLoadUncompressedJsBytes, firstLoadChunkPaths };
  });
};

export const readJsonFile = (filePath: string): unknown => {
  const text = fs.readFileSync(filePath, "utf8");

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export const readRawStats = (filePath: string): RawEntry[] => {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Stats file not found: ${filePath}. A Turbopack production build on Next.js >= 16.2 writes this file.`,
    );
  }

  return parseRawStats(readJsonFile(filePath), filePath);
};

export const parseSnapshot = (value: unknown, source: string): Snapshot => {
  if (!isRecord(value)) {
    throw new Error(`Invalid snapshot ${source}: expected a JSON object.`);
  }

  if (value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported snapshot schemaVersion in ${source}: ${JSON.stringify(value.schemaVersion)}. Expected ${SNAPSHOT_SCHEMA_VERSION}.`,
    );
  }

  if (!Array.isArray(value.routes)) {
    throw new Error(`Invalid snapshot ${source}: "routes" must be an array.`);
  }

  const routes = value.routes.map((entry, index): SnapshotRoute => {
    const { route, rawBytes, compressedBytes, chunkPaths } = (entry ??
      {}) as Partial<SnapshotRoute>;

    if (
      typeof route !== "string" ||
      !isFiniteNumber(rawBytes) ||
      !isStringArray(chunkPaths) ||
      !isFiniteNumber(compressedBytes) ||
      compressedBytes < 0
    ) {
      throw new Error(
        `Invalid snapshot ${source}: route ${index} must have a string "route", a finite "rawBytes", a "chunkPaths" array of strings, and a non-negative "compressedBytes".`,
      );
    }

    return { route, rawBytes, compressedBytes, chunkPaths };
  });

  return { schemaVersion: SNAPSHOT_SCHEMA_VERSION, routes };
};
