import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

// Point the DB at a throwaway dir BEFORE importing the registry (SESSIONS_DB is
// resolved from JINN_HOME at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-fts-"));
process.env.JINN_HOME = tmp;

type Reg = typeof import("../registry.js");
let reg: Reg;

let seq = 0;
function mkSession(reg: Reg, id: string): void {
  const db = reg.initDb();
  db.prepare(
    "INSERT INTO sessions (id, engine, source, source_ref, status, created_at, last_activity) VALUES (?, 'claude', 'web', ?, 'idle', 't', 't')",
  ).run(id, `web:${id}`);
}
// Insert a message with an explicit timestamp so newest-first ordering is
// deterministic (insertMessage uses Date.now(), which collides within a ms).
function mkMessage(reg: Reg, sessionId: string, role: string, content: string, ts: number): void {
  const db = reg.initDb();
  db.prepare(
    "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
  ).run(`m${seq++}`, sessionId, role, content, ts);
}

beforeAll(async () => {
  reg = await import("../registry.js");
  reg.initDb();
});

describe("searchMessages (FTS5)", () => {
  it("finds a word in an assistant message and highlights it with «»", () => {
    mkSession(reg, "s-find");
    mkMessage(reg, "s-find", "user", "how do I do this", 1000);
    mkMessage(reg, "s-find", "assistant", "you should use a quokka for that", 1001);

    const results = reg.searchMessages("quokka");
    expect(results.length).toBe(1);
    expect(results[0]).toMatchObject({ sessionId: "s-find", role: "assistant", timestamp: 1001 });
    expect(results[0].snippet).toContain("«quokka»");
  });

  it("does NOT index notification or tool rows", () => {
    mkSession(reg, "s-noise");
    mkMessage(reg, "s-noise", "notification", "antidisestablishmentarianism ping", 2000);
    mkMessage(reg, "s-noise", "tool", "antidisestablishmentarianism tool-output", 2001);

    expect(reg.searchMessages("antidisestablishmentarianism")).toEqual([]);
  });

  it("requires ALL words of a multi-word query (AND-ish)", () => {
    mkSession(reg, "s-and");
    mkMessage(reg, "s-and", "assistant", "the platypus swims in the river", 3000);
    mkMessage(reg, "s-and", "assistant", "the platypus is a mammal", 3001);

    // both words present in only the first message
    const both = reg.searchMessages("platypus river");
    expect(both.length).toBe(1);
    expect(both[0].timestamp).toBe(3000);

    // a word present in neither pins it to empty even though "platypus" matches
    expect(reg.searchMessages("platypus xylophone")).toEqual([]);
  });

  it("does not throw on special characters", () => {
    mkSession(reg, "s-special");
    mkMessage(reg, "s-special", "assistant", "please fix-up the urgent thing now", 4000);

    expect(() => reg.searchMessages('fix-up (urgent)')).not.toThrow();
    expect(() => reg.searchMessages('"quoted"')).not.toThrow();
    expect(() => reg.searchMessages("* AND ( NEAR")).not.toThrow();
    expect(() => reg.searchMessages('  "" ')).not.toThrow();

    // the sanitized phrase query still finds the row
    const r = reg.searchMessages("fix-up urgent");
    expect(r.length).toBe(1);
    expect(r[0].sessionId).toBe("s-special");
  });

  it("returns an empty array for a blank / operator-only query", () => {
    expect(reg.searchMessages("")).toEqual([]);
    expect(reg.searchMessages('   ')).toEqual([]);
    expect(reg.searchMessages('""')).toEqual([]);
  });

  it("orders newest-first and respects the limit", () => {
    mkSession(reg, "s-order");
    mkMessage(reg, "s-order", "assistant", "marmot sighting one", 5000);
    mkMessage(reg, "s-order", "assistant", "marmot sighting two", 5002);
    mkMessage(reg, "s-order", "assistant", "marmot sighting three", 5001);

    const all = reg.searchMessages("marmot");
    expect(all.map((r) => r.timestamp)).toEqual([5002, 5001, 5000]);

    const limited = reg.searchMessages("marmot", 2);
    expect(limited.map((r) => r.timestamp)).toEqual([5002, 5001]);
  });

  it("keeps the index in sync across the partial → update → final flow (indexes FINAL once)", () => {
    mkSession(reg, "s-partial");
    const id = reg.insertPartialMessage("s-partial", "assistant", "interim wombat draft", 0);
    // partial content is searchable mid-turn
    expect(reg.searchMessages("interim").map((r) => r.sessionId)).toContain("s-partial");

    reg.updatePartialMessage(id, "final wombat answer kerfuffle");

    // old partial text is gone, final text is found exactly once
    expect(reg.searchMessages("interim")).toEqual([]);
    const fin = reg.searchMessages("kerfuffle");
    expect(fin.length).toBe(1);
    expect(fin[0].sessionId).toBe("s-partial");
  });

  it("drops a row from the index when the message is deleted (AD trigger)", () => {
    mkSession(reg, "s-del");
    mkMessage(reg, "s-del", "assistant", "ephemeral capybara note", 6000);
    expect(reg.searchMessages("capybara").length).toBe(1);

    reg.deleteSession("s-del");
    expect(reg.searchMessages("capybara")).toEqual([]);
  });
});

describe("FTS backfill of pre-existing rows", () => {
  // Build a "legacy" DB whose messages predate the FTS table (so the triggers
  // never saw them), then migrate + backfill and confirm they become searchable.
  function legacyDb(): Database.Database {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jinn-fts-legacy-")), "legacy.db");
    const db = new Database(p);
    db.exec(
      "CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, timestamp INTEGER NOT NULL)",
    );
    return db;
  }
  function matchRows(db: Database.Database, q: string): Array<{ sessionId: string; snippet: string }> {
    return db
      .prepare(
        `SELECT m.session_id AS sessionId, snippet(messages_fts, 0, '«', '»', '…', 12) AS snippet
         FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid WHERE messages_fts MATCH ?`,
      )
      .all(q) as Array<{ sessionId: string; snippet: string }>;
  }

  it("seeds pre-existing user/assistant rows (and skips notification/tool)", () => {
    const db = legacyDb();
    const ins = db.prepare("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)");
    ins.run("a", "leg", "user", "old narwhal question", 1);
    ins.run("b", "leg", "assistant", "old narwhal answer", 2);
    ins.run("c", "leg", "notification", "narwhal notification", 3);
    ins.run("d", "leg", "tool", "narwhal tool", 4);

    reg.migrateFtsSchema(db);
    reg.backfillFtsSync(db);

    const hits = matchRows(db, "narwhal");
    expect(hits.length).toBe(2); // only user + assistant
    expect(hits[0].snippet).toContain("«narwhal»");
    db.close();
  });

  it("is idempotent and resumable across chunk boundaries (no double-indexing)", () => {
    const db = legacyDb();
    const ins = db.prepare("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)");
    for (let i = 0; i < 25; i++) ins.run(`r${i}`, "leg", i % 2 ? "assistant" : "user", `gerbil row ${i}`, i);

    reg.migrateFtsSchema(db);
    // chunkSize=4 forces multiple resumable chunks
    reg.backfillFtsSync(db, 4);
    expect(matchRows(db, "gerbil").length).toBe(25);

    // running again must not duplicate or corrupt the index
    reg.backfillFtsSync(db, 4);
    expect(matchRows(db, "gerbil").length).toBe(25);
    db.close();
  });

  it("lets the AD/AU triggers fire cleanly once pre-existing rows are seeded", () => {
    // Regression guard for the external-content footgun: an FTS 'delete' against a
    // rowid that is NOT yet in the index throws "database disk image is malformed".
    // initDb drains the backfill synchronously at boot precisely so deletes/updates
    // of old rows can't hit that. Here we prove a delete is safe AFTER the seed.
    const db = legacyDb();
    db.prepare("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)")
      .run("x", "leg", "assistant", "doomed axolotl note", 1);
    reg.migrateFtsSchema(db);
    reg.backfillFtsSync(db);
    expect(matchRows(db, "axolotl").length).toBe(1);

    // AD trigger fires on a now-indexed row — must not throw, and must de-index.
    expect(() => db.prepare("DELETE FROM messages WHERE id = 'x'").run()).not.toThrow();
    expect(matchRows(db, "axolotl")).toEqual([]);
    db.close();
  });

  it("does not double-index rows inserted AFTER migration (triggers own them)", () => {
    const db = legacyDb();
    db.prepare("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)")
      .run("pre", "leg", "assistant", "preexisting okapi", 1);

    reg.migrateFtsSchema(db); // snapshots fts_backfill_max at the single pre-existing row

    // a row inserted after migration is indexed by the AI trigger…
    db.prepare("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)")
      .run("post", "leg", "assistant", "fresh okapi", 2);
    // …and the backfill (bounded by the watermark) must not re-index it
    reg.backfillFtsSync(db);

    const hits = matchRows(db, "okapi");
    expect(hits.length).toBe(2); // exactly one entry per row, none duplicated
    db.close();
  });
});
