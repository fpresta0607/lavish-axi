import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Both message boxes, measured in a real browser: the Conversation box keeps its paperclip at the
// bottom left and its microphone at the bottom right, and the annotation box its paperclip at the
// bottom left, each inside the box the reader sees, as an icon with a name and a tooltip but no
// words. The text ends above the buttons however long it grows. The box is found the way a reader
// finds it, as the nearest element around the text that draws a border, so a button drawn under or
// beside the box fails whatever the markup calls it.
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

// Runs in the chrome and inside the reviewed page alike.
const MEASURE_BOX = `function measureBox(textarea, controls) {
  var box = textarea;
  while (box && parseFloat(getComputedStyle(box).borderTopWidth) === 0) box = box.parentElement;
  function rect(el) {
    var r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  }
  var measured = { box: rect(box), text: rect(textarea), textHeight: textarea.clientHeight, textScrolls: textarea.scrollHeight > textarea.clientHeight, controls: {} };
  for (var name in controls) {
    var control = controls[name];
    measured.controls[name] = control
      ? { rect: rect(control), words: control.textContent.trim(), label: control.getAttribute("aria-label") || "", tip: control.getAttribute("data-tip") || "" }
      : null;
  }
  return measured;
}
function longNote() {
  var lines = [];
  for (var line = 1; line <= 60; line += 1) lines.push("Line " + line + " of a note long enough to scroll the box");
  return lines.join("\\n");
}`;

// The page's own driver measures the annotation box once a real click opens it, and writes the
// result into the page as text, where the chrome's snapshot of the frame can read it.
const ARTIFACT = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Message box fixture</title>
<style>body{margin:0;padding:24px;font-family:system-ui,sans-serif}section{padding:16px;margin:16px 0}</style>
</head><body>
<h1>Checkout redesign</h1>
<section><h2>Step 1. Address</h2><p>Autofill from the browser profile.</p></section>
<section><h2>Step 2. Payment</h2><p>Card, Apple Pay and Link.</p></section>
<p id="card-report">waiting</p>
<script>
${MEASURE_BOX}
(async function drive() {
  var card = null;
  while (!card) {
    await new Promise(function (resolve) { setTimeout(resolve, 100); });
    var host = document.querySelector(".lavish-annotation-root");
    card = host && host.shadowRoot ? host.shadowRoot.querySelector(".lavish-annotation-card") : null;
  }
  var textarea = card.querySelector("textarea");
  var controls = { attach: card.querySelector(".lavish-attach") };
  var empty = measureBox(textarea, controls);
  textarea.value = longNote();
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise(function (resolve) { requestAnimationFrame(function () { requestAnimationFrame(resolve); }); });
  var full = measureBox(textarea, controls);
  document.getElementById("card-report").textContent = "card-report:" + encodeURIComponent(JSON.stringify({ empty: empty, full: full }));
})();
</script>
</body></html>`;

const MEASURE_COMPOSER = `() => {
  ${MEASURE_BOX}
  const textarea = document.getElementById("chatInput");
  const controls = { attach: document.getElementById("chatAttach"), voice: document.getElementById("chatVoice") };
  const words = (id) => document.getElementById(id).textContent.trim();
  const rect = (id) => {
    const r = document.getElementById(id).getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  };
  const empty = measureBox(textarea, controls);
  textarea.value = longNote();
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  const full = measureBox(textarea, controls);
  textarea.value = "";
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  return JSON.stringify({
    empty,
    full,
    sendAndEnd: { words: words("sendAndEnd"), rect: rect("sendAndEnd") },
    send: { words: words("send"), rect: rect("send") },
  });
}`;

// One control inside the box at the named corner, an icon with a name and a tooltip, the text
// ending above it.
function assertInBox(where, measured, name, corner) {
  const { box, text, controls } = measured;
  const control = controls[name];
  assert.ok(control, `${where}: the ${name} button exists`);
  const { rect } = control;
  const detail = `${where} ${name}: ${JSON.stringify({ box, button: rect, text })}`;
  assert.ok(
    rect.left >= box.left - 0.5 &&
      rect.right <= box.right + 0.5 &&
      rect.top >= box.top - 0.5 &&
      rect.bottom <= box.bottom + 0.5,
    `the button sits inside the text box: ${detail}`,
  );
  assert.ok(box.bottom - rect.bottom <= 16, `the button sits at the box's bottom: ${detail}`);
  if (corner === "left") assert.ok(rect.left - box.left <= 16, `the button sits at the box's left: ${detail}`);
  else assert.ok(box.right - rect.right <= 16, `the button sits at the box's right: ${detail}`);
  assert.ok(text.bottom <= rect.top + 0.5, `the text ends above the button: ${detail}`);
  assert.equal(control.words, "", `${where} ${name} shows no words`);
  assert.ok(control.label, `${where} ${name} has an accessible name`);
  assert.ok(control.tip, `${where} ${name} has a tooltip`);
}

function assertConversationBox(where, measured) {
  for (const state of ["empty", "full"]) {
    assertInBox(`${where}, ${state}`, measured[state], "attach", "left");
    assertInBox(`${where}, ${state}`, measured[state], "voice", "right");
  }
  assert.equal(measured.full.textScrolls, true, `${where}: sixty lines scroll inside the box`);
  assert.ok(measured.full.textHeight <= 240, `${where}: the text area stops growing at its cap`);
  assert.equal(measured.sendAndEnd.words, "Send & End");
  assert.equal(measured.send.words, "Send to Agent");
  assert.ok(measured.sendAndEnd.rect.top >= measured.empty.box.bottom, `${where}: Send & End stays under the box`);
  assert.ok(measured.send.rect.left >= measured.sendAndEnd.rect.right, `${where}: Send to Agent stays on the right`);
}

function assertAnnotationBox(where, measured) {
  for (const state of ["empty", "full"]) assertInBox(`${where}, ${state}`, measured[state], "attach", "left");
  assert.equal(measured.full.textScrolls, true, `${where}: sixty lines scroll inside the box`);
}

test(
  "the message boxes hold their paperclip and microphone inside the box as icons, in a window and on a phone",
  { skip: !runBrowserE2e, timeout: 300_000 },
  async (t) => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-message-box-"));
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
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-message-box-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };

    function evaluate(expression) {
      const output = run("chrome-devtools-axi", ["eval", expression], chromeEnv);
      const raw = output.match(/result:\s*("(?:[^"\\]|\\.)*")/s)?.[1];
      assert.ok(raw, output);
      let value = JSON.parse(raw);
      while (typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch {
          break;
        }
      }
      return value;
    }

    // The CLI's own `wait <ms>` throws in some releases, so the pause is the test's.
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // Emulation needs a page to act on, so the page loads once, then again at the new viewport.
    async function open(url, viewport) {
      run("chrome-devtools-axi", ["open", url], chromeEnv);
      run("chrome-devtools-axi", ["emulate", "--viewport", viewport], chromeEnv);
      run("chrome-devtools-axi", ["open", url], chromeEnv);
      await wait(4000);
    }

    // A real click through the chrome into the sandboxed page opens the annotation box.
    async function measureAnnotationBox() {
      const snapshot = run("chrome-devtools-axi", ["snapshot"], chromeEnv);
      const heading = snapshot.split("\n").find((line) => /heading "Step 2\. Payment"/.test(line));
      assert.ok(heading, `annotatable heading missing from snapshot:\n${snapshot}`);
      run("chrome-devtools-axi", ["click", `@${heading.trim().split(/\s+/)[0].replace(/^uid=/, "")}`], chromeEnv);
      const deadline = Date.now() + 30_000;
      for (;;) {
        const report = run("chrome-devtools-axi", ["snapshot"], chromeEnv).match(/card-report:([^"\s]+)/)?.[1];
        if (report) return JSON.parse(decodeURIComponent(report));
        if (Date.now() > deadline) assert.fail("the annotation box never reported its geometry");
        await wait(500);
      }
    }

    try {
      const artifact = path.join(temp, "review.html");
      await writeFile(artifact, ARTIFACT);
      const output = run(process.execPath, ["bin/lavish-axi.js", artifact, "--no-open"], lavishEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);

      // His window: 1707 CSS pixels wide at scale 1.5.
      await open(url, "1707x950x1.5");
      await t.test("the Conversation box in his window", () => {
        assertConversationBox("window", evaluate(MEASURE_COMPOSER));
      });
      await t.test("the annotation box in his window", async () => {
        assertAnnotationBox("window annotation", await measureAnnotationBox());
      });

      // A phone: the annotation box over the page, then the Conversation box in the raised sheet.
      await open(url, "390x844x3,mobile,touch");
      await t.test("the annotation box on a phone", async () => {
        assertAnnotationBox("phone annotation", await measureAnnotationBox());
      });
      await t.test("the Conversation box on a phone", async () => {
        evaluate('() => { document.getElementById("panelHead").click(); return "ok"; }');
        await wait(600);
        assertConversationBox("phone", evaluate(MEASURE_COMPOSER));
      });
    } finally {
      run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15_000);
      run("chrome-devtools-axi", ["stop"], chromeEnv);
      // Windows keeps the profile's lockfile a moment after Chrome exits.
      await rm(temp, { recursive: true, force: true, maxRetries: 10 });
    }
  },
);
