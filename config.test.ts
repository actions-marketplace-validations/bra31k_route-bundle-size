import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "@jest/globals";

import {
  CONFIG_FILE_NAME,
  DEFAULT_CONFIG,
  loadConfig,
  parseByteSize,
  parseConfig,
} from "./src/config";

const created: string[] = [];

const makeTree = (config?: unknown): { root: string } => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "route-bundle-size-config-"),
  );
  created.push(root);

  if (config !== undefined) {
    fs.writeFileSync(
      path.join(root, CONFIG_FILE_NAME),
      JSON.stringify(config, null, 2),
    );
  }

  return { root };
};

afterEach(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseByteSize", () => {
  it("accepts size strings with binary units", () => {
    expect(parseByteSize("30kb", "maxIncrease")).toBe(30_720);
    expect(parseByteSize("50kb", "maxIncrease")).toBe(51_200);
    expect(parseByteSize("1.5mb", "maxIncrease")).toBe(1_572_864);
    expect(parseByteSize("512b", "maxIncrease")).toBe(512);
    expect(parseByteSize("2MB", "maxIncrease")).toBe(2_097_152);
  });

  it("accepts kib and mib as the same units as kb and mb", () => {
    expect(parseByteSize("30kib", "maxIncrease")).toBe(30_720);
    expect(parseByteSize("30 KiB", "maxIncrease")).toBe(30_720);
    expect(parseByteSize("1.5mib", "maxIncrease")).toBe(1_572_864);
    expect(parseByteSize("2MiB", "maxIncrease")).toBe(2_097_152);
  });

  it("accepts a plain byte count", () => {
    expect(parseByteSize(51_200, "maxIncrease")).toBe(51_200);
    expect(parseByteSize("4096", "maxIncrease")).toBe(4096);
  });

  it("rounds a fractional size to the nearest byte", () => {
    expect(parseByteSize("1.1kb", "maxIncrease")).toBe(1126);
    expect(parseByteSize(1126.4, "maxIncrease")).toBe(1126);
  });

  it("rejects a size string that overflows to Infinity", () => {
    expect(() => parseByteSize(`${"9".repeat(400)}kb`, "maxIncrease")).toThrow(
      /Invalid maxIncrease/,
    );
  });

  it("rejects a size string beyond the safe integer range", () => {
    expect(() => parseByteSize("9007199254740993b", "maxIncrease")).toThrow(
      /Invalid maxIncrease/,
    );
  });

  it("throws quoting the offending input", () => {
    expect(() => parseByteSize("30 kilobytes", "maxIncrease")).toThrow(
      /"30 kilobytes"/,
    );
    expect(() => parseByteSize(-1, "maxIncrease")).toThrow(/-1/);
    expect(() => parseByteSize(null, "maxIncrease")).toThrow(/null/);
  });
});

describe("parseConfig", () => {
  it("fills defaults for absent keys", () => {
    expect(parseConfig({}, "cfg.json")).toEqual(DEFAULT_CONFIG);
    expect(parseConfig({}, "cfg.json").exclude).toEqual([]);
    expect(parseConfig({}, "cfg.json").budget).toEqual({
      metric: "compressed",
      maxIncrease: 30_720,
      maxIncreasePercent: 10,
      maxSize: null,
      overrides: [],
    });
  });

  it("parses a full config", () => {
    expect(
      parseConfig(
        {
          exclude: ["/api/**"],
          budget: {
            metric: "raw",
            maxIncrease: "50kb",
            maxIncreasePercent: 5,
          },
        },
        "cfg.json",
      ),
    ).toEqual({
      exclude: ["/api/**"],
      budget: {
        metric: "raw",
        maxIncrease: 51_200,
        maxIncreasePercent: 5,
        maxSize: null,
        overrides: [],
      },
    });
  });

  it("parses a 0.1.0 config without the new keys", () => {
    expect(
      parseConfig(
        { budget: { maxIncrease: "10kb", maxIncreasePercent: 5 } },
        "cfg.json",
      ).budget,
    ).toEqual({
      metric: "compressed",
      maxIncrease: 10_240,
      maxIncreasePercent: 5,
      maxSize: null,
      overrides: [],
    });
  });

  it("leaves maxSize off and overrides empty by default", () => {
    const { budget } = parseConfig({ budget: { metric: "raw" } }, "cfg.json");
    expect(budget.maxSize).toBeNull();
    expect(budget.overrides).toEqual([]);
  });

  it("parses maxSize as a byte size", () => {
    expect(
      parseConfig({ budget: { maxSize: "300kib" } }, "cfg.json").budget.maxSize,
    ).toBe(307_200);
    expect(
      parseConfig({ budget: { maxSize: 4096 } }, "cfg.json").budget.maxSize,
    ).toBe(4096);
  });

  it("rejects a null maxSize", () => {
    expect(() =>
      parseConfig({ budget: { maxSize: null } }, "cfg.json"),
    ).toThrow(/Invalid "budget\.maxSize" in cfg\.json: null/);
    expect(() =>
      parseConfig(
        { budget: { overrides: [{ match: "/", maxSize: null }] } },
        "cfg.json",
      ),
    ).toThrow(/Invalid "budget\.overrides\[0\]\.maxSize" in cfg\.json: null/);
  });

  it("parses overrides and keeps only the keys each entry sets", () => {
    const { budget } = parseConfig(
      {
        budget: {
          overrides: [
            { match: "/editor", maxSize: "450kb" },
            { match: "/blog/**", maxIncrease: "5kb", maxIncreasePercent: 20 },
            { match: "/" },
          ],
        },
      },
      "cfg.json",
    );

    expect(budget.overrides).toStrictEqual([
      { match: "/editor", maxSize: 460_800 },
      { match: "/blog/**", maxIncrease: 5_120, maxIncreasePercent: 20 },
      { match: "/" },
    ]);
  });

  it("rejects an override without match", () => {
    expect(() =>
      parseConfig({ budget: { overrides: [{ maxSize: 1 }] } }, "cfg.json"),
    ).toThrow(/Invalid "budget\.overrides\[0\]\.match" in cfg\.json/);
    expect(() =>
      parseConfig({ budget: { overrides: [{ match: "" }] } }, "cfg.json"),
    ).toThrow(/Invalid "budget\.overrides\[0\]\.match" in cfg\.json/);
  });

  it("rejects an unknown key inside an override and names its index", () => {
    expect(() =>
      parseConfig(
        { budget: { overrides: [{ match: "/" }, { match: "/a", max: 1 }] } },
        "cfg.json",
      ),
    ).toThrow(
      /Unknown key "max" in "budget\.overrides\[1\]" in cfg\.json\. Valid keys: match, maxIncrease, maxIncreasePercent, maxSize\./,
    );
  });

  it("rejects metric inside an override", () => {
    expect(() =>
      parseConfig(
        { budget: { overrides: [{ match: "/", metric: "raw" }] } },
        "cfg.json",
      ),
    ).toThrow(/Unknown key "metric" in "budget\.overrides\[0\]"/);
  });

  it("rejects overrides that is not an array", () => {
    expect(() =>
      parseConfig({ budget: { overrides: { match: "/" } } }, "cfg.json"),
    ).toThrow(/Invalid "budget\.overrides" in cfg\.json: expected an array/);
    expect(() =>
      parseConfig({ budget: { overrides: ["/"] } }, "cfg.json"),
    ).toThrow(/Invalid "budget\.overrides\[0\]" in cfg\.json/);
  });

  it("rejects an unknown top-level key, listing the valid set", () => {
    expect(() => parseConfig({ excludes: ["/api/**"] }, "cfg.json")).toThrow(
      /Unknown key "excludes" in cfg\.json\. Valid keys: exclude, budget\./,
    );
  });

  it("rejects an unknown budget key, listing the valid set", () => {
    expect(() =>
      parseConfig({ budget: { maxIncreaseBytes: 10 } }, "cfg.json"),
    ).toThrow(
      /Unknown key "maxIncreaseBytes" in "budget" in cfg\.json\. Valid keys: metric, maxIncrease, maxIncreasePercent, maxSize, overrides\./,
    );
  });

  it("rejects an invalid metric", () => {
    expect(() =>
      parseConfig({ budget: { metric: "gzip" } }, "cfg.json"),
    ).toThrow(/"gzip"[\s\S]*raw, compressed/);
  });

  it("rejects a non-array exclude", () => {
    expect(() => parseConfig({ exclude: "/api/**" }, "cfg.json")).toThrow(
      /"exclude".*array of glob patterns/,
    );
  });
});

describe("config discovery", () => {
  it("reads the config file in cwd", () => {
    const { root } = makeTree({ budget: { metric: "raw" } });
    expect(loadConfig({ cwd: root }).budget.metric).toBe("raw");
  });

  it("falls back to defaults when cwd has no config", () => {
    const { root } = makeTree();
    expect(loadConfig({ cwd: root })).toEqual(DEFAULT_CONFIG);
  });

  it("uses --config over the file in cwd", () => {
    const { root } = makeTree({ budget: { metric: "raw" } });
    const override = path.join(root, "override.json");
    fs.writeFileSync(
      override,
      JSON.stringify({ exclude: ["/x/**"], budget: { maxIncrease: "1kb" } }),
    );

    const config = loadConfig({ configPath: override, cwd: root });
    expect(config.exclude).toEqual(["/x/**"]);
    expect(config.budget.maxIncrease).toBe(1024);
    expect(config.budget.metric).toBe("compressed");
  });

  it("refuses a config whose budget.maxIncrease overflows", () => {
    const { root } = makeTree();
    const overflowing = path.join(root, "overflow.json");
    fs.writeFileSync(
      overflowing,
      JSON.stringify({ budget: { maxIncrease: `${"9".repeat(400)}kb` } }),
    );

    expect(() => loadConfig({ configPath: overflowing })).toThrow(
      /"budget\.maxIncrease"/,
    );
  });

  it("throws when --config points at a missing file", () => {
    const { root } = makeTree();
    expect(() =>
      loadConfig({ configPath: path.join(root, "nope.json") }),
    ).toThrow(/Config file not found/);
  });
});
