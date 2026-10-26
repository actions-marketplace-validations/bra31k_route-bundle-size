#!/usr/bin/env node
import * as fs from "node:fs";

import { Command, Option } from "commander";

import { loadConfig } from "./config.js";
import {
  assertComparable,
  buildRows,
  buildSummary,
  FORMATS,
  type Format,
  loadSizes,
  renderBootstrap,
  renderMarkdown,
  renderTerminal,
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

const diffCommand = new Command("diff")
  .description(
    "Diff route bundle sizes against a baseline; render markdown or terminal table; exit 1 on exceeded.",
  )
  .requiredOption(
    "--current <file>",
    "Path to the PR's snapshot or route-bundle-stats.json",
  )
  .option(
    "--baseline <file>",
    "Path to main's snapshot or route-bundle-stats.json (bootstrap mode if absent)",
  )
  .addOption(
    new Option(
      "--format <format>",
      "Output format. 'terminal' (default) renders an aligned cli-table3 view for local debugging; 'markdown' writes a GitHub-flavored table to $GITHUB_STEP_SUMMARY and is the CI-only mode.",
    )
      .choices([...FORMATS])
      .default("terminal" satisfies Format),
  )
  .option(
    "--config <file>",
    "Path to route-bundle-size.config.json (default: the one in the current directory, if any)",
  )
  .option(
    "--no-exclude",
    "Ignore the configured exclude patterns. Useful in diagnostic mode — bare pages surface pure shared-chunk drift.",
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

      const current = loadSizes(options.current, exclude);

      if (options.baseline === undefined || !fs.existsSync(options.baseline)) {
        writeSummary(renderBootstrap(current.sizes));
        return;
      }

      const baseline = loadSizes(options.baseline, exclude);
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

      if (anyExceeded) {
        console.error("::error::Bundle size regression — see step summary");
        process.exit(1);
      }
    },
  );

const measureCommand = new Command("measure")
  .description(
    "Gzip every unique first-load chunk once and write a snapshot with raw + compressed bytes per route.",
  )
  .requiredOption(
    "--app-dir <dir>",
    "App root that the chunk paths in the stats file resolve against (the directory that contains .next)",
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

    writeSnapshot(options.out, snapshot);

    console.log(
      `Wrote ${options.out}: ${snapshot.routes.length} route(s), ${uniqueChunkCount} unique chunk(s)`,
    );
  });

const program = new Command();

program
  .name("route-bundle-size")
  .description(
    "Per-route bundle size budget for Next.js builds: measure compressed sizes, diff against a baseline, exit 1 on regression.",
  );

program.addCommand(diffCommand, { isDefault: true });
program.addCommand(measureCommand);

try {
  program.parse();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
