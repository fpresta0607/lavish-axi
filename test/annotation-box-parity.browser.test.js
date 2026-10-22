import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The annotation box on a highlighted component is the Conversation box, measured in a real browser
// through the real chrome and server. Its field is drawn by the same component, part for part: the
// paperclip at the bottom left, the board's voice bubble at the bottom right, a picker that offers
// the phone's photo library. A pasted screenshot attaches, the held keys dictate into it, the
// bubble lists the recent dictations to paste back, and a sent note reaches the agent's feedback
// with its image and its dictated words. Sending closes the box.
// The page's own script reads the box out of its shadow root when the test asks, and writes what it
// found into the page as text, where the chrome's snapshot of the frame can read it.
const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A 2x1 PNG (the same bytes the server attachment tests use).
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8BQz0BkYGAAADAAA/8W1p0AAAAASUVORK5CYII=";
const PNG_ID = `${createHash("sha256").update(Buffer.from(PNG_B64, "base64")).digest("hex")}.png`;

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

// The shape of a message box: each element's tag, classes and role, with ids left out, so two
// boxes drawn by one component read the same and a box with a part of its own does not.
const BOX_SHAPE = `function boxShape(textarea) {
  var box = textarea;
  while (box && parseFloat(getComputedStyle(box).borderTopWidth) === 0) box = box.parentElement;
  function shape(el) {
    return {
      tag: el.tagName.toLowerCase(),
      classes: Array.prototype.slice.call(el.classList).sort().join(" "),
      label: el.getAttribute("aria-label") || "",
      children: Array.prototype.map.call(el.children, shape),
    };
  }
  return box ? shape(box) : null;
}
function bubbleLook(button) {
  var style = getComputedStyle(button);
  var frame = getComputedStyle(button, "::before");
  return { width: button.getBoundingClientRect().width, radius: style.borderTopLeftRadius, color: style.color, frame: frame.clipPath, fill: frame.backgroundColor, outline: frame.boxShadow };
}`;

// Runs in the reviewed page: the open annotation box, its parts by what a reader calls them.
const ARTIFACT = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Annotation box fixture</title>
<style>html,body{background:#fff;color:#111}body{margin:0;padding:24px;font-family:system-ui,sans-serif}section{padding:16px;margin:16px 0}</style>
</head><body>
<h1>Checkout redesign</h1>
<section><h2>Step 1. Address</h2><p>Autofill from the browser profile.</p></section>
<section><h2>Step 2. Payment</h2><p>Card, Apple Pay and Link.</p></section>
<p id="report">report:0:</p>
<script>
${BOX_SHAPE}
var reports = 0;
function report(value) {
  reports += 1;
  document.getElementById("report").textContent = "report:" + reports + ":" + encodeURIComponent(JSON.stringify(value));
}
function shadow() {
  var host = document.querySelector(".lavish-annotation-root");
  return host ? host.shadowRoot : null;
}
function openCard() {
  var root = shadow();
  return root ? root.querySelector(".lavish-annotation-card") : null;
}
function named(scope, pattern) {
  return Array.prototype.find.call(scope.querySelectorAll("button"), function (button) {
    return pattern.test(button.getAttribute("aria-label") || "");
  }) || null;
}
function rect(el) {
  var r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
}
function control(el) {
  return el ? { rect: rect(el), words: el.textContent.trim(), label: el.getAttribute("aria-label") || "", tip: el.getAttribute("data-tip") || "" } : null;
}
function measure() {
  var card = openCard();
  if (!card) return { card: false, chip: Boolean(shadow() && shadow().querySelector(".lavish-annotation-chip")) };
  var textarea = card.querySelector("textarea");
  var box = textarea;
  while (box && parseFloat(getComputedStyle(box).borderTopWidth) === 0) box = box.parentElement;
  var picker = card.querySelector('input[type="file"]');
  return {
    card: true,
    box: rect(box),
    text: rect(textarea),
    value: textarea.value,
    attach: control(named(card, /^Attach image/)),
    voice: control(named(card, /^(Recent dictations|Listening)$/)),
    picker: picker ? { accept: picker.accept, multiple: picker.multiple, capture: picker.hasAttribute("capture") } : null,
    shape: boxShape(textarea),
    look: bubbleLook(named(card, /^(Recent dictations|Listening)$/)),
    chips: Array.prototype.map.call(card.querySelectorAll(".lavish-attachment-chip"), function (chip) { return chip.textContent.trim(); }),
    recent: Array.prototype.map.call(card.querySelectorAll('[role="dialog"][aria-label="Recent dictations"]:not([hidden]) li'), function (item) {
      return Array.prototype.map.call(item.querySelectorAll("button"), function (button) { return button.getAttribute("aria-label"); });
    }),
  };
}
function pasteImage() {
  var card = openCard();
  var bin = atob("${PNG_B64}");
  var bytes = new Uint8Array(bin.length);
  for (var j = 0; j < bin.length; j += 1) bytes[j] = bin.charCodeAt(j);
  var dt = new DataTransfer();
  dt.items.add(new File([bytes], "screenshot.png", { type: "image/png" }));
  card.querySelector("textarea").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
}
window.addEventListener("message", function (event) {
  var step = event.data && event.data.fixture;
  if (!step) return;
  var card = openCard();
  if (step === "write") {
    var textarea = card.querySelector("textarea");
    textarea.value = event.data.words;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (step === "paste-image") pasteImage();
  if (step === "open-recent") named(card, /^Recent dictations$/).click();
  if (step === "paste-recent") named(card, /^Paste into this box: /).click();
  setTimeout(function () { report(measure()); }, 150);
});
</script>
</body></html>`;

// A recognizer that hears the phrase the test sets once its key is released, and a microphone that
// is a silent tone, installed in the chrome, which is the one that listens.
const FAKE_VOICE = `() => {
  const context = new AudioContext();
  const tone = context.createOscillator();
  const microphone = context.createMediaStreamDestination();
  tone.connect(microphone);
  tone.start();
  window.__voicePhrase = "";
  navigator.mediaDevices.getUserMedia = async () => microphone.stream;
  window.SpeechRecognition = class {
    start() {}
    stop() {
      this.onresult?.({ resultIndex: 0, results: [[{ transcript: window.__voicePhrase }]] });
      this.onend?.();
    }
    abort() {
      this.onend?.();
    }
  };
  return "ok";
}`;

// One control inside the box at the named corner, an icon with a name and a tooltip, the text
// ending above it.
function assertInBox(where, measured, name, corner) {
  const { box, text } = measured;
  const control = measured[name];
  assert.ok(control, `${where}: the box has its ${name} button: ${JSON.stringify(measured)}`);
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
  assert.ok(control.label && control.tip, `${where} ${name} has a name and a tooltip`);
}

// The annotation box is the Conversation box: the same parts in the same places, its voice bubble
// drawn the same, and a picker that takes several images and leaves the phone's chooser, photo
// library included, to the phone.
function assertSameBox(where, measured, conversation) {
  assert.equal(measured.card, true, `${where}: the annotation box is open`);
  assertInBox(where, measured, "attach", "left");
  assertInBox(where, measured, "voice", "right");
  assert.deepEqual(
    measured.picker,
    { accept: "image/png,image/jpeg,image/webp", multiple: true, capture: false },
    `${where}: the paperclip offers images, several at once, from wherever the device keeps them`,
  );
  assert.deepEqual(measured.shape, conversation.shape, `${where}: the annotation box is the Conversation box`);
  assert.match(measured.look.frame, /^polygon\(/, `${where}: the bubble draws the board's pixel frame`);
  assert.deepEqual(measured.look, conversation.look, `${where}: the bubble looks as the Conversation box's does`);
}

test(
  "the annotation box is the Conversation box, with the paperclip, pasted images, dictation and the voice bubble",
  { skip: !runBrowserE2e, timeout: 1_200_000 },
  async (t) => {
    const temp = await realpath(await mkdtemp(path.join(tmpdir(), "lavish-annotation-box-")));
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
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-annotation-box-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
      CHROME_DEVTOOLS_AXI_CHROME_ARGS: "--autoplay-policy=no-user-gesture-required",
    };
    const artifact = path.join(temp, "review.html");

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const snapshot = () => run("chrome-devtools-axi", ["snapshot"], chromeEnv);
    const has = (shot, pattern) => shot.split("\n").some((line) => pattern.test(line));

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

    // Snapshot refs go stale after every action, so each click resolves a fresh one.
    function click(pattern) {
      const shot = snapshot();
      const line = shot.split("\n").find((candidate) => pattern.test(candidate));
      assert.ok(line, `no snapshot line matching ${pattern}:\n${shot}`);
      run("chrome-devtools-axi", ["click", `@${line.trim().split(/\s+/)[0].replace(/^uid=/, "")}`], chromeEnv);
    }

    // Asks the page to act on its box and waits, with a cap, for the report that follows.
    let lastReport = 0;
    /** @param {object} step @param {(measured: any) => boolean} [isReady] */
    async function ask(step, isReady = () => true, seconds = 30) {
      evaluate(
        `() => { document.getElementById("artifact").contentWindow.postMessage(${JSON.stringify(step)}, "*"); return "ok"; }`,
      );
      const deadline = Date.now() + seconds * 1000;
      for (;;) {
        const match = snapshot().match(/report:(\d+):([^"\s]*)/);
        if (match && Number(match[1]) > lastReport) {
          lastReport = Number(match[1]);
          const measured = JSON.parse(decodeURIComponent(match[2]));
          if (isReady(measured)) return measured;
          evaluate(
            `() => { document.getElementById("artifact").contentWindow.postMessage({ fixture: "measure" }, "*"); return "ok"; }`,
          );
        }
        if (Date.now() > deadline) assert.fail(`the page never reported a ready box after ${JSON.stringify(step)}`);
        await wait(1000);
      }
    }

    // A real click on a heading highlights it and opens its box.
    async function openBox(heading) {
      click(heading);
      return ask({ fixture: "measure" }, (measured) => measured.card);
    }

    function conversation() {
      return evaluate(
        `() => { ${BOX_SHAPE} return JSON.stringify({ shape: boxShape(document.getElementById("chatInput")), look: bubbleLook(document.getElementById("chatVoice")) }); }`,
      );
    }

    // Send to Agent, then what the agent's next poll is handed, read as the supervisor reads it.
    async function sendAndReadFeedback() {
      await ask({ fixture: "measure" }, (measured) => !measured.card);
      const shot = snapshot();
      assert.ok(has(shot, /In your notes/), `the note waits in his notes for a send:\n${shot}`);
      click(/button "Send to Agent"/);
      const response = await fetch(
        `http://127.0.0.1:${port}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=30000`,
      );
      assert.equal(response.status, 200);
      const feedback = await response.json();
      assert.equal(feedback.status, "feedback", JSON.stringify(feedback));
      const closed = await ask({ fixture: "measure" }, (measured) => !measured.card && !measured.chip);
      assert.deepEqual(closed, { card: false, chip: false }, "the sent note's box closes");
      return feedback.prompts;
    }

    try {
      await writeFile(artifact, ARTIFACT);
      const output = run(process.execPath, ["bin/lavish-axi.js", artifact, "--no-open"], lavishEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);
      // A fresh browser has no page to act on, so it opens a blank one first; emulation needs one too.
      run("chrome-devtools-axi", ["open", "data:text/html,"], chromeEnv);
      run("chrome-devtools-axi", ["emulate", "--viewport", "1707x950x1.5"], chromeEnv);
      run("chrome-devtools-axi", ["open", url], chromeEnv);
      await wait(4000);

      await t.test("in his window the annotation box is the Conversation box", async () => {
        assertSameBox("window", await openBox(/heading "Step 2\. Payment"/), conversation());
      });

      await t.test("a pasted screenshot attaches and reaches the agent with the note", async () => {
        const pasted = await ask({ fixture: "paste-image" }, (measured) =>
          measured.chips.some((chip) => /screenshot\.png/.test(chip) && !/Uploading/.test(chip)),
        );
        assert.ok(pasted.chips.length === 1, `one image chip: ${JSON.stringify(pasted.chips)}`);
        await ask({ fixture: "write", words: "Make the payment step stand out" });
        run("chrome-devtools-axi", ["press", "Enter"], chromeEnv);
        const prompts = await sendAndReadFeedback();
        assert.equal(prompts.length, 1, JSON.stringify(prompts));
        assert.equal(prompts[0].prompt, "Make the payment step stand out");
        assert.equal(prompts[0].tag, "h2");
        assert.deepEqual(
          prompts[0].attachments.map((attachment) => attachment.id),
          [PNG_ID],
          `the image reaches the agent with the note: ${JSON.stringify(prompts[0])}`,
        );
      });

      await t.test("the held keys dictate into the annotation box, and its bubble lists them", async () => {
        evaluate(FAKE_VOICE);
        evaluate(`() => { window.__voicePhrase = "Say which address is billed"; return "ok"; }`);
        await openBox(/heading "Step 1\. Address"/);
        run("chrome-devtools-axi", ["press", "Control+Shift+Space"], chromeEnv);
        const heard = await ask({ fixture: "measure" }, (measured) => measured.value !== "");
        assert.equal(heard.value, "Say which address is billed", "what was heard lands in the annotation box");

        await ask({ fixture: "write", words: "" });
        const listed = await ask({ fixture: "open-recent" });
        assert.deepEqual(listed.recent, [
          ["Copy: Say which address is billed", "Paste into this box: Say which address is billed"],
        ]);
        const pasted = await ask({ fixture: "paste-recent" });
        assert.equal(pasted.value, "Say which address is billed", "Paste puts the dictation back into the box");
        assert.deepEqual(pasted.recent, [], "Paste closes the list");

        run("chrome-devtools-axi", ["press", "Enter"], chromeEnv);
        const prompts = await sendAndReadFeedback();
        assert.equal(prompts.length, 1, JSON.stringify(prompts));
        assert.equal(prompts[0].prompt, "Say which address is billed", "the dictated words reach the agent");
        assert.equal(prompts[0].tag, "h2");
      });

      run("chrome-devtools-axi", ["emulate", "--viewport", "390x844x3,mobile,touch"], chromeEnv);
      run("chrome-devtools-axi", ["open", url], chromeEnv);
      await wait(4000);
      lastReport = 0;
      await t.test("on a phone the annotation box is the Conversation box", async () => {
        assertSameBox("phone", await openBox(/heading "Step 2\. Payment"/), conversation());
      });
    } finally {
      run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15_000);
      run("chrome-devtools-axi", ["stop"], chromeEnv);
      // Windows keeps the profile's lockfile a moment after Chrome exits.
      await rm(temp, { recursive: true, force: true, maxRetries: 10 });
    }
  },
);
