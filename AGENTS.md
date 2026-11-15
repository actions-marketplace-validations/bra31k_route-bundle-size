# AGENTS.md

Notes for AI coding agents and human contributors. For usage, config and the GitHub Action, see [README.md](README.md).

route-bundle-size reads `.next/diagnostics/route-bundle-stats.json`, which Next.js 16.2+ writes on Turbopack production builds. It measures first-load JS per route, compares it with a baseline, and exits `1` when a route grows past the budget.

## Commands

Node `>=22.12.0` (CI runs the exact minimum 22.12.0 and the latest LTS).

```bash
npm ci
npm run types   # tsc --noEmit, covers src/ and the tests
npm test        # Jest with ESM; run it through npm, it needs NODE_OPTIONS from package.json
npm run build   # compiles src/ to dist/
node dist/cli.js diff --current test/fixtures/sample-build/diagnostics/route-bundle-stats.json   # CI smoke run
```

## Layout

- `src/cli.ts`: commander setup, the `diff` and `measure` commands, output and exit codes.
- `src/config.ts`: config defaults, parsing and validation, byte size strings.
- `src/lib.ts`: loading inputs, budget checks, terminal and markdown rendering.
- `src/measure.ts`: gzips first-load chunks and writes snapshots.
- `src/stats.ts`: parsers for the Next.js stats file and for snapshots.
- `test/*.test.ts`: Jest tests. `cli.test.ts` runs `src/cli.ts` through `tsx`, so it needs no build.
- `test/fixtures/sample-build/`: synthetic stats file used by the tests and the CI smoke run.
- `test/fixtures/next-app/`: a real Next.js app that the action self-test builds.
- `action.yml`: composite GitHub Action. It builds head and merge base, measures both, then runs `diff`.
- `.github/workflows/ci.yml`: types, tests, build and smoke run on Node 22.12.0 and 26.
- `.github/workflows/action-test.yml`: runs the action on `test/fixtures/next-app`, once without changes and once with a regression. A weekly run uses `next@canary`.
- `.github/workflows/release.yml`: publishes to npm when a GitHub release is published.

## Rules

- Keep changes backward compatible: command names and flags (`diff` is the default command), config keys, the snapshot format (`schemaVersion: 1`) and exit codes (`0` pass, `1` over budget or any error). Human-readable output text may change.
- Config validation rejects unknown keys. The keys of `DEFAULT_CONFIG` in `src/config.ts` are the list of valid top-level and `budget` keys; override keys are in `OVERRIDE_KEYS`. A new key needs a default there and parsing in `parseConfig` or `parseOverride`.
- Byte sizes are 1024-based. `parseByteSize` reads `kb` and `kib` as 1024. Format every size for output with `formatBytes` in `src/lib.ts`, which prints `KiB` and `MiB`.
- The stats file is undocumented Next.js output. If its shape changes, update `parseRawStats` in `src/stats.ts`, `test/fixtures/sample-build/` and the tests together.
- In `measure`, a missing chunk file is an error, and so is a route with first-load bytes but no chunk paths. Never count them as zero.
- Print warnings and errors with `formatMessage` in `src/cli.ts`. It adds `::error::` or `::warning::` only when `GITHUB_ACTIONS=true`.
- The package is ESM. Relative imports in `src/` end in `.js`. `tsc` does not enforce this (`moduleResolution: Bundler`), but Node fails on `dist/` without it.
- Generate README output samples by running the built CLI. Do not edit them by hand.

## action.yml

- Pass inputs and step outputs to scripts through `env:`. Never put `${{ }}` inside `run:`.
- Keep all logic inline in `action.yml`. Do not add script files under `$GITHUB_ACTION_PATH`: in the self-test the action runs as `uses: ./`, and the merge-base checkout replaces those files mid-run.
- By default the action installs the CLI from npm at the version in `package.json`. The self-test passes a packed tarball through the `package` input instead, so it tests the CLI and the action from the same commit.
- Keep `action-test.yml` passing.

## Releases

- The release tag must be `v<version>` from `package.json`. `release.yml` checks this.
- Publish only through `release.yml`. It uses npm trusted publishing and then moves the major tag (for example `v0`) to the release commit. Do not run `npm publish` by hand.
- The npm package ships only `dist/`. Add a runtime dependency only when Node built-ins cannot do the job.
