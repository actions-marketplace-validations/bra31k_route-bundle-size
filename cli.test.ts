import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "@jest/globals";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(here, "src", "cli.ts");
const tsxLoader = pathToFileURL(
  createRequire(import.meta.url).resolve("tsx"),
).href;
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
    `route-bundle-size-cli-${label}-${process.pid}-${Math.random()}.json`,
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

const runCli = (
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) => {
  const env = { ...process.env };
  delete env.GITHUB_STEP_SUMMARY;
  delete env.GITHUB_ACTIONS;

  return spawnSync("node", ["--import", tsxLoader, cliPath, ...args], {
    encoding: "utf8",
    cwd: options.cwd,
    env: { ...env, ...options.env },
  });
};

const writeFixture = (route: string, bytes: number): string =>
  writeJson("stats", [
    { route, firstLoadUncompressedJsBytes: bytes, firstLoadChunkPaths: [] },
  ]);

const makeAppDir = (chunkBytes: number): string => {
  const appDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "route-bundle-size-app-"),
  );
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

describe("route-bundle-size CLI (e2e)", () => {
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
    // Box-drawing chars show that the terminal format was used.
    expect(result.stdout).toMatch(/[┌┐└┘│─]/);
    expect(result.stdout).toMatch(/\+488 KiB[^\n]*🔴/);
    expect(result.stderr).toBe(
      "Bundle size budget exceeded for 1 route(s): / (limit +50 KiB or +10%)\n",
    );
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
    expect(result.stdout).toMatch(/## Bundle size/);
    // A pipe-delimited table cell shows that the markdown format was used.
    expect(result.stdout).toMatch(/\| `\/` +\|/);
    expect(result.stdout).toMatch(/\+488 KiB[^\n]*🔴/);
  });

  it("bootstrap mode: missing baseline exits 0 with 'baseline pending'", () => {
    const result = runCli(["--current", fixturePath, "--config", rawConfig()]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Baseline not yet established/);
  });

  it("a missing baseline file exits 0 and warns with the path", () => {
    const missing = path.join(os.tmpdir(), "route-bundle-size-missing.json");
    const result = runCli([
      "--current",
      fixturePath,
      "--baseline",
      missing,
      "--config",
      rawConfig(),
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Baseline not yet established/);
    expect(result.stderr).toBe(
      `Warning: Baseline file not found: ${missing}. Nothing was compared, showing current sizes only.\n`,
    );
  });

  it("an empty stats file exits 0 and warns with the file name", () => {
    const empty = writeJson("stats", []);
    const diffed = runCli([
      "--current",
      empty,
      "--baseline",
      empty,
      "--config",
      rawConfig(),
    ]);

    expect(diffed.status).toBe(0);
    expect(diffed.stderr).toMatch(
      `Warning: No routes to check in ${empty}. The file lists no routes, or "exclude" removes all of them.`,
    );

    const measured = runCli([
      "measure",
      "--app-dir",
      path.dirname(empty),
      "--stats",
      empty,
      "--out",
      tmpPath("snapshot"),
    ]);

    expect(measured.status).toBe(0);
    expect(measured.stderr).toBe(
      `Warning: ${empty} lists no routes, so the snapshot is empty.\n`,
    );
  });

  it("prints the version", () => {
    const { version } = JSON.parse(
      fs.readFileSync(path.join(here, "package.json"), "utf8"),
    );
    const result = runCli(["--version"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${version}\n`);
  });

  it("an unknown command name is reported as unknown", () => {
    const result = runCli(["mesure", "--app-dir", "."]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "error: unknown command 'mesure'. Commands: diff, measure.\n",
    );
  });

  it("adds the GitHub prefix only under GitHub Actions", () => {
    const baseline = writeFixture("/", 1_000_000);
    const current = writeFixture("/", 1_500_000);
    const missing = path.join(os.tmpdir(), "route-bundle-size-missing.json");
    const config = rawConfig();
    const regression = ["--current", current, "--baseline", baseline];
    const noBaseline = ["--current", current, "--baseline", missing];
    const github = { env: { GITHUB_ACTIONS: "true" } };

    expect(runCli([...regression, "--config", config]).stderr).toBe(
      "Bundle size budget exceeded for 1 route(s): / (limit +50 KiB or +10%)\n",
    );
    expect(runCli([...regression, "--config", config], github).stderr).toBe(
      "::error::Bundle size budget exceeded for 1 route(s): / (limit +50 KiB or +10%)\n",
    );
    expect(runCli([...noBaseline, "--config", config]).stderr).toMatch(
      /^Warning: Baseline file not found/,
    );
    expect(runCli([...noBaseline, "--config", config], github).stderr).toMatch(
      /^::warning::Baseline file not found/,
    );
  });

  it("prefixes thrown errors under GitHub Actions", () => {
    const missing = path.join(os.tmpdir(), "route-bundle-size-missing.json");
    const result = runCli(["--current", missing, "--config", rawConfig()], {
      env: { GITHUB_ACTIONS: "true" },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^::error::/);
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
    expect(grown.stderr).toMatch(
      /^Bundle size budget exceeded for 1 route\(s\): \/ /,
    );
  });

  it("measure uses the current directory when app-dir is omitted", () => {
    const out = tmpPath("snapshot");
    const result = runCli(["measure", "--out", out], {
      cwd: makeAppDir(4096),
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(out, "utf8")).routes[0].route).toBe("/");
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

  it("exits 1 without a baseline when a route is above maxSize", () => {
    const current = writeFixture("/", 1_000_000);
    const result = runCli([
      "--current",
      current,
      "--config",
      writeJson("config", { budget: { metric: "raw", maxSize: "900kb" } }),
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/Baseline not yet established/);
    expect(result.stdout).toMatch(/\| 977 KiB 🔴 +\|/);
    expect(result.stdout).toMatch(/🔴 larger than its max size/);
    expect(result.stderr).toBe(
      "Bundle size budget exceeded for 1 route(s): / (max size 900 KiB)\n",
    );
  });

  it("exits 1 when only an override limit is broken", () => {
    const baseline = writeFixture("/editor", 100_000);
    const current = writeFixture("/editor", 104_000);
    const config = writeJson("config", {
      budget: {
        metric: "raw",
        overrides: [{ match: "/editor", maxIncreasePercent: 2 }],
      },
    });
    const result = runCli([
      "--current",
      current,
      "--baseline",
      baseline,
      "--config",
      config,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "Bundle size budget exceeded for 1 route(s): /editor (limit +30 KiB or +2%)\n",
    );
  });

  it("warns about an override that matches no route and keeps the exit code", () => {
    const stats = writeFixture("/dashboard", 1_000);
    const result = runCli([
      "--current",
      stats,
      "--baseline",
      stats,
      "--config",
      writeJson("config", {
        budget: { metric: "raw", overrides: [{ match: "/dashbord" }] },
      }),
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe(
      'Warning: Override "/dashbord" matches no route.\n',
    );
  });

  it("refuses a compressed maxSize check on raw stats without a baseline", () => {
    const result = runCli([
      "--current",
      writeFixture("/", 1_000),
      "--config",
      writeJson("config", {
        budget: { overrides: [{ match: "/", maxSize: "100kb" }] },
      }),
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /Budget metric is "compressed" but current has no compressed data/,
    );
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
