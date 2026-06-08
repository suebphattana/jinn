import type { SpawnOptionsWithStdioTuple, StdioPipe } from "node:child_process";

type PipeSpawnOptions = SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioPipe>;

/**
 * Build the `spawn(...)` options shared by the Codex and Pi engines.
 *
 * - POSIX (darwin/linux): `shell:false` + `detached:true` — unchanged behavior;
 *   the CLI binary is launched directly and detached so we can signal the group.
 * - Windows (`win32`): `shell:true` + `detached:false` — bare-name CLIs like
 *   `codex` / `pi` resolve to `.cmd`/`.bat` shims that Node can only launch
 *   through a shell. Detaching is a POSIX process-group concept, so it's off.
 *
 * `platform` is a parameter (not read from `process.platform`) so the behavior
 * is unit-testable on any host OS. Args arrays are still passed through to Node;
 * with `shell:true` on win32 Node handles arg quoting, matching other Node CLIs.
 */
export function buildSpawnOptions(
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): PipeSpawnOptions {
  return {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: platform !== "win32",
    shell: platform === "win32",
  };
}
