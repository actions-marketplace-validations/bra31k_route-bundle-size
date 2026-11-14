# route-bundle-size

Per-route first-load JS budget for Next.js Turbopack builds.

Next.js 16 removed the per-route "First Load JS" column from the `next build` output ([vercel/next.js#83815](https://github.com/vercel/next.js/pull/83815)). Next.js 16.2 started writing `.next/diagnostics/route-bundle-stats.json` on Turbopack builds, and this tool turns that file into a per-route budget for CI.

It reads the route stats, gzips each route's first-load chunks, and compares a PR build with its merge-base build. It fails when a route grows past the budget or is larger than its size limit.

- Sizes are per route, first-load JS only.
- The budget gates on gzip size by default. Raw bytes are also supported.
- The [GitHub Action](#github-actions) uses the PR's merge base as the baseline, so later commits on the base branch never count against the PR.

## Requirements

- Next.js >= 16.2 with Turbopack. Turbopack is the default for `next build`.
- Node.js >= 22.12.

The stats file is written on every Turbopack production build. No flag or env var is needed.

## Quick start

```bash
# At the baseline commit
npx next build
npx route-bundle-size measure --out /tmp/baseline.json

# At the commit you want to check
npx next build
npx route-bundle-size measure --out /tmp/current.json

npx route-bundle-size diff --current /tmp/current.json --baseline /tmp/baseline.json
```

In a monorepo, build the app and point `--app-dir` at it, for example `--app-dir apps/web`.

## GitHub Actions

The action builds the PR head and its merge base in one job, compares them, and writes the result to the job summary. It posts no PR comment and needs only `contents: read`, so it works for PRs from forks.

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
          persist-credentials: false

      - uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: npm

      - uses: bra31k/route-bundle-size@v0
```

`fetch-depth: 0` is required, because the action needs the history to find the merge base. `ref` makes it build the PR head commit instead of the merge commit that GitHub creates.

Inputs, all optional:

- `app-dir`: the Next.js app directory. Default `.`.
- `install-command`: installs the dependencies. Default `npm ci`.
- `build-command`: builds the app. Default `npx next build`.
- `base`: the git ref to compare with. Default `origin/<base branch of the PR>`. Set it for events that are not pull requests, such as `push`.
- `package`: the npm spec of the CLI. Default: `route-bundle-size` at the action's own version.

Output:

- `report`: the path to the markdown report.

The action resolves the merge base of `base` and the head. It installs, builds and measures the head. Then it checks out the merge base with `git checkout --force`, installs, builds and measures it, and returns to the head. It runs `diff --format markdown` at the head, so the PR's config file is used.

Notes:

- pnpm, yarn or bun: set up the package manager before `setup-node`, and set `install-command`, for example `pnpm install --frozen-lockfile`. Make the `cache:` value of `setup-node` match your lockfile, or remove it.
- Monorepo: set `app-dir: apps/web`. Both commands run in `app-dir`, and the config file is read from there.
- The cost is a second build in each PR run.
- GitHub shows the job summary even when the step fails.
- Pin `@v0`, which moves with each 0.x release, or an exact `@v0.2.0`.

### Without the action

For other CI systems or a custom setup, this workflow does the same steps by hand:

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
    env:
      ROUTE_BUNDLE_SIZE: route-bundle-size@0.2.0
    steps:
      - uses: actions/checkout@v6
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
          persist-credentials: false

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
        run: npx --yes "$ROUTE_BUNDLE_SIZE" measure --out "$RUNNER_TEMP/current.json"

      - name: Check out merge base
        run: git checkout --force --detach ${{ steps.merge_base.outputs.sha }}

      - name: Install dependencies at merge base
        run: npm ci

      - name: Build baseline
        run: npx next build

      - name: Return to PR head
        run: git checkout --force --detach ${{ steps.merge_base.outputs.head }}

      # .next is gitignored, so the baseline build survives the checkout.
      # Running diff at the PR head uses the PR's config file.
      - name: Measure baseline
        run: npx --yes "$ROUTE_BUNDLE_SIZE" measure --out "$RUNNER_TEMP/baseline.json"

      - name: Compare
        run: |
          npx --yes "$ROUTE_BUNDLE_SIZE" diff \
            --current "$RUNNER_TEMP/current.json" \
            --baseline "$RUNNER_TEMP/baseline.json" \
            --format markdown
```

Notes:

- The baseline is the merge base, not the tip of the base branch, so commits on the base branch that the PR does not contain never count against it.
- Pin the tool version in one place, as `ROUTE_BUNDLE_SIZE` does here. Both snapshots are then made by the same version.
- The tool runs through `npx`, so it does not need the project's `node_modules`. No reinstall is needed after returning to the PR head.
- If the merge-base build fails, the job fails. It does not pass quietly.
- On other CI systems `GITHUB_STEP_SUMMARY` is not set, so `--format markdown` prints the report to stdout.

## Commands

`npx route-bundle-size --version` prints the installed version.

### `measure`

```bash
npx route-bundle-size measure \
  --out <file> \
  [--app-dir <dir>] \
  [--stats <file>]
```

- `--out` (required): where to write the snapshot JSON.
- `--app-dir`: the app root. Chunk paths in the stats file resolve against it. Default `.`.
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
- `--baseline`: the snapshot to compare with. Without it, `diff` shows only the current sizes (see [Output](#output)). If the file does not exist, `diff` prints a warning and works as if no baseline was given.
- `--format`: `terminal` (default) prints a table to stdout. `markdown` writes a GitHub-flavored table to the file in `$GITHUB_STEP_SUMMARY`, or to stdout when that variable is not set.
- `--config`: path to the config file. Default: `route-bundle-size.config.json` in the current directory, if it exists.
- `--no-exclude`: ignore the `exclude` patterns from the config.

Both inputs can be a `measure` snapshot or a raw `route-bundle-stats.json`. The tool detects the shape. A raw stats file has no gzip sizes, so with `metric: "compressed"` it is an error. Use `measure` snapshots, or set `metric` to `"raw"`. If an input has no routes left after `exclude`, `diff` prints a warning.

`--no-exclude` helps when you look for shared-chunk growth. Pages-router `/api/*` entries carry only the `_app` chunks, so they all grow by the same amount when a shared chunk grows. This is also why the example config below excludes `/api/**`.

## Config

`route-bundle-size.config.json` in the current directory, or the file passed with `--config`. All keys are optional.

```json
{
  "exclude": ["/api/**"],
  "budget": {
    "metric": "compressed",
    "maxIncrease": "30kb",
    "maxIncreasePercent": 10,
    "maxSize": "300kb",
    "overrides": [
      { "match": "/dashboard", "maxSize": "450kb" },
      { "match": "/blog/**", "maxIncrease": "10kb", "maxIncreasePercent": 5 }
    ]
  }
}
```

- `exclude`: glob patterns ([picomatch](https://github.com/micromatch/picomatch)) matched against the route. Default `[]`.
- `budget.metric`: `"compressed"` (gzip, default) or `"raw"` (uncompressed bytes from the stats file).
- `budget.maxIncrease`: a byte count, or a string such as `"30kb"`, `"1.5mb"`, `"512b"`. Default `"30kb"`.
- `budget.maxIncreasePercent`: a non-negative number. Default `10`.
- `budget.maxSize`: the largest size a route may have, in the same format as `maxIncrease`. Not set by default.
- `budget.overrides`: limits for specific routes. Default `[]`.

A route fails when its size grows by at least `maxIncrease` bytes or at least `maxIncreasePercent` percent, whichever comes first. `maxIncreasePercent: 0` means any growth fails. To rely on one threshold only, set the other one high.

With `maxSize` set, a route also fails when its size is above `maxSize`. This check needs no baseline, so it also applies to new routes and to a run without `--baseline`.

Each entry in `overrides` has a `match` glob and any of `maxIncrease`, `maxIncreasePercent` and `maxSize`; keys that the entry leaves out keep the value from `budget`. A route uses the first entry whose `match` fits it, so put specific routes such as `/blog/[slug]` above broad globs such as `/blog/**`. `metric` is the same for all routes. `diff` prints a warning for an entry that matches no route.

Square brackets are literal, so `/blog/[slug]` matches only the dynamic route `/blog/[slug]`.

Sizes use 1024-byte units: `"30kb"` is 30,720 bytes and the report prints it as `30 KiB`. `kib` and `mib` are accepted as the same units.

Unknown keys are an error, so a typo such as `"excludes"` does not silently turn off filtering. A missing default config file means defaults are used. A missing file passed with `--config` is an error.

## Output

The samples below use the example config above.

Terminal (`--format terminal`, the default):

```text
┌──────────────┬──────────┬────────────┬───────────────────────┬──────────┐
│ Route        │ Baseline │    Current │               Δ bytes │ Δ chunks │
├──────────────┼──────────┼────────────┼───────────────────────┼──────────┤
│ /onboarding  │    (new) │ 318 KiB 🔴 │        +318 KiB (new) │       +5 │
│ /dashboard   │  255 KiB │    292 KiB │ +37.1 KiB (+14.5%) 🔴 │       +1 │
│ /settings    │  185 KiB │  (removed) │              -185 KiB │       -6 │
│ /pricing     │  166 KiB │    148 KiB │ -17.9 KiB (-10.8%) 🟢 │       -1 │
│ /            │  161 KiB │    162 KiB │        +470 B (+0.3%) │        — │
│ /blog/[slug] │  157 KiB │    157 KiB │                     — │        — │
│ /_not-found  │  138 KiB │    138 KiB │                     — │        — │
└──────────────┴──────────┴────────────┴───────────────────────┴──────────┘
Avg per route: 177 KiB → 203 KiB
🔴 grew by at least 30 KiB or 10%, or is larger than 300 KiB (compressed; some routes have their own limits)   🟢 notable improvement   7 route(s)
Bundle size budget exceeded for 2 route(s): /onboarding (max size 300 KiB), /dashboard (limit +30 KiB or +10%)
```

The last line goes to stderr. Under GitHub Actions it starts with `::error::`, and GitHub shows it as an annotation.

Markdown (`--format markdown`):

```markdown
## Bundle size

| Route          | First Load JS | Δ                     |
| -------------- | ------------- | --------------------- |
| `/onboarding`  | 318 KiB 🔴    | +318 KiB (new)        |
| `/dashboard`   | 292 KiB       | +37.1 KiB (+14.5%) 🔴 |
| `/settings`    | — (removed)   | -185 KiB              |
| `/pricing`     | 148 KiB       | -17.9 KiB (-10.8%) 🟢 |
| `/`            | 162 KiB       | +470 B (+0.3%)        |
| `/blog/[slug]` | 157 KiB       | —                     |
| `/_not-found`  | 138 KiB       | —                     |

### Summary

- **Routes:** 7
- **Avg per route:** 177 KiB → 203 KiB

🔴 grew by at least 30 KiB or 10%, or is larger than 300 KiB (compressed; some routes have their own limits) · 🟢 notable improvement
```

How to read it:

- Sizes and deltas use the budget metric. Failing routes come first, then the rest by the size of the change.
- 🔴 on the Δ cell means the route grew past `maxIncrease` or `maxIncreasePercent`. 🔴 on the size cell means the route is larger than its `maxSize`.
- 🟢 marks a route that shrank by at least the budget.
- A change under 250 B shows as `—`, unless the route failed the growth rule.
- New routes are marked `(new)`. They never fail the growth rule, but they can fail `maxSize`, as `/onboarding` does here. Removed routes never fail.

Without a baseline, `diff` prints the current routes only and checks only `maxSize`. Sizes use the budget metric, or raw bytes when the input is a raw stats file. This table goes to the step summary or stdout for both formats:

```markdown
## Bundle size

Baseline not yet established. 6 route(s) captured. Sizes are compressed.

| Route          | First Load JS |
| -------------- | ------------- |
| `/onboarding`  | 318 KiB 🔴    |
| `/dashboard`   | 292 KiB       |
| `/`            | 162 KiB       |
| `/blog/[slug]` | 157 KiB       |
| `/pricing`     | 148 KiB       |
| `/_not-found`  | 138 KiB       |

🔴 larger than its max size
```

Here `/onboarding` is above `maxSize`, so this run exits `1`.

## Exit codes

- `0`: no route failed. This includes a run without a baseline, or with a `--baseline` path that does not exist, unless a route is above `maxSize`.
- `1`: at least one route failed, or any error: bad config, unreadable input, missing chunk files.

## Limitations

- The stats file `route-bundle-stats.json` has no official docs and no stability promise. A Next.js release can change it, so this package stays on 0.x.
- Turbopack only. `next build --webpack` writes no stats file.
- The default `--stats` path assumes the default `distDir` (`.next`). With a custom `distDir`, pass `--stats <app-dir>/<distDir>/diagnostics/route-bundle-stats.json`. The GitHub Action assumes the default.
- Only first-load JS is measured.
- App-router route handlers (`route.ts`) and middleware/proxy are not in the stats file. Pages-router `/api/*` entries carry only the `_app` chunks.

## Development

```bash
npm test
npm run types
```

- `fixtures/sample-build/` is a small synthetic stats file. The CLI tests and the CI smoke run use it.
- `fixtures/next-app/` is a real Next.js app. `.github/workflows/action-test.yml` builds it to test the action: a run without changes must pass, and a run that adds a lodash import to the home page must fail.

To release, create a GitHub release with the tag `v<version in package.json>`. `release.yml` then publishes to npm with trusted publishing and moves the major tag (`v0`).

## License

MIT
