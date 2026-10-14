import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// A sent annotation closes its own box, measured in a real browser through the real chrome and
// server. He highlights a heading, writes a note in its box and sends it, once with Enter and once
// with the send button: the box goes, and the page and the Conversation box stay as they were. A
// send that does not get through keeps the box, with his words in it, until the note is delivered.
// The box and the page are found the way a reader finds them, in the browser's accessibility tree.
const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, env, timeout = 45_000) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout || ""}${result.stderr || ""}`;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate a TCP port");
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return address.port;
}

const ARTIFACT = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Annotation fixture</title>
<style>html,body{background:#fff;color:#111}body{margin:0;padding:24px;font-family:system-ui,sans-serif}section{padding:16px;margin:16px 0}</style>
</head><body>
<h1>Checkout redesign</h1>
<section><h2>Step 1. Address</h2><p>Autofill from the browser profile.</p></section>
<section><h2>Step 2. Payment</h2><p>Card, Apple Pay and Link.</p></section>
<section><h2>Step 3. Review</h2><p>Confirm and place the order.</p></section>
</body></html>`;

const CARD_TEXTBOX = /textbox "Tell the agent what to change about this element\.\.\."/;
const CARD_SEND = /button "Send to the agent"/;
const CHIP = /"Comment on <h2>/;
const MAIN_BOX = /textbox "Write a message for the agent\.\.\."/;

test(
  "a sent annotation closes its own box and nothing else, and a send that fails keeps the box",
  { skip: !runBrowserE2e, timeout: 300_000 },
  async (t) => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-annotation-send-"));
    const port = await freePort();
    const lavishEnv = {
      LAVISH_AXI_PORT: String(port),
      LAVISH_AXI_STATE_DIR: path.join(temp, "state"),
      LAVISH_AXI_NO_OPEN: "1",
      LAVISH_AXI_TELEMETRY: "0",
      LAVISH_AXI_HOST: "127.0.0.1",
      LAVISH_AXI_LINK_HOST: "127.0.0.1",
    };
    const chromeEnv = {
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-annotation-send-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const snapshot = () => run("chrome-devtools-axi", ["snapshot"], chromeEnv);
    const uidOf = (shot, pattern) => {
      const line = shot.split("\n").find((candidate) => pattern.test(candidate));
      assert.ok(line, `no snapshot line matching ${pattern}:\n${shot}`);
      return `@${line.trim().split(/\s+/)[0].replace(/^uid=/, "")}`;
    };
    const has = (shot, pattern) => shot.split("\n").some((line) => pattern.test(line));

    // Snapshot refs go stale after every action, so each step resolves a fresh one. A state is
    // waited for with a capped poll, never a fixed sleep.
    async function waitForSnapshot(description, isReady, seconds = 20) {
      const deadline = Date.now() + seconds * 1000;
      let shot = snapshot();
      while (!isReady(shot)) {
        if (Date.now() > deadline) assert.fail(`${description} within ${seconds}s:\n${shot}`);
        await wait(2000);
        shot = snapshot();
      }
      return shot;
    }

    // A real click on a heading highlights it and opens its box.
    async function openBox(heading) {
      run("chrome-devtools-axi", ["click", uidOf(snapshot(), heading)], chromeEnv);
      return waitForSnapshot("the annotation box never opened", (shot) => has(shot, CARD_TEXTBOX));
    }

    function writeNote(shot, words) {
      run("chrome-devtools-axi", ["fill", uidOf(shot, CARD_TEXTBOX), words], chromeEnv);
    }

    // The page and the Conversation box are still there, on the same session.
    function assertPageAndMainBoxStay(where, shot) {
      assert.ok(has(shot, /heading "Checkout redesign"/), `${where}: the page is still open:\n${shot}`);
      assert.ok(has(shot, MAIN_BOX), `${where}: the Conversation box is still open:\n${shot}`);
      assert.equal(has(shot, /Send & End/), true, `${where}: the session is still going:\n${shot}`);
    }

    function assertBoxGone(where, shot) {
      assert.equal(has(shot, CARD_TEXTBOX), false, `${where}: the annotation box is still open:\n${shot}`);
      assert.equal(has(shot, CARD_SEND), false, `${where}: the box's send button is still there:\n${shot}`);
      assert.equal(has(shot, CHIP), false, `${where}: the sent note's box is still open:\n${shot}`);
    }

    try {
      const artifact = path.join(temp, "review.html");
      await writeFile(artifact, ARTIFACT);
      const output = run(process.execPath, ["bin/lavish-axi.js", artifact, "--no-open"], lavishEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);
      // A fresh browser has no page to act on, so it opens a blank one first.
      run("chrome-devtools-axi", ["open", "data:text/html,"], chromeEnv);
      run("chrome-devtools-axi", ["open", url], chromeEnv);
      await waitForSnapshot("the page never loaded", (shot) => has(shot, /heading "Step 2\. Payment"/));

      await t.test("Enter sends the note and closes its box", async () => {
        writeNote(await openBox(/heading "Step 2\. Payment"/), "Make the payment step stand out");
        run("chrome-devtools-axi", ["press", "Enter"], chromeEnv);
        const shot = await waitForSnapshot(
          "the box never closed after Enter",
          (current) => !has(current, CARD_TEXTBOX),
        );
        const settled = await waitForSnapshot(
          "the note never reached the conversation",
          (current) => has(current, /Make the payment step stand out/) && !has(current, CHIP),
        );
        assertBoxGone("after Enter", settled);
        assertPageAndMainBoxStay("after Enter", shot);
      });

      await t.test("the send button sends the note and closes its box", async () => {
        const opened = await openBox(/heading "Step 1\. Address"/);
        writeNote(opened, "Say which address is billed");
        run("chrome-devtools-axi", ["click", uidOf(snapshot(), CARD_SEND)], chromeEnv);
        const shot = await waitForSnapshot(
          "the box never closed after the send button",
          (current) =>
            has(current, /Say which address is billed/) && !has(current, CARD_TEXTBOX) && !has(current, CHIP),
        );
        assertBoxGone("after the send button", shot);
        assertPageAndMainBoxStay("after the send button", shot);
      });

      await t.test("a send that fails keeps the box and its words until the note is delivered", async () => {
        // The browser cannot reach the server for this one send, as on a dropped connection.
        const failSends = (failing) =>
          run(
            "chrome-devtools-axi",
            [
              "eval",
              `() => {
                if (!window.__realFetch) window.__realFetch = window.fetch;
                window.fetch = (input, init) =>
                  ${failing} && String(input).endsWith("/prompts") && init && init.method === "POST"
                    ? Promise.reject(new TypeError("Failed to fetch"))
                    : window.__realFetch(input, init);
                return "ok";
              }`,
            ],
            chromeEnv,
          );
        failSends(true);
        writeNote(await openBox(/heading "Step 3\. Review"/), "Keep this note if it fails");
        run("chrome-devtools-axi", ["press", "Enter"], chromeEnv);
        const kept = await waitForSnapshot("the failed note never said it was not sent", (current) =>
          has(current, /Not sent\./),
        );
        assert.ok(has(kept, CHIP), `the box stays open after a failed send:\n${kept}`);
        assert.ok(has(kept, /Keep this note if it fails/), `the box keeps his words:\n${kept}`);
        assertPageAndMainBoxStay("after a failed send", kept);

        // The note was still in the queue: sending it again gets it through, and its box closes.
        failSends(false);
        run("chrome-devtools-axi", ["click", uidOf(snapshot(), /button "Send to Agent"/)], chromeEnv);
        const delivered = await waitForSnapshot(
          "the retried note never closed its box",
          (current) => !has(current, CHIP) && !has(current, /Not sent\./),
        );
        assertBoxGone("after the retry", delivered);
        assertPageAndMainBoxStay("after the retry", delivered);
      });
    } finally {
      run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15_000);
      run("chrome-devtools-axi", ["stop"], chromeEnv);
      // Windows keeps the profile's lockfile a moment after Chrome exits.
      await rm(temp, { recursive: true, force: true, maxRetries: 10 });
    }
  },
);
