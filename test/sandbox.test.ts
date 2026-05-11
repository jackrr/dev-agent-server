import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseCopySources, hashBuildContext, translateWorkspacePath } from "../src/sandbox.js";

test("parseCopySources: basic COPY and ADD", () => {
  const out = parseCopySources(`
    FROM debian
    COPY package.json tsconfig.json ./
    ADD script.sh /usr/local/bin/
  `);
  assert.deepEqual(out.sort(), ["package.json", "script.sh", "tsconfig.json"]);
});

test("parseCopySources: strips --chown / --chmod flags but keeps sources", () => {
  const out = parseCopySources(`COPY --chown=node:node --chmod=644 src ./src`);
  assert.deepEqual(out, ["src"]);
});

test("parseCopySources: --from=stage references a build stage, not the context", () => {
  const out = parseCopySources(`COPY --from=build /app/dist ./dist`);
  assert.deepEqual(out, []);
});

test("parseCopySources: skips http(s) URLs in ADD", () => {
  const out = parseCopySources(`ADD https://example.com/foo.tgz /tmp/\nADD ./local.tgz /tmp/`);
  assert.deepEqual(out, ["./local.tgz"]);
});

test("parseCopySources: handles line continuations", () => {
  const out = parseCopySources(`COPY \\\n   a.txt \\\n   b.txt \\\n   /dest/`);
  assert.deepEqual(out.sort(), ["a.txt", "b.txt"]);
});

test("parseCopySources: handles quoted paths with spaces", () => {
  const out = parseCopySources(`COPY "my file.txt" "/dest/"`);
  assert.deepEqual(out, ["my file.txt"]);
});

test("parseCopySources: ignores comments", () => {
  const out = parseCopySources(`# COPY ignored.txt /dest/\nCOPY real.txt /dest/`);
  assert.deepEqual(out, ["real.txt"]);
});

test("hashBuildContext: changes when COPY'd file changes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hbc-"));
  const dockerfile = path.join(dir, "Dockerfile");
  const dep = path.join(dir, "dep.txt");
  fs.writeFileSync(dockerfile, "FROM debian\nCOPY dep.txt /\n");
  fs.writeFileSync(dep, "v1");
  const h1 = hashBuildContext(dockerfile);

  fs.writeFileSync(dep, "v2");
  const h2 = hashBuildContext(dockerfile);
  assert.notEqual(h1, h2, "hash should change when COPY'd file content changes");

  // Stable when nothing changes.
  const h3 = hashBuildContext(dockerfile);
  assert.equal(h2, h3);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("hashBuildContext: changes when Dockerfile changes even without COPY", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hbc-"));
  const dockerfile = path.join(dir, "Dockerfile");
  fs.writeFileSync(dockerfile, "FROM debian\nRUN echo v1\n");
  const h1 = hashBuildContext(dockerfile);
  fs.writeFileSync(dockerfile, "FROM debian\nRUN echo v2\n");
  const h2 = hashBuildContext(dockerfile);
  assert.notEqual(h1, h2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("translateWorkspacePath: returns input when either dir is unset", () => {
  assert.equal(translateWorkspacePath("/data/workspaces/x", undefined, "/host"), "/data/workspaces/x");
  assert.equal(translateWorkspacePath("/data/workspaces/x", "/data/workspaces", undefined), "/data/workspaces/x");
  assert.equal(translateWorkspacePath("/x", undefined, undefined), "/x");
});

test("translateWorkspacePath: returns input when dirs are identical", () => {
  assert.equal(translateWorkspacePath("/ws/a", "/ws", "/ws"), "/ws/a");
});

test("translateWorkspacePath: rewrites prefix", () => {
  assert.equal(
    translateWorkspacePath("/data/workspaces/sessions/abc", "/data/workspaces", "/host/vol"),
    "/host/vol/sessions/abc",
  );
});

test("translateWorkspacePath: handles exact match of the root", () => {
  assert.equal(translateWorkspacePath("/data/workspaces", "/data/workspaces", "/host/vol"), "/host/vol");
});

test("translateWorkspacePath: tolerates trailing slashes", () => {
  assert.equal(
    translateWorkspacePath("/data/workspaces/x", "/data/workspaces/", "/host/vol/"),
    "/host/vol/x",
  );
});

test("translateWorkspacePath: does NOT rewrite paths outside inDir (prefix-match guard)", () => {
  // /data/workspaces2/... must not match /data/workspaces.
  assert.equal(
    translateWorkspacePath("/data/workspaces2/x", "/data/workspaces", "/host/vol"),
    "/data/workspaces2/x",
  );
  assert.equal(
    translateWorkspacePath("/elsewhere/x", "/data/workspaces", "/host/vol"),
    "/elsewhere/x",
  );
});

test("hashBuildContext: changes when a file inside a COPY'd directory changes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hbc-"));
  const dockerfile = path.join(dir, "Dockerfile");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "a.txt"), "a1");
  fs.writeFileSync(dockerfile, "FROM debian\nCOPY src /src\n");
  const h1 = hashBuildContext(dockerfile);

  fs.writeFileSync(path.join(dir, "src", "a.txt"), "a2");
  const h2 = hashBuildContext(dockerfile);
  assert.notEqual(h1, h2);

  // New file added to COPY'd dir → should also invalidate.
  fs.writeFileSync(path.join(dir, "src", "b.txt"), "b1");
  const h3 = hashBuildContext(dockerfile);
  assert.notEqual(h2, h3);

  fs.rmSync(dir, { recursive: true, force: true });
});
