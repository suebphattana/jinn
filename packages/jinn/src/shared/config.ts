import fs from "node:fs";
import yaml from "js-yaml";
import { CONFIG_PATH } from "./paths.js";
import type { JinnConfig } from "./types.js";

type ClaudeEngineConfig = JinnConfig["engines"]["claude"];

export interface ConnectorInstanceSpec {
  id: string;
  type: string;
  employee?: string;
  [key: string]: unknown;
}

/**
 * Unify the two ways connectors can be configured into a single instance list:
 *   1. `connectors.instances` — the explicit array.
 *   2. `connectors.<type>` top-level blocks (discord/telegram/slack/whatsapp) —
 *      what the settings UI writes. Synthesized as an instance with id = type.
 *
 * Explicit instances win on id collision. This lets the gateway start/reload a
 * connector regardless of which shape it was saved in, so adding one through the
 * web UI takes effect on reload without a full restart.
 */
export function effectiveConnectorInstances(config: JinnConfig): ConnectorInstanceSpec[] {
  const out: ConnectorInstanceSpec[] = [];
  const seen = new Set<string>();

  const connectors = (config.connectors ?? {}) as Record<string, any>;

  for (const inst of connectors.instances ?? []) {
    if (inst?.id && inst?.type) {
      out.push(inst as ConnectorInstanceSpec);
      seen.add(inst.id);
    }
  }

  for (const type of ["discord", "telegram", "slack", "whatsapp"] as const) {
    const block = connectors[type];
    if (!block || typeof block !== "object" || seen.has(type)) continue;
    // Require credentials so an empty UI block (e.g. {botToken:''}) is ignored.
    const hasCreds =
      (typeof block.botToken === "string" && block.botToken.length > 0) ||
      (typeof block.appToken === "string" && block.appToken.length > 0) ||
      type === "whatsapp"; // whatsapp authenticates via QR, no token
    if (!hasCreds) continue;
    out.push({ ...block, id: type, type });
    seen.add(type);
  }

  return out;
}

export function normalizeClaudeEngineConfig(raw: ClaudeEngineConfig): Required<Pick<ClaudeEngineConfig, "maxLivePtys">> & ClaudeEngineConfig {
  return {
    ...raw,
    maxLivePtys: raw.maxLivePtys ?? 8,
  };
}

/**
 * Lightweight shape validation for a parsed config.yaml. Returns a list of
 * problems (empty = valid). Deliberately minimal: only the fields whose
 * absence/wrong type would crash the gateway at startup are checked, so
 * configs that rely on downstream defaults keep working.
 */
export function validateConfigShape(config: unknown): string[] {
  if (config === null || config === undefined) {
    return ["file is empty or parsed to null — expected a YAML mapping"];
  }
  if (typeof config !== "object" || Array.isArray(config)) {
    return [`expected a YAML mapping, got ${Array.isArray(config) ? "an array" : typeof config}`];
  }

  const problems: string[] = [];
  const c = config as Record<string, any>;

  if (c.gateway !== undefined) {
    if (typeof c.gateway !== "object" || c.gateway === null || Array.isArray(c.gateway)) {
      problems.push("gateway must be a mapping");
    } else {
      if (c.gateway.port !== undefined && typeof c.gateway.port !== "number") {
        problems.push(`gateway.port must be a number (got ${typeof c.gateway.port})`);
      }
      if (c.gateway.host !== undefined && typeof c.gateway.host !== "string") {
        problems.push(`gateway.host must be a string (got ${typeof c.gateway.host})`);
      }
      if (c.gateway.allowFileCustomPaths !== undefined && typeof c.gateway.allowFileCustomPaths !== "boolean") {
        problems.push(`gateway.allowFileCustomPaths must be a boolean (got ${typeof c.gateway.allowFileCustomPaths})`);
      }
      if (c.gateway.allowFileOpen !== undefined && typeof c.gateway.allowFileOpen !== "boolean") {
        problems.push(`gateway.allowFileOpen must be a boolean (got ${typeof c.gateway.allowFileOpen})`);
      }
    }
  }

  if (typeof c.engines !== "object" || c.engines === null || Array.isArray(c.engines)) {
    problems.push("engines must be a mapping with at least an engines.claude entry");
  } else {
    if (c.engines.default !== undefined && typeof c.engines.default !== "string") {
      problems.push("engines.default must be a string");
    }
    if (typeof c.engines.claude !== "object" || c.engines.claude === null || Array.isArray(c.engines.claude)) {
      problems.push("engines.claude must be a mapping");
    }
  }

  return problems;
}

export function loadConfig(): JinnConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `Jinn config not found at ${CONFIG_PATH}. Run "jinn setup" first.`
    );
  }
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new Error(`Invalid YAML in ${CONFIG_PATH}: ${(err as Error).message}`);
  }
  const problems = validateConfigShape(parsed);
  if (problems.length > 0) {
    throw new Error(
      `Invalid config at ${CONFIG_PATH}:\n  - ${problems.join("\n  - ")}`
    );
  }
  const config = parsed as JinnConfig;
  config.engines.claude = normalizeClaudeEngineConfig(config.engines.claude);
  return config;
}

/**
 * Atomically persist a config object to config.yaml. The live gateway
 * hot-reloads config.yaml via a file watcher, so a torn write would be
 * consumed mid-write — write to a tmp file in the same directory, then rename.
 * `dumpOptions` is forwarded to yaml.dump so call sites keep their formatting.
 */
export function saveConfigAtomic(config: unknown, dumpOptions?: yaml.DumpOptions): void {
  const tmpPath = `${CONFIG_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, yaml.dump(config, dumpOptions), "utf-8");
  fs.renameSync(tmpPath, CONFIG_PATH);
}
