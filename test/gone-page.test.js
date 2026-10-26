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
import { SessionStore } from "../src/session-store.js";

const CLI = fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// A goblin presents a page from its worktree, then retires, and the worktree goes with it: the
// page's file is gone while the session stays in state.json. A page that still exists keeps the
// server from stopping itself when the last gone session ends.
async function startReview(t, pageNames) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "lavish-gone-page-"));
  const server = await serve({
    port: 0,
    stateFile: path.join(stateDir, "state.json"),
    version: VERSION,
    log: () => {},
    idleTimeoutMs: null,
  });
  t.after(async () => {
    await server.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.port}`;
  const pages = {};
  for (const name of ["present", ...pageNames]) {
    const worktree = path.join(stateDir, "worktrees", name);
    const file = path.join(worktree, ".lavish", `${name}.html`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `<!doctype html><html><body>${name}</body></html>`);
    const opened = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file }),
    }).then((response) => response.json());
    pages[name] = { file, worktree, key: opened.key };
  }
  return {
    pages,
    store: new SessionStore(path.join(stateDir, "state.json")),
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

test("end refuses a file together with --gone", async (t) => {
  const review = await startReview(t, []);

  const refused = await review.cli("end", review.pages.present.file, "--gone");

  assert.notEqual(refused.code, 0);
  assert.match(refused.stdout, /VALIDATION_ERROR/);
  assert.notEqual((await review.store.findByKey(review.pages.present.key)).status, "ended");
});
