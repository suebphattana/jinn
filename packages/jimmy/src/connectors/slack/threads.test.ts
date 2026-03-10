import test from "node:test";
import assert from "node:assert/strict";
import { buildReplyContext, deriveSessionKey, isOldSlackMessage } from "./threads.js";

test("deriveSessionKey keeps DM sessions per user", () => {
  const key = deriveSessionKey({
    channel: "D123",
    user: "U123",
    channel_type: "im",
    ts: "1700000000.000100",
  });

  assert.equal(key, "slack:dm:U123");
});

test("deriveSessionKey isolates thread replies unless channel sharing is enabled", () => {
  const threaded = deriveSessionKey({
    channel: "C123",
    user: "U123",
    ts: "1700000100.000200",
    thread_ts: "1700000000.000100",
  });
  const shared = deriveSessionKey(
    {
      channel: "C123",
      user: "U123",
      ts: "1700000100.000200",
      thread_ts: "1700000000.000100",
    },
    { shareSessionInChannel: true },
  );

  assert.equal(threaded, "slack:C123:1700000000.000100");
  assert.equal(shared, "slack:C123");
});

test("buildReplyContext keeps the original message id for replies", () => {
  const context = buildReplyContext({
    channel: "C123",
    ts: "1700000100.000200",
    thread_ts: "1700000000.000100",
  });

  assert.deepEqual(context, {
    channel: "C123",
    thread: "1700000000.000100",
    messageTs: "1700000100.000200",
  });
});

test("isOldSlackMessage compares against boot time", () => {
  assert.equal(isOldSlackMessage("1700000000.000100", 1700000001000), true);
  assert.equal(isOldSlackMessage("1700000002.000100", 1700000001000), false);
});
