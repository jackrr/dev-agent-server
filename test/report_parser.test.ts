import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReport } from "../src/report_parser.ts";

test("parses a full report", () => {
  const raw = `
<bug-report version="1">
<description>
The play button does nothing on track 3.
</description>
<device>
android 14 · pixel 7 · app 0.4.2+17
</device>
<recent-logs lines="120">
[12:00:01] tapped play
[12:00:02] no audio
</recent-logs>
<app-context name="project-digest">
4 tracks, 120 BPM
</app-context>
<app-context name="project-snapshot" truncated="true" size="48213">
elided
</app-context>
</bug-report>
  `;
  const r = parseReport(raw);
  assert.equal(r.version, "1");
  assert.equal(r.description, "The play button does nothing on track 3.");
  assert.equal(r.device, "android 14 · pixel 7 · app 0.4.2+17");
  assert.match(r.recentLogs ?? "", /tapped play/);
  assert.equal(r.appContexts.length, 2);
  assert.equal(r.appContexts[0]!.name, "project-digest");
  assert.equal(r.appContexts[1]!.name, "project-snapshot");
  assert.equal(r.appContexts[1]!.attrs.truncated, "true");
  assert.equal(r.appContexts[1]!.attrs.size, "48213");
});

test("tolerates missing optional sections", () => {
  const raw = `<bug-report version="2">
<description>x</description>
<device>linux</device>
</bug-report>`;
  const r = parseReport(raw);
  assert.equal(r.version, "2");
  assert.equal(r.description, "x");
  assert.equal(r.device, "linux");
  assert.equal(r.recentLogs, undefined);
  assert.deepEqual(r.appContexts, []);
});

test("unknown top-level tags land in `unknown`", () => {
  const raw = `<bug-report>
<description>x</description>
<device>d</device>
<weird-thing kind="future">hello</weird-thing>
</bug-report>`;
  const r = parseReport(raw);
  assert.equal(r.unknown.length, 1);
  assert.equal(r.unknown[0]!.tag, "weird-thing");
  assert.equal(r.unknown[0]!.content, "hello");
  assert.equal(r.unknown[0]!.attrs.kind, "future");
});

test("multiple app-context blocks with same and different names", () => {
  const raw = `<bug-report>
<app-context name="a">one</app-context>
<app-context name="b">two</app-context>
<app-context name="a">three</app-context>
</bug-report>`;
  const r = parseReport(raw);
  assert.equal(r.appContexts.length, 3);
  assert.deepEqual(r.appContexts.map((c) => c.name), ["a", "b", "a"]);
});

test("returns empty result if no <bug-report> root", () => {
  const r = parseReport("hello world");
  assert.equal(r.description, undefined);
  assert.deepEqual(r.appContexts, []);
});
