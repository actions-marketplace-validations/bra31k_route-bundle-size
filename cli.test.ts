import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "@jest/globals";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(here, "src", "cli.ts");
const fixturePath = path.join(
  here,
  "fixtures/sample-build/diagnostics/route-bundle-stats.json",
);

const tmpFiles: string[] = [];

afterEach(() => {
  for (const file of tmpFiles.splice(0)) {
    fs.rmSync(file, { recursive: true, force: true });
  }
});

const tmpPath = (label: string): string => {
  const file = path.join(
    os.tmpdir(),
    `bundle-size-cli-${label}-${process.pid}-${Math.random()}.json`,
  );
  tmpFiles.push(file);
  return file;
};

const writeJson = (label: string, contents: unknown): string => {
  const file = tmpPath(label);
  fs.writeFileSync(file, JSON.stringify(contents));
  return file;
};

// A typical CI gate: raw metric, +50 KB / +10%.
const rawConfig = (): string =>
  writeJson("config", {
    exclude: ["/api/**"],
    budget: {
      metric: "raw",
      maxIncrease: "50kb",
      maxIncreasePercent: 10,
    },
  });

const runCli = (args: string[]) => {
  const env = { ...process.env };
  delete env.GITHUB_STEP_SUMMARY;

  return spawnSync("node", ["--import", "tsx", cliPath, ...args], {
    encoding: "utf8",
    env,
  });
};

const writeFixture = (route: string, bytes: number): string =>
  writeJson("stats", [
    { route, firstLoadUncompressedJsBytes: bytes, firstLoadChunkPaths: [] },
  ]);

const makeAppDir = (chunkBytes: number): string => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-size-app-"));
  tmpFiles.push(appDir);

  const chunkDir = path.join(appDir, ".next", "static", "chunks");
  fs.mkdirSync(chunkDir, { recursive: true });
  fs.writeFileSync(path.join(chunkDir, "a.js"), "a".repeat(chunkBytes));

  const statsFile = path.join(
    appDir,
    ".next",
    "diagnostics",
    "route-bundle-stats.json",
  );
  fs.mkdirSync(path.dirname(statsFile), { recursive: true });
  fs.writeFileSync(
    statsFile,
    JSON.stringify([
      {
        route: "/",
        firstLoadUncompressedJsBytes: chunkBytes,
        firstLoadChunkPaths: [".next/static/chunks/a.js"],
      },
    ]),
  );

  return appDir;
};

describe("bundle-size CLI (e2e)", () => {
  it("default format (terminal): regression exits 1 and prints the box", () => {
    const baseline = writeFixture("/", 1_000_000);
    const current = writeFixture("/", 1_500_000);
    const result = runCli([
      "--current",
      current,
      "--baseline",
      baseline,
      "--config",
      rawConfig(),
    ]);
    expect(result.status).toBe(1);
    // Box-drawing chars are the load-bearing terminal-format signal.
    expect(result.stdout).toMatch(/[┌┐└┘│─]/);
    expect(result.stdout).toMatch(/\+500 kB[^\n]*🔴/);
    expect(result.stderr).toMatch(/Bundle size regression/);
  });

  it("--format markdown: regression exits 1 and prints a markdown table", () => {
    const baseline = writeFixture("/", 1_000_000);
    const current = writeFixture("/", 1_500_000);
    const result = runCli([
      "--current",
      current,
      "--baseline",
      baseline,
      "--format",
      "markdown",
      "--config",
      rawConfig(),
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/## 📦 Bundle size/);
    // Pipe-delimited table cell is the load-bearing markdown signal.
    expect(result.stdout).toMatch(/\| `\/` +\|/);
    expect(result.stdout).toMatch(/\+500 kB[^\n]*🔴/);
  });

  it("bootstrap mode: missing baseline exits 0 with 'baseline pending'", () => {
    const result = runCli(["--current", fixturePath, "--config", rawConfig()]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Baseline not yet established/);
  });

  it("diff is the default command, and works when named explicitly", () => {
    const baseline = writeFixture("/", 1_000_000);
    const current = writeFixture("/", 1_010_000);
    const config = rawConfig();
    const args = [
      "--current",
      current,
      "--baseline",
      baseline,
      "--config",
      config,
    ];

    const implicit = runCli(args);
    const explicit = runCli(["diff", ...args]);

    expect(implicit.status).toBe(0);
    expect(explicit.status).toBe(0);
    expect(explicit.stdout).toBe(implicit.stdout);
  });

  it("filters configured excludes, and --no-exclude opts back in", () => {
    const baseline = writeJson("stats", [
      {
        route: "/",
        firstLoadUncompressedJsBytes: 1_000,
        firstLoadChunkPaths: [],
      },
      {
        route: "/api/foo",
        firstLoadUncompressedJsBytes: 1_000,
        firstLoadChunkPaths: [],
      },
    ]);
    const config = rawConfig();

    const filtered = runCli([
      "--current",
      baseline,
      "--baseline",
      baseline,
      "--config",
      config,
    ]);
    expect(filtered.stdout).not.toMatch(/\/api\/foo/);

    const unfiltered = runCli([
      "--current",
      baseline,
      "--baseline",
      baseline,
      "--config",
      config,
      "--no-exclude",
    ]);
    expect(unfiltered.stdout).toMatch(/\/api\/foo/);
  });

  it("refuses the compressed metric without compressed data", () => {
    const stats = writeFixture("/", 1_000_000);
    const config = writeJson("config", { budget: { metric: "compressed" } });

    const result = runCli([
      "--current",
      stats,
      "--baseline",
      stats,
      "--config",
      config,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/no compressed data/);
    expect(result.stderr).toMatch(/measure/);
  });

  it("rejects an unknown config key", () => {
    const config = writeJson("config", { excludes: ["/api/**"] });
    const stats = writeFixture("/", 1_000);

    const result = runCli(["--current", stats, "--config", config]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Unknown key "excludes"/);
  });

  it("measure writes snapshots that the compressed gate compares", () => {
    const small = tmpPath("snapshot-small");
    const large = tmpPath("snapshot-large");
    const measured = runCli([
      "measure",
      "--app-dir",
      makeAppDir(4096),
      "--out",
      small,
    ]);

    expect(measured.status).toBe(0);
    expect(measured.stdout).toMatch(/1 route\(s\), 1 unique chunk\(s\)/);
    expect(
      JSON.parse(fs.readFileSync(small, "utf8")).routes[0].compressedBytes,
    ).toBeGreaterThan(0);

    runCli(["measure", "--app-dir", makeAppDir(4_000_000), "--out", large]);

    const compressedConfig = writeJson("config", {
      budget: { metric: "compressed" },
    });

    const unchanged = runCli([
      "--current",
      small,
      "--baseline",
      small,
      "--config",
      compressedConfig,
    ]);
    expect(unchanged.status).toBe(0);

    const grown = runCli([
      "--current",
      large,
      "--baseline",
      small,
      "--config",
      compressedConfig,
    ]);
    expect(grown.status).toBe(1);
    expect(grown.stdout).toMatch(/🔴/);
    expect(grown.stderr).toMatch(/Bundle size regression/);
  });

  it("refuses a snapshot route that carries null compressedBytes", () => {
    const snapshot = (rawBytes: number): string =>
      writeJson("snapshot", {
        schemaVersion: 1,
        routes: [
          { route: "/", rawBytes, compressedBytes: null, chunkPaths: ["a.js"] },
        ],
      });

    const result = runCli([
      "--current",
      snapshot(1_000_000),
      "--baseline",
      snapshot(1_000),
      "--config",
      writeJson("config", {
        budget: {
          metric: "compressed",
          maxIncrease: 1,
          maxIncreasePercent: 1,
        },
      }),
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/compressedBytes/);
  });

  it("a zero budget does not flag byte-identical inputs", () => {
    const stats = writeFixture("/", 1_000_000);
    const result = runCli([
      "--current",
      stats,
      "--baseline",
      stats,
      "--config",
      writeJson("config", {
        budget: { metric: "raw", maxIncrease: 0, maxIncreasePercent: 0 },
      }),
    ]);

    expect(result.status).toBe(0);
  });
});
