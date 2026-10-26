# route-bundle-size

Per-route first-load JS budget for Next.js Turbopack builds.

It reads the route stats that `next build` writes, gzips each route's first-load chunks, and compares a PR build with its merge-base build. It fails when a route grows past the budget.

- Sizes are per route, first-load JS only.
- The budget gates on gzip size by default. Raw bytes are also supported.
- The [example workflow](#github-actions) uses the PR's merge base as the baseline, so later commits on the base branch never count against the PR.

## Requirements

- Next.js >= 16.2 with Turbopack. Turbopack is the default for `next build`.
- Node.js >= 22.12.

Next.js 16.2 and later writes `.next/diagnostics/route-bundle-stats.json` on every Turbopack production build. No flag or env var is needed. `next build --webpack` does not write this file, so webpack builds are not supported.

## Quick start

```bash
# At the baseline commit
npx next build
npx route-bundle-size measure --app-dir . --out /tmp/baseline.json

# At the commit you want to check
npx next build
npx route-bundle-size measure --app-dir . --out /tmp/current.json

npx route-bundle-size diff --current /tmp/current.json --baseline /tmp/baseline.json
```

In a monorepo, build the app and point `--app-dir` at it, for example `--app-dir apps/web`.

## Commands

### `measure`

```bash
npx route-bundle-size measure \
  --app-dir <dir> \
  --out <file> \
  [--stats <file>]
```

- `--app-dir` (required): the app root. Chunk paths in the stats file resolve against it.
- `--out` (required): where to write the snapshot JSON.
- `--stats`: path to the stats file. Default: `<app-dir>/.next/diagnostics/route-bundle-stats.json`.

`measure` gzips each unique chunk once, then sums the chunks of each route. It writes a snapshot:

```json
{ "schemaVersion": 1, "routes": [{ "route": "/", "rawBytes": 65000, "compressedBytes": 49276, "chunkPaths": ["..."] }] }
```

It fails if a chunk file is missing under `--app-dir`. It also fails if a route reports first-load JS but lists no chunk paths. A missing chunk is never counted as zero.

Run `measure` right after each build. The next build overwrites `.next`.

### `diff`

`diff` is the default command, so `npx route-bundle-size --current ...` works too.

```bash
npx route-bundle-size diff \
  --current <file> \
  [--baseline <file>] \
  [--format terminal|markdown] \
  [--config <file>] \
  [--no-exclude]
```

- `--current` (required): the snapshot to check.
- `--baseline`: the snapshot to compare with. If it is omitted or the file does not exist, `diff` prints the current sizes and exits `0`. Use this to bootstrap.
- `--format`: `terminal` (default) prints a table to stdout. `markdown` writes a GitHub-flavored table to the file in `$GITHUB_STEP_SUMMARY`, or to stdout when that variable is not set.
- `--config`: path to the config file. Default: `route-bundle-size.config.json` in the current directory, if it exists.
- `--no-exclude`: ignore the `exclude` patterns from the config.

Both inputs can be a `measure` snapshot or a raw `route-bundle-stats.json`. The tool detects the shape. A raw stats file has no gzip sizes, so with `metric: "compressed"` it is an error. Use `measure` snapshots, or set `metric` to `"raw"`.

`--no-exclude` helps when you look for shared-chunk growth. Pages that ship only shared chunks, such as `/_not-found`, all grow by the same amount when a shared chunk grows.

## Config

`route-bundle-size.config.json` in the current directory, or the file passed with `--config`. All keys are optional.

```json
{
  "exclude": ["/api/**"],
  "budget": {
    "metric": "compressed",
    "maxIncrease": "30kb",
    "maxIncreasePercent": 10
  }
}
```

- `exclude`: glob patterns ([picomatch](https://github.com/micromatch/picomatch)) matched against the route. Default `[]`.
- `budget.metric`: `"compressed"` (gzip, default) or `"raw"` (uncompressed bytes from the stats file).
- `budget.maxIncrease`: a byte count, or a string such as `"30kb"`, `"1.5mb"`, `"512b"`. Default `"30kb"`.
- `budget.maxIncreasePercent`: a non-negative number. Default `10`.

A route fails when its size grows by at least `maxIncrease` bytes or at least `maxIncreasePercent` percent, whichever comes first.

Units in the config use 1024: `"30kb"` is 30,720 bytes. Output uses 1000-byte kB, so `"30kb"` prints as `30.7 kB`.

Unknown keys are an error, so a typo such as `"excludes"` does not silently turn off filtering. A missing default config file means defaults are used. A missing file passed with `--config` is an error.

## Output

Terminal (`--format terminal`, the default):

```text
┌───────────────┬──────────┬───────────┬──────────────────────┬──────────┐
│ Route         │ Baseline │   Current │              Δ bytes │ Δ chunks │
├───────────────┼──────────┼───────────┼──────────────────────┼──────────┤
│ /settings     │   185 kB │ (removed) │           -185 kB 🟢 │       -6 │
├───────────────┼──────────┼───────────┼──────────────────────┼──────────┤
│ /onboarding   │    (new) │    173 kB │        +173 kB (new) │       +5 │
├───────────────┼──────────┼───────────┼──────────────────────┼──────────┤
│ /dashboard    │   255 kB │    292 kB │ +37.1 kB (+14.5%) 🔴 │       +1 │
├───────────────┼──────────┼───────────┼──────────────────────┼──────────┤
│ /pricing      │   166 kB │    148 kB │ -17.9 kB (-10.8%) 🟢 │       -1 │
├───────────────┼──────────┼───────────┼──────────────────────┼──────────┤
│ /             │   161 kB │    162 kB │       +470 B (+0.3%) │        — │
├───────────────┼──────────┼───────────┼──────────────────────┼──────────┤
│ /blog/[slug]  │   157 kB │    157 kB │                    — │        — │
├───────────────┼──────────┼───────────┼──────────────────────┼──────────┤
│ /_not-found   │   138 kB │    138 kB │                    — │        — │
├───────────────┼──────────┼───────────┼──────────────────────┼──────────┤
│ TOTAL         │  1.06 MB │   1.07 MB │     +7.17 kB (+0.7%) │       -1 │
├───────────────┼──────────┼───────────┼──────────────────────┼──────────┤
│ avg per route │   177 kB │    178 kB │                      │          │
└───────────────┴──────────┴───────────┴──────────────────────┴──────────┘
🔴 exceeds +30.7 kB OR +10% compressed   🟢 notable improvement   7 route(s)
::error::Bundle size regression — see step summary
```

Markdown (`--format markdown`):

```markdown
## 📦 Bundle size

| Route          | First Load JS | Δ                    |
| -------------- | ------------- | -------------------- |
| `/settings`    | — (removed)   | -185 kB 🟢           |
| `/onboarding`  | 173 kB        | +173 kB (new)        |
| `/dashboard`   | 292 kB        | +37.1 kB (+14.5%) 🔴 |
| `/pricing`     | 148 kB        | -17.9 kB (-10.8%) 🟢 |
| `/`            | 162 kB        | +470 B (+0.3%)       |
| `/blog/[slug]` | 157 kB        | —                    |
| `/_not-found`  | 138 kB        | —                    |

### Summary

- **Routes:** 7
- **Total:** 1.06 MB → 1.07 MB (+7.17 kB, +0.7%)
- **Avg per route:** 177 kB → 178 kB
- **Chunks:** 30 → 29 (-1)

🔴 exceeds `+30.7 kB` OR `+10%` compressed · 🟢 notable improvement (≥30.7 kB OR ≥10% smaller)
```

How to read it:

- Sizes and deltas use the budget metric. Rows are sorted by the size of the change.
- 🔴 marks a route over budget. 🟢 marks a route that shrank by at least the budget.
- A change under 250 bytes shows as `—`.
- New routes are marked `(new)` and never fail the budget. Removed routes never fail either.
- The `::error::` line goes to stderr. GitHub Actions shows it as an annotation.

Without a baseline, `diff` prints the current routes only. This table always shows raw bytes, and it goes to the step summary or stdout for both formats:

```markdown
## 📦 Bundle size

Baseline not yet established. 6 routes captured.

| Route          | First Load JS |
| -------------- | ------------- |
| `/dashboard`   | 969 kB        |
| `/onboarding`  | 557 kB        |
| `/`            | 514 kB        |
| `/blog/[slug]` | 499 kB        |
| `/pricing`     | 472 kB        |
| `/_not-found`  | 432 kB        |
```

## Exit codes

- `0`: every route is within budget, or there is no baseline yet. A `--baseline` path that does not exist also exits `0`, so the first run passes.
- `1`: at least one route is over budget, or any error: bad config, unreadable input, missing chunk files, or raw stats used with `metric: "compressed"`.

## GitHub Actions

This workflow builds the PR head and its merge base in one job, then compares them. It writes the result to the job summary. It posts no PR comment and needs only `contents: read`, so it works for PRs from forks.

```yaml
name: Bundle size

on:
  pull_request:

permissions:
  contents: read

jobs:
  bundle-size:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v6
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0

      - uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: npm

      # An empty sha would make "git checkout --detach" stay at HEAD,
      # so both sides would measure the same build and always pass.
      - name: Resolve merge base
        id: merge_base
        run: |
          sha=$(git merge-base "origin/${{ github.base_ref }}" HEAD)
          if [ -z "$sha" ]; then
            echo "::error::Could not resolve a merge base with origin/${{ github.base_ref }}."
            exit 1
          fi
          echo "sha=$sha" >> "$GITHUB_OUTPUT"
          echo "head=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"

      - name: Install dependencies
        run: npm ci

      - name: Build current
        run: npx next build

      - name: Measure current
        run: npx --yes route-bundle-size@0.1.0 measure --app-dir . --out "$RUNNER_TEMP/current.json"

      - name: Check out merge base
        run: git checkout --detach ${{ steps.merge_base.outputs.sha }}

      - name: Install dependencies at merge base
        run: npm ci

      - name: Build baseline
        run: npx next build

      - name: Return to PR head
        run: git checkout --detach ${{ steps.merge_base.outputs.head }}

      # .next is gitignored, so the baseline build survives the checkout.
      # Running diff at the PR head uses the PR's config file.
      - name: Measure baseline
        run: npx --yes route-bundle-size@0.1.0 measure --app-dir . --out "$RUNNER_TEMP/baseline.json"

      - name: Compare
        run: |
          npx --yes route-bundle-size@0.1.0 diff \
            --current "$RUNNER_TEMP/current.json" \
            --baseline "$RUNNER_TEMP/baseline.json" \
            --format markdown
```

Notes:

- Pin the tool version. Both snapshots are then made by the same version.
- The tool runs through `npx`, so it does not need the project's `node_modules`. No reinstall is needed after returning to the PR head.
- If the merge-base build fails, the job fails. It does not pass quietly.
- GitHub shows the job summary even when the step exits `1`.
- The cost is a second build in each PR run.
- If your repo tracks `next-env.d.ts`, `next build` rewrites it and the checkout fails. Run `git checkout HEAD -- next-env.d.ts` before each `git checkout --detach`. Projects made with `create-next-app` ignore this file.

## Limitations

- The stats file `route-bundle-stats.json` has no official docs and no stability promise. A Next.js release can change it, so this package stays on 0.x.
- Turbopack only. `next build --webpack` writes no stats file.
- The default `--stats` path assumes the default `distDir` (`.next`). With a custom `distDir`, pass `--stats <app-dir>/<distDir>/diagnostics/route-bundle-stats.json`.
- Only first-load JS is measured.
- One budget applies to every route. There are no per-route budgets.

## Development

```bash
npm test
npm run types
```

The fixture `fixtures/sample-build/diagnostics/route-bundle-stats.json` is the parser contract. If Next.js changes the stats format, update `parseRawStats` in `src/stats.ts` and the fixture together.

## License

MIT
