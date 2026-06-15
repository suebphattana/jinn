import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-files-sec-"));
process.env.JINN_HOME = tmpHome;

type Files = typeof import("../files.js");
type Paths = typeof import("../../shared/paths.js");

let files: Files;
let paths: Paths;

beforeAll(async () => {
  paths = await import("../../shared/paths.js");
  files = await import("../files.js");
});

describe("file upload side effects", () => {
  it("rejects custom upload paths outside managed storage", () => {
    expect(files.resolveCustomUploadPath("/tmp/owned.txt")).toBeNull();
    expect(files.resolveCustomUploadPath(path.join(paths.FILES_DIR, "..", "..", "owned.txt"))).toBeNull();
  });

  it("allows custom upload paths only inside managed storage roots", () => {
    const managed = path.join(paths.FILES_DIR, "custom", "note.txt");
    expect(files.resolveCustomUploadPath(managed)).toBe(path.resolve(managed));
  });

  it("keeps automatic file opening disabled unless explicitly opted in", () => {
    expect(files.allowUploadedFileOpen({ getConfig: () => ({ gateway: {} }) } as any)).toBe(false);
    expect(files.allowUploadedFileOpen({ getConfig: () => ({ gateway: { allowFileOpen: true } }) } as any)).toBe(true);
  });
});
