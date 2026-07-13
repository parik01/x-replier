const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../src/core.js");

test("validates delays and auto confirmation", () => {
  assert.equal(Core.validateSettings({ minDelaySec: 50, maxDelaySec: 10 }).ok, false);
  assert.equal(Core.validateSettings({ mode: "auto", autoConfirmed: false }).ok, false);
  assert.equal(Core.validateSettings({ mode: "auto", autoConfirmed: true }).ok, true);
});

test("draft does not increment daily sent counter", () => {
  const history = Core.emptyHistory();
  const drafted = Core.applyPostState(history, "1", "drafted", 10);
  assert.equal(drafted.sentToday, 0);
  assert.equal(Core.isProcessed(drafted, "1"), true);
  const sent = Core.applyPostState(drafted, "1", "sent", 20);
  assert.equal(sent.sentToday, 1);
  assert.equal(sent.draftedPosts["1"], undefined);
});

test("failed and unknown states do not count as sent", () => {
  const history = Core.emptyHistory();
  assert.equal(Core.applyPostState(history, "1", "failed").sentToday, 0);
  assert.equal(Core.applyPostState(history, "2", "unknown").sentToday, 0);
});

test("cleans model reply and rejects long reply", () => {
  assert.deepEqual(Core.cleanReply('```\n"Hello"\n```'), { ok: true, reply: "Hello" });
  assert.equal(Core.cleanReply("x".repeat(281)).ok, false);
});

test("uses bounded delay", () => {
  assert.equal(Core.randomDelay(10, 20, () => 0), 10);
  assert.equal(Core.randomDelay(10, 20, () => 0.999), 20);
});

test("expires stale locks", () => {
  assert.equal(Core.lockExpired({ heartbeatAt: 1 }, 31002, 30000), true);
  assert.equal(Core.lockExpired({ heartbeatAt: 10000 }, 31000, 30000), false);
});

test("prunes history maps", () => {
  const map = Object.fromEntries(Array.from({ length: 3010 }, (_, i) => [String(i), i]));
  assert.equal(Object.keys(Core.pruneMap(map)).length, 3000);
});
