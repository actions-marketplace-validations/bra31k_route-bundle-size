import * as fs from "node:fs";
import * as path from "node:path";

export const CONFIG_FILE_NAME = "route-bundle-size.config.json";

export const METRICS = ["raw", "compressed"] as const;
export type Metric = (typeof METRICS)[number];

export type Limits = {
  maxIncrease: number;
  maxIncreasePercent: number;
  maxSize: number | null;
};

export type Override = Partial<Limits> & { match: string };

export type Budget = Limits & {
  metric: Metric;
  overrides: Override[];
};

export type Config = {
  exclude: string[];
  budget: Budget;
};

export const DEFAULT_CONFIG: Config = {
  exclude: [],
  budget: {
    metric: "compressed",
    maxIncrease: 30 * 1024,
    maxIncreasePercent: 10,
    maxSize: null,
    overrides: [],
  },
};

const BYTE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  kib: 1024,
  mb: 1024 * 1024,
  mib: 1024 * 1024,
};
const BYTE_SIZE_PATTERN = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib)?\s*$/i;

export const parseByteSize = (value: unknown, field: string): number => {
  const numeric = typeof value === "number" ? value : Number.NaN;
  const match =
    typeof value === "string" ? BYTE_SIZE_PATTERN.exec(value) : null;
  const rounded = Math.round(
    match === null
      ? numeric
      : Number(match[1]) * BYTE_UNITS[(match[2] ?? "b").toLowerCase()],
  );

  if (!Number.isSafeInteger(rounded) || rounded < 0) {
    throw new Error(
      `Invalid ${field}: ${JSON.stringify(value)}. Expected a byte count or a size string like "30kb", "1.5mb", "512b".`,
    );
  }

  return rounded;
};

const asObject = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected a JSON object.`);
  }

  return { ...value };
};

const assertKnownKeys = (value: object, validKeys: string[], where: string) => {
  for (const key of Object.keys(value)) {
    if (!validKeys.includes(key)) {
      throw new Error(
        `Unknown key "${key}" in ${where}. Valid keys: ${validKeys.join(", ")}.`,
      );
    }
  }
};

const parsePercent = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(
      `Invalid ${field}: ${JSON.stringify(value)}. Expected a non-negative number.`,
    );
  }

  return value;
};

const OVERRIDE_KEYS = ["match", "maxIncrease", "maxIncreasePercent", "maxSize"];

const parseOverride = (
  value: unknown,
  index: number,
  source: string,
): Override => {
  const label = (key: string) =>
    `"budget.overrides[${index}]${key}" in ${source}`;
  const raw = asObject(value, label(""));
  assertKnownKeys(raw, OVERRIDE_KEYS, label(""));

  if (typeof raw.match !== "string" || raw.match === "") {
    throw new Error(
      `Invalid ${label(".match")}: ${JSON.stringify(raw.match)}. Expected a glob pattern.`,
    );
  }

  const override: Override = { match: raw.match };

  if (raw.maxIncrease !== undefined) {
    override.maxIncrease = parseByteSize(
      raw.maxIncrease,
      label(".maxIncrease"),
    );
  }

  if (raw.maxIncreasePercent !== undefined) {
    override.maxIncreasePercent = parsePercent(
      raw.maxIncreasePercent,
      label(".maxIncreasePercent"),
    );
  }

  if (raw.maxSize !== undefined) {
    override.maxSize = parseByteSize(raw.maxSize, label(".maxSize"));
  }

  return override;
};

export const parseConfig = (value: unknown, source: string): Config => {
  const raw = asObject(value, `config in ${source}`);
  assertKnownKeys(raw, Object.keys(DEFAULT_CONFIG), source);

  const { exclude, budget: budgetValue }: Record<string, unknown> = {
    ...DEFAULT_CONFIG,
    budget: {},
    ...raw,
  };

  if (
    !Array.isArray(exclude) ||
    !exclude.every((item): item is string => typeof item === "string")
  ) {
    throw new Error(
      `Invalid "exclude" in ${source}: expected an array of glob patterns.`,
    );
  }

  const budgetSource = `"budget" in ${source}`;
  const budgetRaw = asObject(budgetValue, budgetSource);
  assertKnownKeys(budgetRaw, Object.keys(DEFAULT_CONFIG.budget), budgetSource);

  const {
    metric: metricValue,
    maxIncrease: maxIncreaseValue,
    maxIncreasePercent: maxIncreasePercentValue,
    overrides: overridesValue,
  }: Record<string, unknown> = { ...DEFAULT_CONFIG.budget, ...budgetRaw };

  const metric = METRICS.find((known) => known === metricValue);

  if (metric === undefined) {
    throw new Error(
      `Invalid "budget.metric" in ${source}: ${JSON.stringify(metricValue)}. Valid values: ${METRICS.join(", ")}.`,
    );
  }

  const maxIncreasePercent = parsePercent(
    maxIncreasePercentValue,
    `"budget.maxIncreasePercent" in ${source}`,
  );

  const maxIncrease = parseByteSize(
    maxIncreaseValue,
    `"budget.maxIncrease" in ${source}`,
  );

  const maxSize =
    budgetRaw.maxSize === undefined
      ? null
      : parseByteSize(budgetRaw.maxSize, `"budget.maxSize" in ${source}`);

  if (!Array.isArray(overridesValue)) {
    throw new Error(
      `Invalid "budget.overrides" in ${source}: expected an array of objects.`,
    );
  }

  const overrides = overridesValue.map((override, index) =>
    parseOverride(override, index, source),
  );

  return {
    exclude,
    budget: { metric, maxIncrease, maxIncreasePercent, maxSize, overrides },
  };
};

export const loadConfig = (options: {
  configPath?: string;
  cwd?: string;
}): Config => {
  const cwd = options.cwd ?? process.cwd();
  const filePath = path.resolve(cwd, options.configPath ?? CONFIG_FILE_NAME);

  if (!fs.existsSync(filePath)) {
    if (options.configPath === undefined) {
      return DEFAULT_CONFIG;
    }

    throw new Error(`Config file not found: ${filePath}`);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return parseConfig(parsed, filePath);
};
