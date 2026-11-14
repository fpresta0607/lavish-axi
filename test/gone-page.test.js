import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

import { VERSION } from "../src/cli.js";
import { serve } from "../src/server.js";
import { canonicalFile, SessionStore, sessionKey } from "../src/session-store.js";

const CLI = fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// Each live file watch is one FSEventWrap handle. A closed watch leaves the list a few
// event-loop turns later, so the count is re-read a bounded number of times.
function watchHandles() {
  return process.getActiveResourcesInfo().filter((resource) => resource === "FSEventWrap").length;
}

async function settledWatchHandles(expected) {
  for (let attempt = 0; attempt < 100 && watchHandles() !== expected; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return watchHandles();
}

async function fetchJson(url, body, origin) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

// A goblin presents a page from its worktree, then retires, and the worktree goes with it: the
// page's file is gone while the session stays in state.json. A page that still exists keeps the
// server from stopping itself when the last gone session ends.
// By default the sessions are written straight to state.json, so no server watcher sees the page
// go (a page that went while no server was running). `isWatched` opens them through the server.
async function startReview(t, pageNames, { isWatched = false, pollHeartbeatMs } = {}) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "lavish-gone-page-"));
  const server = await serve({
    port: 0,
    stateFile: path.join(stateDir, "state.json"),
    version: VERSION,
    log: () => {},
    idleTimeoutMs: null,
    pollHeartbeatMs,
  });
  t.after(async () => {
    await server.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.port}`;
  const store = new SessionStore(path.join(stateDir, "state.json"));
  const pages = {};
  for (const name of ["present", ...pageNames]) {
    const worktree = path.join(stateDir, "worktrees", name);
    const file = path.join(worktree, ".lavish", `${name}.html`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `<!doctype html><html><body>${name}</body></html>`);
    if (isWatched) {
      const opened = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file }),
      }).then((response) => response.json());
      pages[name] = { file, worktree, key: opened.key };
    } else {
      const seeded = await store.upsertSession(file, `${base}/session/${sessionKey(await canonicalFile(file))}`);
      pages[name] = { file, worktree, key: seeded.key };
    }
  }
  return {
    base,
    pages,
    store,
    poll: (page) =>
      fetch(`${base}/api/poll?file=${encodeURIComponent(page.file)}&timeoutMs=5000`).then((response) =>
        response.json(),
      ),
    queueNote: async (page, prompt) => {
      const response = await fetch(`${base}/api/${page.key}/prompts`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({ prompts: [{ prompt, tag: "message" }] }),
      });
      assert.equal(response.status, 200);
    },
    retire: (page) => rm(page.worktree, { recursive: true }),
    cli: async (...args) => {
      const child = spawn(process.execPath, [CLI, ...args], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          LAVISH_AXI_STATE_DIR: stateDir,
          LAVISH_AXI_PORT: String(server.port),
          LAVISH_AXI_TELEMETRY: "0",
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      const [code] = await once(child, "close");
      return { code, stdout, stderr };
    },
  };
}

for (const hasNote of [false, true]) {
  test(`end ends a session whose page is gone ${hasNote ? "and keeps its note for poll" : "with nothing pending"}`, async (t) => {
    const review = await startReview(t, ["gone"]);
    const { gone } = review.pages;
    if (hasNote) await review.queueNote(gone, "Rename the payment step");
    await review.retire(gone);

    const ended = await review.cli("end", gone.file);

    assert.equal(ended.code, 0, ended.stdout + ended.stderr);
    assert.match(ended.stdout, /status: ended/);
    assert.equal((await review.store.findByKey(gone.key)).status, "ended");
    if (hasNote) {
      const polled = await review.cli("poll", gone.file, "--timeout-ms", "200");
      assert.equal(polled.code, 0, polled.stdout + polled.stderr);
      assert.match(polled.stdout, /status: feedback/);
      assert.match(polled.stdout, /session_ended: true/);
      assert.match(polled.stdout, /Rename the payment step/);
    }
  });

  test(`poll on a session whose page is gone ${hasNote ? "delivers its note" : "waits like any page"}`, async (t) => {
    const review = await startReview(t, ["gone"]);
    const { gone } = review.pages;
    if (hasNote) await review.queueNote(gone, "Rename the payment step");
    await review.retire(gone);

    const polled = await review.cli("poll", gone.file, "--timeout-ms", "200");

    assert.equal(polled.code, 0, polled.stdout + polled.stderr);
    if (hasNote) {
      assert.match(polled.stdout, /status: feedback/);
      assert.match(polled.stdout, /Rename the payment step/);
      assert.deepEqual((await review.store.findByKey(gone.key)).prompts, []);
    } else {
      assert.match(polled.stdout, /status: waiting/);
    }
  });
}

test("the session list says which page's file is gone", async (t) => {
  const review = await startReview(t, ["gone"]);
  const { gone, present } = review.pages;
  await review.queueNote(gone, "Rename the payment step");
  await review.retire(gone);

  const listed = await review.cli();

  assert.equal(listed.code, 0, listed.stdout + listed.stderr);
  assert.match(listed.stdout, /sessions\[2\]\{file,status,url,pending_prompts,listener,file_gone\}:/);
  const row = (key) => listed.stdout.split("\n").find((line) => line.includes(`/session/${key}`));
  assert.match(row(gone.key), /,1,none,true$/);
  assert.match(row(present.key), /,0,none,false$/);
});

test("end --gone ends every quiet session whose page is gone and leaves the rest open", async (t) => {
  const review = await startReview(t, ["gone-quiet", "gone-also-quiet", "gone-with-note"]);
  const pages = review.pages;
  await review.queueNote(pages["gone-with-note"], "Rename the payment step");
  for (const name of ["gone-quiet", "gone-also-quiet", "gone-with-note"]) await review.retire(pages[name]);

  const ended = await review.cli("end", "--gone");

  assert.equal(ended.code, 0, ended.stdout + ended.stderr);
  assert.match(ended.stdout, /ended\[2\]/);
  assert.match(ended.stdout, /pending\[1\]/);
  assert.match(ended.stdout, /lavish-axi poll/);
  assert.equal((await review.store.findByKey(pages["gone-quiet"].key)).status, "ended");
  assert.equal((await review.store.findByKey(pages["gone-also-quiet"].key)).status, "ended");
  assert.notEqual((await review.store.findByKey(pages["gone-with-note"].key)).status, "ended");
  assert.notEqual((await review.store.findByKey(pages.present.key)).status, "ended");

  const again = await review.cli("end", "--gone");
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /ended\[0\]/);
});

// On Windows a watch left on a removed page moves to its folder, and once that folder is removed
// too the watch reports a rename on every event-loop turn: one core spent for as long as it lives.
test("the server ends an open session whose page and then its folder are removed, and stops watching it", async (t) => {
  const review = await startReview(t, ["gone"], { isWatched: true });
  const { gone, present } = review.pages;
  const watching = watchHandles();
  const polled = review.poll(gone);

  await rm(gone.file);
  const result = await polled;
  await review.retire(gone);

  assert.equal(result.status, "ended");
  assert.equal((await review.store.findByKey(gone.key)).status, "ended");
  assert.notEqual((await review.store.findByKey(present.key)).status, "ended");
  assert.equal(await settledWatchHandles(watching - 1), watching - 1);
});

for (const [name, endPage] of [
  ["lavish-axi end", (review, page) => fetchJson(`${review.base}/api/end`, { file: page.file })],
  ["the reviewer's End", (review, page) => fetchJson(`${review.base}/api/${page.key}/end`, {}, review.base)],
  [
    "the reviewer's send and end",
    (review, page) =>
      fetchJson(
        `${review.base}/api/${page.key}/prompts`,
        { prompts: [{ prompt: "Ship it", tag: "message" }], endSession: true },
        review.base,
      ),
  ],
]) {
  test(`a session ended by ${name} holds no watcher and no poll`, async (t) => {
    const review = await startReview(t, ["ending"], { isWatched: true });
    const { ending } = review.pages;
    const watching = watchHandles();
    const polled = review.poll(ending);

    await endPage(review, ending);

    assert.notEqual((await polled).status, "waiting");
    assert.equal((await review.store.findByKey(ending.key)).status, "ended");
    assert.equal(await settledWatchHandles(watching - 1), watching - 1);
  });
}

test("loading the page of a session whose file is gone ends it without watching anything", async (t) => {
  const review = await startReview(t, ["gone"]);
  const { gone } = review.pages;
  await review.retire(gone);
  const watching = watchHandles();

  await fetch(`${review.base}/session/${gone.key}`).then((response) => response.text());

  assert.equal((await review.store.findByKey(gone.key)).status, "ended");
  assert.equal(await settledWatchHandles(watching), watching);
});

test("an idle server holding long polls reads and writes no state", async (t) => {
  const review = await startReview(t, ["second", "third"], { isWatched: true, pollHeartbeatMs: 10 });
  const aborter = new AbortController();
  t.after(() => aborter.abort());
  for (const page of Object.values(review.pages)) {
    const listening = await fetch(`${review.base}/api/poll?file=${encodeURIComponent(page.file)}`, {
      signal: aborter.signal,
    });
    assert.equal(listening.headers.get("lavish-poll-state"), "listening");
  }
  const reads = t.mock.method(SessionStore.prototype, "readState");
  const writes = t.mock.method(SessionStore.prototype, "writeState");

  await new Promise((resolve) => setTimeout(resolve, 500));

  assert.equal(reads.mock.callCount(), 0);
  assert.equal(writes.mock.callCount(), 0);
});

test("end refuses a file together with --gone", async (t) => {
  const review = await startReview(t, []);

  const refused = await review.cli("end", review.pages.present.file, "--gone");

  assert.notEqual(refused.code, 0);
  assert.match(refused.stdout, /VALIDATION_ERROR/);
  assert.notEqual((await review.store.findByKey(review.pages.present.key)).status, "ended");
});
