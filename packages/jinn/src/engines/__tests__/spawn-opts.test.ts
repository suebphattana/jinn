import { describe, it, expect } from "vitest";
import { buildSpawnOptions } from "../spawn-opts.js";

describe("buildSpawnOptions", () => {
  const cwd = "/tmp/work";
  const env = { FOO: "bar" };

  it("uses shell:false and detached:true on darwin (POSIX unchanged)", () => {
    const opts = buildSpawnOptions(cwd, env, "darwin");
    expect(opts).toEqual({
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      shell: false,
    });
  });

  it("uses shell:false and detached:true on linux (POSIX unchanged)", () => {
    const opts = buildSpawnOptions(cwd, env, "linux");
    expect(opts.shell).toBe(false);
    expect(opts.detached).toBe(true);
  });

  it("uses shell:true and detached:false on win32", () => {
    const opts = buildSpawnOptions(cwd, env, "win32");
    expect(opts.shell).toBe(true);
    expect(opts.detached).toBe(false);
  });

  it("preserves cwd, env and stdio verbatim", () => {
    const opts = buildSpawnOptions(cwd, env, "win32");
    expect(opts.cwd).toBe(cwd);
    expect(opts.env).toBe(env);
    expect(opts.stdio).toEqual(["pipe", "pipe", "pipe"]);
  });
});
