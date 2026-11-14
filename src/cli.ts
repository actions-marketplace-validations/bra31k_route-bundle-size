#!/usr/bin/env node
import * as fs from "node:fs";
import { createRequire } from "node:module";

import { Command, Option } from "commander";

import { type Budget, loadConfig } from "./config.js";
import {
  assertComparable,
  assertMaxSizeComparable,
  buildRows,
  buildSummary,
  findUnmatchedOverrides,
  FORMATS,
  type Format,
  formatFailure,
  type LoadedSizes,
  loadSizes,
  renderBootstrap,
  renderMarkdown,
  renderTerminal,
  type Row,
} from "./lib.js";
import { defaultStatsFile, measure, writeSnapshot } from "./measure.js";

const writeSummary = (markdown: string): void => {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;

  if (summaryPath !== undefined) {
    fs.appendFileSync(summaryPath, markdown + "\n");
    return;
  }

  console.log(markdown);
};

const formatMessage = (
  level: "error" | "warning",
  message: string,
): string => {
  if (process.env.GITHUB_ACTIONS === "true") {
    return `::${level}::${message}`;
  }

  return level === "warning" ? `Warning: ${message}` : message;
};

const loadInput = (filePath: string, exclude: string[]): LoadedSizes => {
  const loaded = loadSizes(filePath, exclude);

  if (loaded.sizes.size === 0) {
    console.error(
      formatMessage(
        "warning",
        `No routes to check in ${filePath}. The file lists no routes, or "exclude" removes all of them.`,
      ),
    );
  }

  return loaded;
};

const reportVerdict = (
  rows: Row[],
  anyExceeded: boolean,
  budget: Budget,
): void => {
  for (const match of findUnmatchedOverrides(rows, budget.overrides)) {
    console.error(
      formatMessage("warning", `Override "${match}" matches no route.`),
    );
  }

  if (anyExceeded) {
    console.error(formatMessage("error", formatFailure(rows)));
    process.exitCode = 1;
  }
};

const diffCommand = new Command("diff")
  .description(
    "Compare route bundle sizes with a baseline and report the routes that grew past the budget.",
  )
  .requiredOption(
    "--current <file>",
    "Snapshot or route-bundle-stats.json of the build to check",
  )
  .option(
    "--baseline <file>",
    "Snapshot or route-bundle-stats.json to compare with. Without it, only the current sizes are shown",
  )
  .addOption(
    new Option(
      "--format <format>",
      "Output format. 'terminal' prints a table to stdout. 'markdown' writes a GitHub-flavored table to $GITHUB_STEP_SUMMARY when it is set, otherwise to stdout",
    )
      .choices([...FORMATS])
      .default("terminal" satisfies Format),
  )
  .option(
    "--config <file>",
    "Path to the config file. Without it, route-bundle-size.config.json in the current directory is used if it exists",
  )
  .option(
    "--no-exclude",
    'Check every route and ignore the "exclude" patterns from the config',
  )
  .action(
    (options: {
      current: string;
      baseline?: string;
      format: Format;
      config?: string;
      exclude: boolean;
    }) => {
      const config = loadConfig({ configPath: options.config });
      const exclude = options.exclude ? config.exclude : [];
      const budget = config.budget;

      const current = loadInput(options.current, exclude);

      if (options.baseline === undefined || !fs.existsSync(options.baseline)) {
        if (options.baseline !== undefined) {
          console.error(
            formatMessage(
              "warning",
              `Baseline file not found: ${options.baseline}. Nothing was compared, showing current sizes only.`,
            ),
          );
        }

        assertMaxSizeComparable(current, budget);

        const metric =
          budget.metric === "compressed" && !current.compressed
            ? "raw"
            : budget.metric;
        const { rows, anyExceeded } = buildRows(current.sizes, new Map(), {
          ...budget,
          metric,
        });

        writeSummary(renderBootstrap(rows, metric));
        reportVerdict(rows, anyExceeded, budget);
        return;
      }

      const baseline = loadInput(options.baseline, exclude);
      assertComparable(current, baseline, budget.metric);

      const { rows, anyExceeded } = buildRows(
        current.sizes,
        baseline.sizes,
        budget,
      );
      const summary = buildSummary(rows, budget.metric);

      const output =
        options.format === "terminal"
          ? renderTerminal(rows, summary, budget)
          : renderMarkdown(rows, summary, budget);

      if (options.format === "terminal") {
        console.log(output);
      } else {
        writeSummary(output);
      }

      reportVerdict(rows, anyExceeded, budget);
    },
  );

const measureCommand = new Command("measure")
  .description(
    "Gzip every unique first-load chunk once and write a snapshot with raw + compressed bytes per route.",
  )
  .option(
    "--app-dir <dir>",
    "App root that the chunk paths in the stats file resolve against (the directory that contains .next)",
    ".",
  )
  .option(
    "--stats <file>",
    "Path to route-bundle-stats.json (default: <app-dir>/.next/diagnostics/route-bundle-stats.json)",
  )
  .requiredOption("--out <file>", "Path to write the snapshot JSON to")
  .action((options: { appDir: string; stats?: string; out: string }) => {
    const statsFile = options.stats ?? defaultStatsFile(options.appDir);
    const { snapshot, uniqueChunkCount } = measure({
      appDir: options.appDir,
      statsFile,
    });

    if (snapshot.routes.length === 0) {
      console.error(
        formatMessage(
          "warning",
          `${statsFile} lists no routes, so the snapshot is empty.`,
        ),
      );
    }

    writeSnapshot(options.out, snapshot);

    console.log(
      `Wrote ${options.out}: ${snapshot.routes.length} route(s), ${uniqueChunkCount} unique chunk(s)`,
    );
  });

const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

const program = new Command();

program
  .name("route-bundle-size")
  .description(
    "Per-route bundle size budget for Next.js Turbopack builds: measure compressed sizes, diff against a baseline, exit 1 on regression.",
  )
  .version(version);

program.addCommand(diffCommand, { isDefault: true });
program.addCommand(measureCommand);

const commandNames = program.commands.map((command) => command.name());
const firstArg = process.argv[2];

if (
  firstArg !== undefined &&
  !firstArg.startsWith("-") &&
  !commandNames.includes(firstArg) &&
  firstArg !== "help"
) {
  console.error(
    `error: unknown command '${firstArg}'. Commands: ${commandNames.join(", ")}.`,
  );
  process.exitCode = 1;
} else {
  try {
    program.parse();
  } catch (error) {
    console.error(
      formatMessage(
        "error",
        error instanceof Error ? error.message : String(error),
      ),
    );
    process.exitCode = 1;
  }
}
