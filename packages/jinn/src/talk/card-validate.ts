/**
 * Jinn Talk — card validator.
 *
 * The cards surface lets any process (the orchestrator, a tool dispatcher, an
 * employee callback) push structured content to the /talk UI over the HTTP card
 * routes in routes.ts. Those routes accept untrusted JSON, so this is the gate:
 * `validateCard` rejects anything that isn't a well-formed `Card` from the
 * protocol union before it's broadcast over the WebSocket. Checks stay pragmatic
 * — enough to keep the renderer from choking on garbage, not a full schema.
 */
import type { Card } from "./protocol.js";

type Result = { ok: true; card: Card } | { ok: false; error: string };

const JOB_STATUSES = new Set(["queued", "running", "done", "error"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

export function validateCard(input: unknown): Result {
  if (!isObject(input)) return { ok: false, error: "card must be a non-null object" };

  const { id, type } = input;
  if (!isString(id) || id.length === 0) {
    return { ok: false, error: "card.id must be a non-empty string" };
  }

  // Optional common fields, if present, must be strings.
  if (input.title !== undefined && !isString(input.title)) {
    return { ok: false, error: "card.title must be a string" };
  }
  if (input.badge !== undefined && !isString(input.badge)) {
    return { ok: false, error: "card.badge must be a string" };
  }

  switch (type) {
    case "text":
      if (!isString(input.body)) return { ok: false, error: "text card requires string body" };
      break;

    case "stat":
      if (!isString(input.value)) return { ok: false, error: "stat card requires string value" };
      if (!isString(input.label)) return { ok: false, error: "stat card requires string label" };
      break;

    case "list": {
      if (!Array.isArray(input.items)) return { ok: false, error: "list card requires items array" };
      for (const item of input.items) {
        if (!isObject(item) || !isString(item.text)) {
          return { ok: false, error: "list card items must be objects with string text" };
        }
      }
      break;
    }

    case "image":
      if (!isString(input.src)) return { ok: false, error: "image card requires string src" };
      break;

    case "image-grid": {
      if (!Array.isArray(input.images)) return { ok: false, error: "image-grid card requires images array" };
      for (const img of input.images) {
        if (!isObject(img) || !isString(img.src)) {
          return { ok: false, error: "image-grid images must be objects with string src" };
        }
      }
      break;
    }

    case "status":
      if (!isString(input.label)) return { ok: false, error: "status card requires string label" };
      if (typeof input.progress !== "number") return { ok: false, error: "status card requires number progress" };
      if (!isString(input.state) || !JOB_STATUSES.has(input.state)) {
        return { ok: false, error: "status card requires state in queued|running|done|error" };
      }
      break;

    case "agent-activity": {
      if (!Array.isArray(input.agents)) return { ok: false, error: "agent-activity card requires agents array" };
      for (const agent of input.agents) {
        if (!isObject(agent)) {
          return { ok: false, error: "agent-activity agents must be objects" };
        }
        if (!isString(agent.id) || !isString(agent.name) || !isString(agent.role)) {
          return { ok: false, error: "agent-activity agents require string id, name, role" };
        }
        if (!isString(agent.status) || !JOB_STATUSES.has(agent.status)) {
          return { ok: false, error: "agent-activity agents require status in queued|running|done|error" };
        }
      }
      break;
    }

    case "link":
      if (!isString(input.url)) return { ok: false, error: "link card requires string url" };
      if (!isString(input.label)) return { ok: false, error: "link card requires string label" };
      break;

    case "choice": {
      if (!Array.isArray(input.options) || input.options.length === 0) {
        return { ok: false, error: "choice card requires a non-empty options array" };
      }
      for (const opt of input.options) {
        if (!isObject(opt) || !isString(opt.id) || opt.id.length === 0 || !isString(opt.label)) {
          return { ok: false, error: "choice options require non-empty string id and string label" };
        }
      }
      break;
    }

    case "comparison": {
      if (!Array.isArray(input.columns) || !input.columns.every(isString)) {
        return { ok: false, error: "comparison card requires a string columns array" };
      }
      if (!Array.isArray(input.rows)) {
        return { ok: false, error: "comparison card requires a rows array" };
      }
      for (const row of input.rows) {
        if (!isObject(row) || !isString(row.label) || !Array.isArray(row.cells) || !row.cells.every(isString)) {
          return { ok: false, error: "comparison rows require string label and string cells array" };
        }
      }
      break;
    }

    case "approval":
      if (!isString(input.summary)) return { ok: false, error: "approval card requires string summary" };
      break;

    case "keyvalue": {
      if (!Array.isArray(input.rows)) return { ok: false, error: "keyvalue card requires a rows array" };
      for (const row of input.rows) {
        if (!isObject(row) || !isString(row.k) || !isString(row.v)) {
          return { ok: false, error: "keyvalue rows require string k and v" };
        }
      }
      break;
    }

    case "diff": {
      if (!Array.isArray(input.hunks) || input.hunks.length === 0) {
        return { ok: false, error: "diff card requires a non-empty hunks array" };
      }
      for (const hunk of input.hunks) {
        if (!isObject(hunk)) return { ok: false, error: "diff hunks must be objects" };
      }
      break;
    }

    default:
      return { ok: false, error: `unknown card type: ${String(type)}` };
  }

  return { ok: true, card: input as unknown as Card };
}
