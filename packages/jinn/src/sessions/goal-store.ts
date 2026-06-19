/**
 * Per-session persistent goals (set via the `/goal` command).
 *
 * A goal is an ongoing objective the COO should keep working toward across
 * turns. It's stored file-backed (so it survives restarts) keyed by sessionKey,
 * and the session manager prepends a concise reminder to each turn's prompt
 * while a goal is set. `/goal clear` removes it.
 */
import fs from "node:fs";
import path from "node:path";
import { JINN_HOME } from "../shared/paths.js";

type GoalMap = Record<string, string>;

/** Resolved lazily so tests can point JINN_HOME at a temp dir. */
function goalsPath(): string {
  return path.join(process.env.JINN_HOME || JINN_HOME, "goals.json");
}

function load(): GoalMap {
  try {
    const obj = JSON.parse(fs.readFileSync(goalsPath(), "utf8"));
    return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as GoalMap) : {};
  } catch {
    return {};
  }
}

function save(map: GoalMap): void {
  const p = goalsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(map, null, 2));
}

/** Current goal for a session, or null if none set. */
export function getGoal(sessionKey: string): string | null {
  const goal = load()[sessionKey];
  return goal && goal.trim() ? goal : null;
}

/** Set (or replace) the goal for a session. */
export function setGoal(sessionKey: string, goal: string): void {
  const map = load();
  map[sessionKey] = goal.trim();
  save(map);
}

/** Clear a session's goal. Returns true if one existed. */
export function clearGoal(sessionKey: string): boolean {
  const map = load();
  if (!(sessionKey in map)) return false;
  delete map[sessionKey];
  save(map);
  return true;
}
