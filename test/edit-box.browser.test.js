import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Every box he writes to the agent in is the one message box, in a real browser through the real
// chrome and server, in his window and on a phone. A box opens six ways: a clicked component,
// selected text, a table cell, a node of a drawn diagram, the pencil on a note in the Conversation
// panel, and Other on a question the page asks. Each shows the microphone and the paperclip and
// takes a pasted image. Enter puts the edit in his notes and leaves nothing of the box on the page:
// no chip, no outline, no pin. Send to Agent then hands the agent every edit with its image.
// The page's own script reads its boxes out of their shadow roots when the test asks, and writes
// what it found into the page as text, where the chrome's snapshot of the frame can read it.
const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A 2x1 PNG (the same bytes the server attachment tests use) and a 3x2 one.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8BQz0BkYGAAADAAA/8W1p0AAAAASUVORK5CYII=";
const SECOND_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGMQ2NkIQQxwFgBKxge9rCEhLwAAAABJRU5ErkJggg==";
const idOf = (b64) => `${createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex")}.png`;
const PNG_ID = idOf(PNG_B64);
const SECOND_PNG_ID = idOf(SECOND_PNG_B64);

function run(command, args, env, timeout = 60_000) {
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

// Builds a pasted image in whichever document runs it.
const PASTE = `function pasteInto(textarea, b64, name) {
  var bin = atob(b64);
  var bytes = new Uint8Array(bin.length);
  for (var j = 0; j < bin.length; j += 1) bytes[j] = bin.charCodeAt(j);
  var dt = new DataTransfer();
  dt.items.add(new File([bytes], name, { type: "image/png" }));
  textarea.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
}
function shown(el) {
  if (!el) return false;
  var r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
}`;

// A page with something to annotate each way: a heading, a paragraph, a table, a diagram drawn as
// Mermaid draws one, and a question.
const ARTIFACT = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Edit box fixture</title>
<style>html,body{background:#fff;color:#111}body{margin:0;padding:24px;font-family:system-ui,sans-serif}section{padding:8px 0;margin:8px 0}table{border-collapse:collapse}td,th{border:1px solid #999;padding:6px 10px}#report{font-size:10px;color:#777;word-break:break-all}</style>
</head><body>
<h1>Checkout redesign</h1>
<section><h2 id="step">Step 1. Address</h2><p id="para">Autofill from the browser profile and confirm the postcode.</p></section>
<table><thead><tr><th>Device</th><th>Share</th></tr></thead><tbody><tr><th scope="row">Tablet</th><td id="cell">Eleven percent</td></tr></tbody></table>
<svg id="mermaid-fixture" aria-roledescription="flowchart-v2" role="img" viewBox="0 0 320 70" width="320" height="70">
  <g class="nodes">
    <g class="node" id="flowchart-N1-0"><rect x="10" y="15" width="100" height="40" fill="#eef" stroke="#66a"></rect><g class="label"><text x="60" y="40" text-anchor="middle">Basket</text></g></g>
    <g class="node" id="flowchart-N2-1"><rect x="200" y="15" width="100" height="40" fill="#eef" stroke="#66a"></rect><g class="label"><text x="250" y="40" text-anchor="middle">Receipt</text></g></g>
  </g>
</svg>
<script type="application/json" data-lavish-choices>{"id":"ship","question":"Which checkout ships first?","options":["One page","Three steps"],"recommended":"One page"}</script>
<p id="report">report:0:</p>
<script>
${PASTE}
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
function answerBox() {
  var host = document.querySelector(".lavish-choices-root");
  return host && host.shadowRoot ? host.shadowRoot.querySelector(".written-answer") : null;
}
function part(scope, selector) {
  var el = scope.querySelector(selector);
  return Boolean(el) && shown(el) && !el.disabled;
}
function chips(scope) {
  return Array.prototype.map.call(scope.querySelectorAll(".lavish-attachment-chip"), function (chip) { return chip.textContent.trim(); });
}
function box(scope) {
  var textarea = scope.querySelector("textarea");
  return {
    open: shown(textarea),
    words: textarea ? textarea.value : "",
    microphone: part(scope, ".voice-bubble"),
    paperclip: part(scope, 'button[aria-label^="Attach image"]'),
    images: chips(scope),
  };
}
// What an annotation box leaves on the page once it has closed.
function leftOnPage() {
  var root = shadow();
  var left = [];
  var chip = root && root.querySelector(".lavish-annotation-chip");
  if (chip) left.push("a chip: " + chip.textContent.trim().slice(0, 80));
  if (root && root.querySelector(".lavish-text-highlight")) left.push("the text's highlight");
  // An outline that is drawn: clearing one leaves its offset behind in the style, which shows nothing.
  var outlined = Array.prototype.some.call(document.querySelectorAll("[style]"), function (el) { return Boolean(el.style.outline); });
  if (outlined) left.push("the outline");
  if (root && root.querySelector(".lavish-pin:not([hidden])")) left.push("the pin");
  return left;
}
function measure() {
  var card = openCard();
  var answer = answerBox();
  var host = document.querySelector(".lavish-choices-root");
  var waits = host && host.shadowRoot ? host.shadowRoot.querySelector(".question-pending") : null;
  return {
    card: card ? box(card) : null,
    heading: card ? (card.querySelector(".lavish-heading") || {}).textContent || "" : "",
    left: card ? [] : leftOnPage(),
    answer: answer ? box(answer) : null,
    answerWaits: shown(waits),
  };
}
window.addEventListener("message", function (event) {
  var step = event.data && event.data.fixture;
  if (!step) return;
  var card = openCard();
  var answer = answerBox();
  if (step === "select-text") {
    var text = document.getElementById("para").firstChild;
    var range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 8);
    var selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.getElementById("para").dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    // A real drag ends with a click, which the page ignores after a selection.
    document.getElementById("para").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }
  if (step === "click-cell") document.getElementById("cell").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  if (step === "click-node") document.querySelector("#mermaid-fixture g.node").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  if (step === "write" && card) {
    var textarea = card.querySelector("textarea");
    textarea.value = event.data.words;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
  }
  if (step === "paste-image" && card) pasteInto(card.querySelector("textarea"), "${PNG_B64}", "screenshot.png");
  if (step === "choose-other") document.querySelector(".lavish-choices-root").shadowRoot.querySelector('input[value="other"]').click();
  if (step === "answer-paste" && answer) pasteInto(answer.querySelector("textarea"), "${PNG_B64}", "screenshot.png");
  if (step === "answer-write" && answer) {
    var written = answer.querySelector("textarea");
    written.value = event.data.words;
    written.dispatchEvent(new Event("input", { bubbles: true }));
    written.focus();
  }
  setTimeout(function () { report(measure()); }, 250);
});
</script>
</body></html>`;

// The Conversation panel as the chrome draws it: the box, the line above it, and his notes.
const PANEL = `() => {
  ${PASTE}
  const input = document.getElementById("chatInput");
  const anchor = document.getElementById("chatAnchor");
  return JSON.stringify({
    words: input.value,
    line: anchor.hidden ? "" : anchor.textContent.replace(/\\s+/g, " ").trim(),
    focused: document.activeElement === input,
    microphone: shown(document.getElementById("chatVoice")) && !document.getElementById("chatVoice").disabled,
    paperclip: shown(document.getElementById("chatAttach")) && !document.getElementById("chatAttach").disabled,
    images: Array.from(document.querySelectorAll("#chatAttachments .chat-attachment-chip")).map((chip) => chip.textContent.trim()),
    otherEditors: document.querySelectorAll("#queuedLog textarea").length,
    notes: Array.from(document.querySelectorAll("#queuedLog .bubble.queued")).map((bubble) => ({
      words: (bubble.querySelector(".bubble-text") || {}).textContent || "",
      images: bubble.querySelectorAll(".bubble-attachment").length,
    })),
  });
}`;

// The four ways the page's annotation box opens, with what its note is on.
const ANNOTATION_WAYS = [
  { name: "a clicked component", heading: "Annotate <h2>", tag: "h2", words: "Note on a component" },
  { name: "selected text", step: "select-text", heading: "Annotate text", tag: "text", words: "Note on selected text" },
  {
    name: "a table cell",
    step: "click-cell",
    heading: "Annotate cell: Tablet → Share",
    tag: "td",
    words: "Note on a table cell",
  },
  {
    name: "a node of a drawn diagram",
    step: "click-node",
    heading: "Annotate node: Basket",
    tag: "mermaid-node",
    words: "Note on a diagram node",
  },
];
const REWORDED = "Reworded in the Conversation box";
const ANSWER = "Ship it in two steps";

test(
  "every box he writes an edit in is the one message box, and Enter leaves nothing of it on the page",
  { skip: !runBrowserE2e, timeout: 2_400_000 },
  async (t) => {
    const temp = await realpath(await mkdtemp(path.join(tmpdir(), "lavish-edit-box-")));
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
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-edit-box-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const snapshot = () => run("chrome-devtools-axi", ["snapshot", "--full"], chromeEnv);

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

    // Asks the page to act on its boxes and waits, with a cap, for the report that follows. A
    // report that never turns ready is handed back as it is, so the test says what it saw.
    let lastReport = 0;
    /** @param {object} step @param {(measured: any) => boolean} [isReady] */
    async function ask(step, isReady = () => true, seconds = 30) {
      const post = (message) =>
        evaluate(
          `() => { document.getElementById("artifact").contentWindow.postMessage(${JSON.stringify(message)}, "*"); return "ok"; }`,
        );
      post(step);
      const deadline = Date.now() + seconds * 1000;
      let measured = null;
      for (;;) {
        const match = snapshot().match(/report:(\d+):([^"\s]*)/);
        if (match && Number(match[1]) > lastReport) {
          lastReport = Number(match[1]);
          measured = JSON.parse(decodeURIComponent(match[2]));
          if (isReady(measured)) return measured;
          post({ fixture: "measure" });
        }
        if (Date.now() > deadline) return measured || {};
        await wait(800);
      }
    }

    // The Conversation panel, read until it is in the state the step waits for, with a cap.
    /** @param {(state: any) => boolean} [isReady] */
    async function panel(isReady = () => true, seconds = 20) {
      const deadline = Date.now() + seconds * 1000;
      let state = evaluate(PANEL);
      while (!isReady(state) && Date.now() < deadline) {
        await wait(800);
        state = evaluate(PANEL);
      }
      return state;
    }

    const uploaded = (images, name) => images.some((chip) => chip.includes(name) && !/Uploading/.test(chip));

    async function review(sub, viewport, file) {
      const artifact = path.join(temp, file);
      await writeFile(artifact, ARTIFACT);
      const output = run(process.execPath, ["bin/lavish-axi.js", artifact, "--no-open"], lavishEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);
      run("chrome-devtools-axi", ["emulate", "--viewport", viewport], chromeEnv);
      run("chrome-devtools-axi", ["open", url], chromeEnv);
      lastReport = 0;
      const deadline = Date.now() + 40_000;
      while (!/heading "Step 1\. Address"/.test(snapshot())) {
        if (Date.now() > deadline) assert.fail("the page never loaded");
        await wait(1500);
      }
      // The page settles: its fonts, its gate and its question card.
      await wait(3000);

      for (const [index, way] of ANNOTATION_WAYS.entries()) {
        await sub.test(`${way.name} opens the one box, and Enter leaves nothing of it`, async () => {
          if (!way.step) click(/heading "Step 1\. Address"/);
          const opened = await ask({ fixture: way.step || "measure" }, (measured) => Boolean(measured.card));
          assert.ok(opened.card, `the box opened: ${JSON.stringify(opened)}`);
          assert.equal(opened.heading, way.heading);
          const pasted = await ask({ fixture: "paste-image" }, (measured) =>
            uploaded(measured.card?.images || [], "screenshot.png"),
          );
          await ask({ fixture: "write", words: way.words });
          run("chrome-devtools-axi", ["press", "Enter"], chromeEnv);
          const after = await ask({ fixture: "measure" }, (measured) => !measured.card);
          const conversation = await panel((state) => state.notes.length === index + 1 && !state.line);
          assert.deepEqual(
            {
              microphone: opened.card.microphone,
              paperclip: opened.card.paperclip,
              pastedImageAttached: uploaded(pasted.card?.images || [], "screenshot.png"),
              boxAfterEnter: after.card ? "still open" : "gone",
              leftOnThePage: after.left,
              lineAboveTheConversationBox: conversation.line,
              inHisNotes: conversation.notes.at(-1),
            },
            {
              microphone: true,
              paperclip: true,
              pastedImageAttached: true,
              boxAfterEnter: "gone",
              leftOnThePage: [],
              lineAboveTheConversationBox: "",
              inHisNotes: { words: way.words, images: 1 },
            },
          );
        });
      }

      await sub.test("the pencil on a note opens it in the Conversation box, and Enter saves it there", async () => {
        // On a phone the notes are in the sheet, which he opens first.
        evaluate(
          `() => { const toggle = document.getElementById("panelToggle"); if (getComputedStyle(toggle).display !== "none" && toggle.getAttribute("aria-expanded") !== "true") toggle.click(); return "ok"; }`,
        );
        await wait(1200);
        click(/button "Edit note"/);
        const opened = await panel((state) => state.words !== "" || state.otherEditors > 0, 10);
        // He pastes into the box the pencil put him in, and rewords the note there.
        evaluate(
          `() => { ${PASTE} pasteInto(document.activeElement, "${SECOND_PNG_B64}", "second.png"); return "ok"; }`,
        );
        const pasted = await panel((state) => uploaded(state.images, "second.png"), 30);
        evaluate(
          `() => { const box = document.activeElement; box.value = ${JSON.stringify(REWORDED)}; box.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; }`,
        );
        run("chrome-devtools-axi", ["press", "Enter"], chromeEnv);
        const after = await panel((state) => state.notes[0]?.words === REWORDED && state.words === "", 15);
        assert.deepEqual(
          {
            opensInTheConversationBox: opened.words,
            cursorInIt: opened.focused,
            lineAboveIt: /^Editing/.test(opened.line),
            itsImageInTheBox: uploaded(opened.images, "screenshot.png"),
            microphone: opened.microphone,
            paperclip: opened.paperclip,
            boxesOfItsOwn: opened.otherEditors,
            pastedImageAttached: uploaded(pasted.images, "second.png"),
            boxAfterEnter: { words: after.words, images: after.images, line: after.line },
            theNote: after.notes[0],
            notes: after.notes.length,
          },
          {
            opensInTheConversationBox: ANNOTATION_WAYS[0].words,
            cursorInIt: true,
            lineAboveIt: true,
            itsImageInTheBox: true,
            microphone: true,
            paperclip: true,
            boxesOfItsOwn: 0,
            pastedImageAttached: true,
            boxAfterEnter: { words: "", images: [], line: "" },
            theNote: { words: REWORDED, images: 2 },
            notes: ANNOTATION_WAYS.length,
          },
        );
      });

      await sub.test("Other on a question opens the one box, and Enter keeps the answer", async () => {
        const opened = await ask({ fixture: "choose-other" }, (measured) => Boolean(measured.answer?.open));
        assert.ok(opened.answer?.open, `the answer's box opened: ${JSON.stringify(opened)}`);
        const pasted = await ask({ fixture: "answer-paste" }, (measured) =>
          uploaded(measured.answer?.images || [], "screenshot.png"),
        );
        await ask({ fixture: "answer-write", words: ANSWER });
        run("chrome-devtools-axi", ["press", "Enter"], chromeEnv);
        const after = await ask({ fixture: "measure" });
        const conversation = await panel((state) => state.notes.at(-1)?.words === ANSWER && state.notes.at(-1)?.images);
        assert.deepEqual(
          {
            microphone: opened.answer.microphone,
            paperclip: opened.answer.paperclip,
            pastedImageAttached: uploaded(pasted.answer?.images || [], "screenshot.png"),
            answerAfterEnter: after.answer?.words,
            saysItWaitsInHisNotes: after.answerWaits,
            inHisNotes: conversation.notes.at(-1),
          },
          {
            microphone: true,
            paperclip: true,
            pastedImageAttached: true,
            answerAfterEnter: ANSWER,
            saysItWaitsInHisNotes: true,
            inHisNotes: { words: ANSWER, images: 1 },
          },
        );
      });

      await sub.test("Send to Agent hands the agent every edit with its image", async () => {
        evaluate(`() => { document.getElementById("send").click(); return "ok"; }`);
        // What the agent's next poll is handed, read as the supervisor reads it.
        const response = await fetch(
          `http://127.0.0.1:${port}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=30000`,
        );
        assert.equal(response.status, 200);
        const feedback = await response.json();
        assert.equal(feedback.status, "feedback", JSON.stringify(feedback));
        assert.deepEqual(
          feedback.prompts.map((prompt) => ({
            prompt: prompt.prompt,
            tag: prompt.tag,
            images: (prompt.attachments || []).map((attachment) => attachment.id),
          })),
          [
            { prompt: REWORDED, tag: ANNOTATION_WAYS[0].tag, images: [PNG_ID, SECOND_PNG_ID] },
            ...ANNOTATION_WAYS.slice(1).map((way) => ({ prompt: way.words, tag: way.tag, images: [PNG_ID] })),
            { prompt: ANSWER, tag: "choice", images: [PNG_ID] },
          ],
        );
        const page = await ask({ fixture: "measure" });
        assert.deepEqual(
          { box: page.card, left: page.left },
          { box: null, left: [] },
          "nothing of a box is on the page",
        );
      });
    }

    try {
      // A fresh browser has no page to act on, so it opens a blank one first; emulation needs one too.
      run("chrome-devtools-axi", ["open", "data:text/html,"], chromeEnv);
      await t.test("in his window", (sub) => review(sub, "1707x950x1.5", "review-window.html"));
      await t.test("on a phone", (sub) => review(sub, "390x844x3,mobile,touch", "review-phone.html"));
    } finally {
      run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15_000);
      run("chrome-devtools-axi", ["stop"], chromeEnv);
      // Windows keeps the profile's lockfile a moment after Chrome exits.
      await rm(temp, { recursive: true, force: true, maxRetries: 10 });
    }
  },
);
