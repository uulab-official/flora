import test from "node:test";
import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { observeD1Capacity } from "./d1-capacity-diagnostics.ts";

const send = channel("undici:client:sendHeaders");
const headers = channel("undici:request:headers");
const complete = channel("undici:request:trailers");
const failed = channel("undici:request:error");

test("capacity_diagnostics_are_bounded_numeric_and_preserve_the_original_failure", () => {
  const messages: string[] = [];
  const diagnostics = observeD1Capacity(message => messages.push(message));
  try {
    diagnostics.beginBatch(4, 9);
    const socket = {};
    const forbidden = () => { throw new Error("must not inspect synthetic secret metadata"); };
    for (let n = 0; n < 8; n++) {
      const request = { contentLength: 116, get body() { return forbidden(); }, get headers() { return forbidden(); }, get path() { return forbidden(); } };
      send.publish({ request, socket, get headers() { return forbidden(); } });
      headers.publish({ request, response: { statusCode: 200, get headers() { return forbidden(); } } });
      complete.publish({ request });
    }
    diagnostics.submitted();
    const request = { contentLength: 118 };
    send.publish({ request, socket });
    failed.publish({ request, error: { code: "ECONNRESET", get message() { return forbidden(); } } });
    const original = new TypeError("synthetic original failure", { cause: new Error("synthetic cause") });
    assert.throws(() => diagnostics.rethrow(original), error => error === original);
    assert.equal(messages.length, 1);
    const report = JSON.parse(messages[0]!.replace(/^D1_CAPACITY_DIAGNOSTIC /, ""));
    assert.equal(report.batchIndex, 4);
    assert.equal(report.completedRows, 9);
    assert.ok(report.invocationMs >= 0);
    assert.ok(report.eventLoopActiveMs >= 0);
    assert.ok(report.eventLoopIdleMs >= 0);
    assert.ok(report.eventLoopUtilization >= 0 && report.eventLoopUtilization <= 1);
    assert.equal(report.events.length, 12);
    assert.equal(report.events.at(-1).errorCode, "ECONNRESET");
    const lastSend = report.events.findLast((event: { event: string }) => event.event === "send");
    assert.equal(lastSend.socketId, 1);
    assert.ok(lastSend.socketIdleMs >= 0);
    assert.ok(lastSend.socketObservedAgeMs >= lastSend.socketIdleMs);
    assert.equal(lastSend.requestBytes, 118);
    for (const [key, value] of Object.entries(report)) if (key !== "events") assert.equal(typeof value, "number", key);
    for (const event of report.events) for (const [key, value] of Object.entries(event)) {
      if (key !== "event" && key !== "errorCode") assert.equal(typeof value, "number", key);
    }
  } finally { diagnostics.dispose(); }
});

test("capacity_diagnostics_emit_nothing_on_success_and_unsubscribe_after_disposal", () => {
  const messages: string[] = [];
  const diagnostics = observeD1Capacity(message => messages.push(message));
  diagnostics.beginBatch(1, 0);
  const request = { contentLength: 116 }, socket = {};
  send.publish({ request, socket });
  complete.publish({ request });
  diagnostics.submitted();
  assert.equal(messages.length, 0);
  diagnostics.dispose();
  diagnostics.dispose();
  for (let n = 0; n < 20; n++) send.publish({ request: {}, socket: {} });
  const original = new Error("synthetic failure after observer disposal");
  assert.throws(() => diagnostics.rethrow(original), error => error === original);
  const report = JSON.parse(messages[0]!.replace(/^D1_CAPACITY_DIAGNOSTIC /, ""));
  assert.deepEqual(report.events.map((event: { event: string }) => event.event), ["send", "complete"]);
});

test("capacity_diagnostics_allowlist_error_codes_and_cannot_replace_a_failure", () => {
  const messages: string[] = [];
  const diagnostics = observeD1Capacity(message => messages.push(message));
  try {
    diagnostics.beginBatch(1, 0);
    const request = { contentLength: Number.NaN };
    send.publish({ request, socket: {} });
    failed.publish({ request, error: { code: "synthetic-sensitive-value", message: "synthetic-sensitive-message" } });
    const original = new Error("synthetic original");
    assert.throws(() => diagnostics.rethrow(original), error => error === original);
    assert.doesNotMatch(messages[0]!, /synthetic-sensitive/);
    const report = JSON.parse(messages[0]!.replace(/^D1_CAPACITY_DIAGNOSTIC /, ""));
    assert.equal(report.events[0].requestBytes, -1);
    assert.equal(report.events[0].socketIdleMs, -1);
    assert.equal(report.events.at(-1).errorCode, "UNCLASSIFIED");
  } finally { diagnostics.dispose(); }
  const brokenSink = observeD1Capacity(() => { throw new Error("synthetic diagnostic sink failure"); });
  try {
    brokenSink.beginBatch(1, 0);
    const original = new Error("preserve this object");
    assert.throws(() => brokenSink.rethrow(original), error => error === original);
  } finally { brokenSink.dispose(); }
});
