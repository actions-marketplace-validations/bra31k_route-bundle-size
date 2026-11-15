# route-bundle-size

Per-route first-load JS budget for Next.js Turbopack builds.

It reads the route stats that `next build` writes to `.next/diagnostics/route-bundle-stats.json`, measures the gzip size of each route's first-load JS, and compares it with a baseline build. A route fails when it grows past the budget or goes over its size limit.

Requires Next.js 16.2+ with Turbopack (the default for `next build`) and Node.js 22.12+.

## Usage

```bash
# At the baseline commit
npx next build
npx route-bundle-size measure --out /tmp/baseline.json

# At the commit you want to check
npx next build
npx route-bundle-size measure --out /tmp/current.json

npx route-bundle-size diff --current /tmp/current.json --baseline /tmp/baseline.json
```

`diff` prints a table and exits `1` when a route is over budget. With the [example config](#config):

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

Sizes use the budget metric. Failing routes come first, then the rest by the size of the change. 🔴 on the Δ cell means the route broke the growth rule, and 🔴 on the size cell means it is larger than its `maxSize`. 🟢 means the route shrank by at least the budget. Changes under 250 B show as `—` unless the route failed. New routes never fail the growth rule, and removed routes never fail.

In a monorepo, build the app and point `--app-dir` at it, for example `--app-dir apps/web`.

In CI, build and measure the merge base and the head with the same CLI version, delete the old stats file before each build, then run `diff` at the head. On GitHub, the [GitHub Action](#github-action) does all of this in one step.

## Config

All keys are optional.

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

Each entry in `overrides` has a `match` glob and any of `maxIncrease`, `maxIncreasePercent` and `maxSize`; keys that the entry leaves out keep the value from `budget`. A route uses the first entry whose `match` fits it, so put specific routes such as `/blog/[slug]` (brackets are literal) above broad globs such as `/blog/**`. `metric` is the same for all routes. `diff` prints a warning for an entry that matches no route.

Sizes use 1024-byte units: `"30kb"` is 30,720 bytes and the report prints it as `30 KiB`. `kib` and `mib` are accepted as the same units.

Unknown keys are an error, so a typo such as `"excludes"` does not silently turn off filtering. A missing file passed with `--config` is an error.

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

It writes a snapshot:

```json
{ "schemaVersion": 1, "routes": [{ "route": "/", "rawBytes": 65000, "compressedBytes": 49276, "chunkPaths": ["..."] }] }
```

It fails if a chunk file is missing under `--app-dir`, or if a route lists first-load bytes but no chunk paths, instead of counting it as zero.

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
- `--baseline`: the snapshot to compare with. Without it, `diff` shows only the current sizes (see the example below). If the file does not exist, `diff` prints a warning and works as if no baseline was given.
- `--format`: `terminal` (default) prints a table to stdout. `markdown` writes a GitHub-flavored table to the file in `$GITHUB_STEP_SUMMARY`, or to stdout when that variable is not set.
- `--config`: path to the config file. Default: `route-bundle-size.config.json` in the current directory, if it exists.
- `--no-exclude`: ignore the `exclude` patterns from the config.

Both inputs can be a `measure` snapshot or a raw `route-bundle-stats.json`. A raw stats file has no gzip sizes, so with `metric: "compressed"` it is an error to compare it or check it against `maxSize`. Without a baseline and without `maxSize`, `diff` shows its raw sizes instead. Use `measure` snapshots, or set `metric` to `"raw"`.

`--no-exclude` helps find shared-chunk growth: pages-router `/api/*` entries carry only the `_app` chunks, which is why the example config excludes them.

With `--format markdown`, the same diff looks like this in the GitHub job summary:

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

Without a baseline, `diff` prints the current routes only and checks only `maxSize`. For both formats it writes this markdown table:

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

Exit codes:

- `0`: no route failed.
- `1`: a route failed, or an error occurred (bad config, unreadable input, missing chunk files).

## GitHub Action

The action builds the PR head and its merge base in one job, so commits that land on the base branch later never count against the PR. Each run costs a second build. It writes the result to the job summary, posts no PR comment and needs only `contents: read`, so it works for PRs from forks.

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
          ref: ${{ github.event.pull_request.head.sha }} # build the PR head, not GitHub's merge commit
          fetch-depth: 0 # needed to find the merge base
          persist-credentials: false

      - uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: npm

      - uses: bra31k/route-bundle-size@v0
```

Inputs, all optional:

- `app-dir`: the Next.js app directory. Default `.`. The config file is read from `app-dir` at the PR head.
- `install-command`: installs the dependencies. Default `npm ci`.
- `build-command`: builds the app. Default `npx next build`.
- `base`: the git ref to compare with. Default `origin/<base branch of the PR>`. Set it for events that are not pull requests, such as `push`.
- `package`: the npm spec of the CLI. Default: `route-bundle-size` at the action's own version.

Output:

- `report`: the path to the markdown report.

With pnpm, yarn or bun, set up the package manager before `setup-node`, set `install-command` (for example `pnpm install --frozen-lockfile`), and make the `cache:` value of `setup-node` match your lockfile or remove it. `@v0` moves with each 0.x release; to pin an exact version, use `@v0.2.1`.

The job summary shows the markdown report described under [`diff`](#diff).

## Limitations

- `next build --webpack` writes no stats file.
- The stats file has no official docs and no stability promise. A Next.js release can change it, so this package stays on 0.x.
- Only first-load JS is measured. App-router route handlers (`route.ts`) and middleware/proxy are not in the stats file.
- With a custom `distDir`, pass `--stats <app-dir>/<distDir>/diagnostics/route-bundle-stats.json` to `measure`. The GitHub Action assumes `.next`.

## Development

```bash
npm test
npm run types
```

See [AGENTS.md](AGENTS.md) for the repo layout, the fixtures and the release process.

## License

MIT
