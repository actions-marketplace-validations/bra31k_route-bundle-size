import * as fs from "node:fs";
import * as path from "node:path";

export const CONFIG_FILE_NAME = "route-bundle-size.config.json";

export const METRICS = ["raw", "compressed"] as const;
export type Metric = (typeof METRICS)[number];

export type Budget = {
  metric: Metric;
  maxIncrease: number;
  maxIncreasePercent: number;
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
  },
};

const BYTE_UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 * 1024 };
const BYTE_SIZE_PATTERN = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb)?\s*$/i;

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

export const parseConfig = (value: unknown, source: string): Config => {
  const raw = asObject(value, `config in ${source}`);
  assertKnownKeys(raw, Object.keys(DEFAULT_CONFIG), source);

  const { exclude, budget: budgetValue }: Record<string, unknown> = {
    ...DEFAULT_CONFIG,
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
    maxIncreasePercent,
  }: Record<string, unknown> = { ...DEFAULT_CONFIG.budget, ...budgetRaw };

  const metric = METRICS.find((known) => known === metricValue);

  if (metric === undefined) {
    throw new Error(
      `Invalid "budget.metric" in ${source}: ${JSON.stringify(metricValue)}. Valid values: ${METRICS.join(", ")}.`,
    );
  }

  if (
    typeof maxIncreasePercent !== "number" ||
    !Number.isFinite(maxIncreasePercent) ||
    maxIncreasePercent < 0
  ) {
    throw new Error(
      `Invalid "budget.maxIncreasePercent" in ${source}: ${JSON.stringify(maxIncreasePercent)}. Expected a non-negative number.`,
    );
  }

  const maxIncrease = parseByteSize(
    maxIncreaseValue,
    `"budget.maxIncrease" in ${source}`,
  );

  return { exclude, budget: { metric, maxIncrease, maxIncreasePercent } };
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
