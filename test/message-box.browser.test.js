import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Both message boxes, measured in a real browser: the Conversation box and the annotation box each
// keep their paperclip at the bottom left and the board's square voice bubble at the bottom right,
// inside the box the reader sees, as an icon with a name and a tooltip but no words. The text ends
// above the buttons however long it grows.
// The box is found the way a reader finds it, as the nearest element around the text that draws a
// border, so a button drawn under or beside the box fails whatever the markup calls it. The bubble
// is held to the board's look by what it draws: the stepped pixel frame, its leather fill and bone
// outline, widening with a moss outline and bars that move with the voice while it listens. A click
// on it opens the recent dictations above the box, where Paste puts one back into the box.
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
  var controls = { attach: card.querySelector("#lavishCardAttach"), voice: card.querySelector("#lavishCardVoice") };
  var empty = measureBox(textarea, controls);
  textarea.value = longNote();
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise(function (resolve) { requestAnimationFrame(function () { requestAnimationFrame(resolve); }); });
  var full = measureBox(textarea, controls);
  document.getElementById("card-report").textContent = "card-report:" + encodeURIComponent(JSON.stringify({ empty: empty, full: full }));
})();
</script>
</body></html>`;

// What the voice bubble draws: its frame, fill and outline are on its ::before, as the board's are,
// and the goblin palette is read from the page's own tokens rather than written out here.
const BUBBLE_LOOK = `function bubbleLook(button) {
  var r = button.getBoundingClientRect();
  var style = getComputedStyle(button);
  var frame = getComputedStyle(button, "::before");
  var icon = button.querySelector("svg");
  var bars = document.getElementById("chatVoiceBars");
  function token(name) {
    var probe = document.createElement("i");
    probe.style.color = "var(" + name + ")";
    button.appendChild(probe);
    var color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }
  return {
    width: r.width,
    height: r.height,
    radius: style.borderTopLeftRadius,
    color: style.color,
    frame: frame.clipPath,
    fill: frame.backgroundColor,
    outline: frame.boxShadow,
    hide: token("--hide"),
    bone: token("--bone"),
    moss: token("--moss"),
    icon: icon && getComputedStyle(icon).display !== "none" ? icon.getBoundingClientRect().width : 0,
    bars: bars && getComputedStyle(bars).display !== "none"
      ? Array.prototype.map.call(bars.children, function (bar) { return new DOMMatrix(getComputedStyle(bar).transform).d; })
      : null,
  };
}`;

// A recognizer that hears the phrase the test sets once its key is released, and a microphone that
// is a tone the test turns up and down, so the bars have a voice to follow and fall silent with it.
const FAKE_VOICE = `() => {
  const context = new AudioContext();
  const tone = context.createOscillator();
  const gain = context.createGain();
  const microphone = context.createMediaStreamDestination();
  gain.gain.value = 0;
  tone.connect(gain).connect(microphone);
  tone.start();
  window.__voiceGain = gain;
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

// Five dictations long enough to fill three lines each, more than the room above the box holds.
const LONG_DICTATIONS = [1, 2, 3, 4, 5].map(
  (n) =>
    `Long note ${n} asks for the pricing cards to share one height, the plan names to sit on one line, and the yearly toggle to move above the cards`,
);

const voiceKey = (type) =>
  `() => { document.dispatchEvent(new KeyboardEvent("${type}", { code: "Space", key: " ", ctrlKey: true, shiftKey: true, bubbles: true })); return "ok"; }`;

const MEASURE_COMPOSER = `() => {
  ${MEASURE_BOX}
  const textarea = document.getElementById("chatInput");
  const controls = { attach: document.getElementById("chatAttach"), voice: document.getElementById("chatVoice") };
  const words = (id) => document.getElementById(id).textContent.trim();
  const rect = (id) => {
    const r = document.getElementById(id).getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  };
  ${BUBBLE_LOOK}
  const saved = textarea.value;
  const empty = measureBox(textarea, controls);
  textarea.value = longNote();
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  const full = measureBox(textarea, controls);
  textarea.value = saved;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  return JSON.stringify({
    empty,
    full,
    look: bubbleLook(controls.voice),
    sendAndEnd: { words: words("sendAndEnd"), rect: rect("sendAndEnd") },
    send: { words: words("send"), rect: rect("send") },
  });
}`;

// The recent dictations, found as the reader finds them: the dialog the bubble names. A card the
// reader can see answers a hit near its corners and in its middle, so one clipped by the box or
// covered by the conversation fails.
const MEASURE_RECENT = `() => {
  const bubble = document.getElementById("chatVoice");
  const textarea = document.getElementById("chatInput");
  let box = textarea;
  while (box && parseFloat(getComputedStyle(box).borderTopWidth) === 0) box = box.parentElement;
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  };
  const focused = document.activeElement;
  const card = document.querySelector('[role="dialog"][aria-label="Recent dictations"]');
  const measured = {
    expanded: bubble.getAttribute("aria-expanded"),
    value: textarea.value,
    focus: focused === bubble ? "bubble" : focused === textarea ? "box" : focused ? focused.id || focused.tagName : "",
    focusLabel: focused?.getAttribute("aria-label") || "",
    box: rect(box),
    viewport: { width: innerWidth, height: innerHeight },
    sheet: document.body.classList.contains("sheet-open"),
    card: null,
  };
  if (!card || !card.getClientRects().length) return JSON.stringify(measured);
  const r = card.getBoundingClientRect();
  const points = [[r.left + 12, r.top + 12], [r.right - 12, r.top + 12], [(r.left + r.right) / 2, (r.top + r.bottom) / 2], [r.right - 12, r.bottom - 12]];
  measured.card = {
    rect: rect(card),
    seen: points.map(([x, y]) => card.contains(document.elementFromPoint(x, y))),
    frame: getComputedStyle(card, "::before").clipPath,
    words: card.textContent.replace(/\\s+/g, " ").trim(),
    entries: Array.from(card.querySelectorAll("li"), (item) => ({
      words: item.textContent.replace(/\\s+/g, " ").trim(),
      buttons: Array.from(item.querySelectorAll("button"), (button) => button.getAttribute("aria-label")),
    })),
  };
  return JSON.stringify(measured);
}`;

// The board's voice bubble, idle: the stepped pixel frame, the leather fill with a bone outline,
// and a bone microphone. Listening, the same frame widens with a moss outline and shows the bars.
// The sizes are the ones the board's own rules draw.
function assertBubbleLook(where, look, listening) {
  const detail = `${where}: ${JSON.stringify(look)}`;
  assert.match(look.frame, /^polygon\(/, `the bubble draws the stepped pixel frame: ${detail}`);
  assert.equal(look.radius, "0px", `the bubble is square: ${detail}`);
  assert.equal(look.fill, look.hide, `the bubble is filled with the board's leather: ${detail}`);
  assert.equal(look.color, look.bone, `the bubble's microphone and bars are bone: ${detail}`);
  // The board's rule says 40px, under the board's 44px floor for every button, so it draws 44.
  assert.ok(Math.abs(look.height - 44) < 0.5, `the bubble is the board's 44px tall: ${detail}`);
  if (listening) {
    assert.ok(look.outline.includes(look.moss) && look.outline.includes("inset"), `a moss outline: ${detail}`);
    assert.ok(look.width >= 112 - 0.5, `the bubble widens while it listens: ${detail}`);
    assert.equal(look.icon, 0, `the microphone gives way to the bars: ${detail}`);
    assert.equal(look.bars?.length, 9, `nine bars show: ${detail}`);
  } else {
    assert.ok(look.outline.includes(look.bone) && look.outline.includes("inset"), `a bone outline: ${detail}`);
    assert.ok(look.width >= 64 - 0.5, `the bubble is the board's 64px wide: ${detail}`);
    assert.ok(Math.abs(look.icon - 22) < 0.5, `the microphone is the board's 22px: ${detail}`);
    assert.equal(look.bars, null, `no bars while idle: ${detail}`);
  }
}

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

function assertConversationBox(where, measured, listening = false) {
  for (const state of ["empty", "full"]) {
    assertInBox(`${where}, ${state}`, measured[state], "attach", "left");
    assertInBox(`${where}, ${state}`, measured[state], "voice", "right");
  }
  assertBubbleLook(where, measured.look, listening);
  assert.equal(measured.full.textScrolls, true, `${where}: sixty lines scroll inside the box`);
  assert.ok(measured.full.textHeight <= 240, `${where}: the text area stops growing at its cap`);
  assert.equal(measured.sendAndEnd.words, "Send & End");
  assert.equal(measured.send.words, "Send to Agent");
  assert.ok(measured.sendAndEnd.rect.top >= measured.empty.box.bottom, `${where}: Send & End stays under the box`);
  assert.ok(measured.send.rect.left >= measured.sendAndEnd.rect.right, `${where}: Send to Agent stays on the right`);
}

function assertAnnotationBox(where, measured) {
  for (const state of ["empty", "full"]) {
    assertInBox(`${where}, ${state}`, measured[state], "attach", "left");
    assertInBox(`${where}, ${state}`, measured[state], "voice", "right");
  }
  assert.equal(measured.full.textScrolls, true, `${where}: sixty lines scroll inside the box`);
}

// The card opens above the box, inside its width and on screen, in the board's frame, newest
// dictation first, each with Copy and Paste into this box.
function assertRecentOpen(where, measured, phrases) {
  const detail = `${where}: ${JSON.stringify(measured)}`;
  assert.ok(measured.card, `the recent dictations open from the bubble: ${detail}`);
  const { card, box } = measured;
  assert.equal(measured.expanded, "true", `the bubble says its list is open: ${detail}`);
  assert.match(card.frame, /^polygon\(/, `the card draws the board's stepped frame: ${detail}`);
  assert.match(card.words, /^Recent dictations/, `the card is titled: ${detail}`);
  assert.ok(card.rect.bottom <= box.top + 0.5, `the card opens above the box: ${detail}`);
  assert.ok(
    card.rect.left >= box.left - 0.5 && card.rect.right <= box.right + 0.5,
    `within the box's width: ${detail}`,
  );
  assert.ok(card.rect.top >= 0 && card.rect.right <= measured.viewport.width, `on screen: ${detail}`);
  assert.deepEqual(card.seen, [true, true, true, true], `nothing clips or covers the card: ${detail}`);
  assert.deepEqual(
    card.entries.map((entry) => entry.buttons),
    phrases.map((phrase) => [`Copy: ${phrase}`, `Paste into this box: ${phrase}`]),
    `each dictation, newest first, has Copy and Paste: ${detail}`,
  );
  phrases.forEach((phrase, index) => assert.ok(card.entries[index].words.includes(phrase), detail));
}

test(
  "the message boxes hold their paperclip and the board's voice bubble inside the box, in a window and on a phone",
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
      // The microphone's tone plays without a gesture, as a held key in a real window would allow.
      CHROME_DEVTOOLS_AXI_CHROME_ARGS: "--autoplay-policy=no-user-gesture-required",
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

    // Snapshot refs go stale after every action, so each click resolves a fresh one.
    function click(pattern) {
      const snapshot = run("chrome-devtools-axi", ["snapshot"], chromeEnv);
      const line = snapshot.split("\n").find((candidate) => pattern.test(candidate));
      assert.ok(line, `no snapshot line matching ${pattern}:\n${snapshot}`);
      run("chrome-devtools-axi", ["click", `@${line.trim().split(/\s+/)[0].replace(/^uid=/, "")}`], chromeEnv);
    }

    // The bars take the microphone's level at the page's own pace, which a busy machine slows, so
    // they get a few seconds to settle.
    async function settledBars(isSettled) {
      const read = () =>
        evaluate(`() => { ${BUBBLE_LOOK} return JSON.stringify(bubbleLook(document.getElementById("chatVoice"))); }`);
      const deadline = Date.now() + 8000;
      let look = read();
      while (!(look.bars && isSettled(look.bars)) && Date.now() < deadline) {
        await wait(300);
        look = read();
      }
      return look;
    }

    // Holding Ctrl+Shift+Space while a tone plays: the bubble listens in the board's look and its
    // bars rise with the tone and fall back once it stops. Releasing the keys types the phrase.
    async function dictate(where, phrase) {
      evaluate(FAKE_VOICE);
      evaluate(`() => { window.__voicePhrase = ${JSON.stringify(phrase)}; return "ok"; }`);
      evaluate(voiceKey("keydown"));
      evaluate('() => { window.__voiceGain.gain.value = 1; return "ok"; }');
      const risen = await settledBars((bars) => Math.min(...bars) > 0.5);
      assert.ok(Math.min(...risen.bars) > 0.5, `${where}: the bars rise with the voice: ${risen.bars}`);
      assertConversationBox(`${where}, listening`, evaluate(MEASURE_COMPOSER), true);
      evaluate('() => { window.__voiceGain.gain.value = 0; return "ok"; }');
      const silent = await settledBars((bars) => Math.max(...bars) <= 0.25);
      assert.ok(Math.max(...silent.bars) <= 0.25, `${where}: the bars fall back in silence: ${silent.bars}`);
      evaluate(voiceKey("keyup"));
      await wait(300);
      assert.equal(evaluate(MEASURE_RECENT).value, phrase, `${where}: what was heard lands in the box`);
    }

    // A real click on the bubble opens the recent dictations, a real click on Paste puts the newest
    // into the emptied box and closes the card, and Escape closes it again with the keyboard back
    // on the bubble.
    async function useRecentDictations(where, phrases) {
      evaluate(
        '() => { const box = document.getElementById("chatInput"); box.value = ""; box.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; }',
      );
      click(/button "Recent dictations"/);
      await wait(400);
      assertRecentOpen(where, evaluate(MEASURE_RECENT), phrases);
      run("chrome-devtools-axi", ["press", "Tab"], chromeEnv);
      await wait(200);
      assert.equal(
        evaluate(MEASURE_RECENT).focusLabel,
        "Close recent dictations",
        `${where}: Tab goes from the bubble into the card`,
      );

      click(new RegExp(`button "Paste into this box: ${phrases[0]}"`));
      await wait(400);
      const pasted = evaluate(MEASURE_RECENT);
      assert.equal(pasted.value, phrases[0], `${where}: Paste puts the dictation into the box`);
      assert.equal(pasted.card, null, `${where}: Paste closes the card`);
      assert.equal(pasted.expanded, "false", `${where}: the bubble says its list is closed`);
      assert.equal(pasted.focus, "box", `${where}: the keyboard is in the box after Paste`);

      click(/button "Recent dictations"/);
      await wait(400);
      run("chrome-devtools-axi", ["press", "Escape"], chromeEnv);
      await wait(400);
      const escaped = evaluate(MEASURE_RECENT);
      assert.equal(escaped.card, null, `${where}: Escape closes the card`);
      assert.equal(escaped.focus, "bubble", `${where}: Escape puts the keyboard back on the bubble`);
      return escaped;
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
      await t.test("the voice bubble listening in his window", async () => {
        await dictate("window", "Make the header sticky");
      });
      await t.test("the recent dictations in his window", async () => {
        await useRecentDictations("window", ["Make the header sticky"]);
      });
      await t.test("the annotation box in his window", async () => {
        assertAnnotationBox("window annotation", await measureAnnotationBox());
      });

      // A phone: the annotation box over the page, then the Conversation box in the raised sheet.
      // The page loads afresh, so the window's dictation still listed proves the browser kept it.
      await open(url, "390x844x3,mobile,touch");
      await t.test("the annotation box on a phone", async () => {
        assertAnnotationBox("phone annotation", await measureAnnotationBox());
      });
      await t.test("the Conversation box on a phone", async () => {
        evaluate('() => { document.getElementById("panelHead").click(); return "ok"; }');
        await wait(600);
        assertConversationBox("phone", evaluate(MEASURE_COMPOSER));
      });
      await t.test("the voice bubble listening on a phone", async () => {
        await dictate("phone", "Tighten the card spacing");
      });
      await t.test("the recent dictations on a phone", async () => {
        const closed = await useRecentDictations("phone", ["Tighten the card spacing", "Make the header sticky"]);
        assert.equal(closed.sheet, true, "Escape on the card leaves the conversation sheet raised");
      });

      // A full list of long dictations: the card stops at the top of the panel and its list
      // scrolls, so its title and close button stay in sight.
      await t.test("five long dictations fit above the box on a phone", async () => {
        for (const phrase of LONG_DICTATIONS) {
          evaluate(`() => { window.__voicePhrase = ${JSON.stringify(phrase)}; return "ok"; }`);
          evaluate(voiceKey("keydown"));
          await wait(300);
          evaluate(voiceKey("keyup"));
          await wait(200);
        }
        evaluate(
          '() => { const box = document.getElementById("chatInput"); box.value = ""; box.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; }',
        );
        click(/button "Recent dictations"/);
        await wait(400);
        assertRecentOpen("phone, five long", evaluate(MEASURE_RECENT), [...LONG_DICTATIONS].reverse());
      });
      await open(url, "1707x950x1.5");
      await t.test("five long dictations fit above the box in his window", async () => {
        click(/button "Recent dictations"/);
        await wait(400);
        assertRecentOpen("window, five long", evaluate(MEASURE_RECENT), [...LONG_DICTATIONS].reverse());
      });
    } finally {
      run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15_000);
      run("chrome-devtools-axi", ["stop"], chromeEnv);
      // Windows keeps the profile's lockfile a moment after Chrome exits.
      await rm(temp, { recursive: true, force: true, maxRetries: 10 });
    }
  },
);
