import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { serve } from "../src/server.js";

// An installed Playwright tool can supply trusted touch input without adding a runtime dependency.
const playwrightModule = process.env.LAVISH_AXI_PLAYWRIGHT_MODULE;
const browserName = process.env.LAVISH_AXI_TOUCH_BROWSER || "chromium";
const FAKE_VOICE = `(() => {
  if (window !== top) return;
  const state = window.voiceTest = { requests: 0, tracks: [], recognizers: [], pending: [], denied: false, delayed: false };
  const getUserMedia = () => {
    state.requests++;
    if (state.denied) return Promise.reject(new DOMException("denied", "NotAllowedError"));
    return new Promise(resolve => {
      const allow = () => {
        const track = { kind: "audio", readyState: "live", stop() { this.readyState = "ended"; } };
        state.tracks.push(track);
        resolve({ getTracks: () => [track], getAudioTracks: () => [track] });
      };
      if (state.delayed) state.pending.push(allow); else allow();
    });
  };
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  window.AudioContext = class {
    createAnalyser() { return { fftSize: 512, getByteTimeDomainData: samples => samples.fill(144) }; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  };
  window.SpeechRecognition = class {
    constructor() { state.recognizers.push(this); this.stops = 0; }
    start(track) {
      const ready = track ? Promise.resolve(track) : navigator.mediaDevices.getUserMedia().then(stream => stream.getAudioTracks()[0]);
      ready.then(opened => {
        this.track = opened;
        if (this.aborted) { opened.stop(); return; }
        this.started = true; this.onstart?.();
      }, () => this.onerror?.({ error: "not-allowed" }));
    }
    stop() { this.stops++; this.track?.stop(); }
    abort() { this.aborted = true; this.track?.stop(); this.onend?.(); }
    finish(text = "the spacing on the") {
      this.track?.stop();
      this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] });
      this.onend?.();
    }
  };
})();`;

test(
  "mobile touch dictation stays with its draft",
  {
    skip: !playwrightModule,
    timeout: 180_000,
  },
  async (t) => {
    const { [browserName]: browserType } = await import(playwrightModule);
    const temp = await mkdtemp(path.join(tmpdir(), "scrawl-touch-"));
    process.env.LAVISH_AXI_STATE_DIR = path.join(temp, "state");
    await mkdir(process.env.LAVISH_AXI_STATE_DIR);
    const server = await serve({
      port: 0,
      hosts: ["127.0.0.1"],
      stateFile: path.join(temp, "state", "state.json"),
      version: "touch-test",
    });
    let browser;
    try {
      browser = await browserType.launch({ headless: true });
      t.diagnostic(
        `Headless ${browserName} ${browser.version()}; synthetic microphone/recognizer, no physical phone evidence`,
      );
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      await context.addInitScript(FAKE_VOICE);
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      page.on("pageerror", (error) => t.diagnostic(error.message));
      const artifact = path.join(temp, "review.html");
      await writeFile(
        artifact,
        '<!doctype html><meta name="viewport" content="width=device-width"><h1>Review heading</h1><p>Second target</p>',
      );
      const base = `http://127.0.0.1:${server.port}`;
      const response = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: artifact }),
      });
      const opened = await response.json();
      assert.equal(response.ok, true, JSON.stringify(opened));
      const { key } = opened;
      assert.ok(key, JSON.stringify(opened));
      const url = `${base}/session/${key}`;
      const messages = [];
      page.on("request", (request) => {
        if (request.url().endsWith("/prompts")) messages.push(request.url());
      });
      const input = page.locator("#chatInput");
      const mic = page.locator("#chatVoice");
      async function screenshot(name) {
        const directory = process.env.LAVISH_AXI_TOUCH_EVIDENCE;
        if (!directory) return;
        await mkdir(directory, { recursive: true });
        await page.screenshot({ path: path.join(directory, `${name}.png`) });
      }
      async function openComposer() {
        const loaded = await page.goto(url);
        assert.equal(loaded.status(), 200, await page.locator("body").innerText());
        assert.equal(await page.evaluate("typeof SpeechRecognition"), "function", "synthetic recognizer is installed");
        await page.locator("#layoutGateOverlay").waitFor({ state: "hidden" });
        if (await input.evaluate((element) => element.closest(".composer").inert))
          await page.locator("#panelToggle").tap();
        await input.fill("Tighten cards");
        await input.evaluate((element) => element.setSelectionRange(7, 7));
      }
      async function finish() {
        await page.evaluate("voiceTest.recognizers.at(-1).finish()");
      }
      async function assertClosed() {
        assert.equal(await page.evaluate("voiceTest.tracks.every(track => track.readyState === 'ended')"), true);
        assert.equal(await mic.evaluate((element) => element.classList.contains("recording")), false);
      }
      async function assertValue(locator, value) {
        for (let attempt = 0; attempt < 50 && (await locator.inputValue()) !== value; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(await locator.inputValue(), value);
      }

      await t.test("a tap starts, the next stops, and the result inserts once without sending", async () => {
        await openComposer();
        await mic.tap();
        assert.equal(await page.evaluate("voiceTest.requests"), 1, "touch must request a microphone, not open history");
        await page.waitForFunction("voiceTest.recognizers[0]?.started");
        assert.equal(await mic.getAttribute("aria-pressed"), "true");
        await screenshot("phone-listening");
        await mic.tap();
        assert.match(await mic.getAttribute("aria-label"), /Finishing/);
        await screenshot("phone-finishing");
        await finish();
        assert.equal(await input.inputValue(), "Tighten the spacing on the cards");
        await screenshot("phone-result");
        await finish();
        assert.equal(
          await input.inputValue(),
          "Tighten the spacing on the cards",
          "late callbacks never duplicate text",
        );
        await assertClosed();
        assert.deepEqual(messages, []);
      });

      await t.test("first permission may resolve after the touch has ended", async () => {
        await openComposer();
        await page.evaluate("voiceTest.delayed = true");
        await mic.tap();
        assert.match(await mic.getAttribute("aria-label"), /permission/);
        await screenshot("phone-permission");
        assert.equal(await page.evaluate("voiceTest.recognizers[0].started === true"), false);
        await page.evaluate("voiceTest.pending.shift()()");
        await page.waitForFunction("voiceTest.recognizers[0].started");
        await mic.tap();
        await finish();
        assert.equal(await input.inputValue(), "Tighten the spacing on the cards");
        await assertClosed();
      });

      await t.test("cancelling permission closes a late microphone and allows the next tap", async () => {
        await openComposer();
        await page.evaluate("voiceTest.delayed = true");
        await mic.tap();
        await mic.tap();
        await page.evaluate("voiceTest.pending.shift()()");
        await assertClosed();
        assert.equal(await input.inputValue(), "Tighten cards");
        await page.evaluate("voiceTest.delayed = false");
        await mic.tap();
        await page.waitForFunction("voiceTest.recognizers.at(-1).started");
        await mic.tap();
        await finish();
        assert.equal(await input.inputValue(), "Tighten the spacing on the cards");
      });

      await t.test("permission denial and service failure reset the button without inserting", async () => {
        for (const error of ["not-allowed", "network", "audio-capture"]) {
          await openComposer();
          if (error === "not-allowed") await page.evaluate("voiceTest.denied = true");
          await mic.tap();
          if (error !== "not-allowed")
            await page.evaluate(`voiceTest.recognizers.at(-1).onerror({ error: ${JSON.stringify(error)} })`);
          await page.waitForFunction("document.querySelector('#chatVoiceNote').classList.contains('is-problem')");
          assert.match(await page.locator("#chatVoiceNote").innerText(), /blocked|network|microphone/i);
          assert.equal(await input.inputValue(), "Tighten cards");
          await assertClosed();
        }
      });

      await t.test("rapid taps while finishing do not start a second recording or move the caret", async () => {
        await openComposer();
        await mic.tap();
        await mic.tap();
        await mic.tap();
        await input.evaluate((element) => element.setSelectionRange(0, 0));
        assert.equal(await page.evaluate("voiceTest.recognizers.length"), 1);
        assert.equal(await page.evaluate("voiceTest.recognizers[0].stops"), 1);
        await finish();
        assert.equal(await input.inputValue(), "Tighten the spacing on the cards");
      });

      await t.test(
        "a draft edit or collapsed conversation cancels rather than typing into the next draft",
        async () => {
          for (const action of ["edit", "collapse"]) {
            await openComposer();
            await mic.tap();
            await page.evaluate(
              "window.lateVoiceResult = voiceTest.recognizers.at(-1).onresult; window.lateVoiceEnd = voiceTest.recognizers.at(-1).onend",
            );
            if (action === "edit") await input.fill("A different draft");
            else await page.locator("#panelToggle").tap();
            await page.evaluate(
              "lateVoiceResult({ resultIndex: 0, results: [[{ transcript: 'late' }]] }); lateVoiceEnd()",
            );
            assert.equal(await input.inputValue(), action === "edit" ? "A different draft" : "Tighten cards");
            await assertClosed();
          }
        },
      );

      await t.test("recent dictations remain reachable by a touch hold", async (t) => {
        if (browserName !== "chromium") {
          t.skip("Trusted touch hold requires the installed Chromium CDP tool");
          return;
        }
        await openComposer();
        await mic.tap({ trial: true });
        const bounds = await mic.boundingBox();
        const session = await context.newCDPSession(page);
        const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
        await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
        try {
          await page.locator("#chatVoiceRecent").waitFor({ state: "visible" });
        } finally {
          await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await session.detach();
        }
        assert.equal(await page.evaluate("voiceTest.requests"), 0);
        await page.locator("#chatVoiceRecentList button").last().tap();
        assert.match(await input.inputValue(), /the spacing on the/);
      });

      await t.test("touch dictation preserves an attached image", async () => {
        await openComposer();
        await page.locator("#chatAttachInput").setInputFiles({
          name: "pixel.png",
          mimeType: "image/png",
          buffer: Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6sWQAAAAASUVORK5CYII=",
            "base64",
          ),
        });
        await page.waitForFunction(
          "document.querySelector('#chatAttachments')?.textContent.includes('pixel.png') && !document.querySelector('#chatAttachments').textContent.includes('Uploading')",
        );
        const before = await page.locator("#chatAttachments").innerText();
        await mic.tap();
        await mic.tap();
        await finish();
        assert.equal(await page.locator("#chatAttachments").innerText(), before);
        assert.equal(await input.inputValue(), "Tighten the spacing on the cards");
      });

      await t.test(
        "the sandboxed annotation microphone uses touch and cannot deliver into a reopened card",
        async () => {
          await page.goto(url);
          await page.locator("#layoutGateOverlay").waitFor({ state: "hidden" });
          if (await page.locator("body").evaluate((element) => element.classList.contains("sheet-open")))
            await page.locator("#panelToggle").tap();
          const composerDraft = await input.inputValue();
          const artifactFrame = page.frameLocator("#artifact");
          // This Windows WebKit build omits compatibility clicks for taps in sandboxed frames.
          // Open the existing annotation with a click, then test its microphone with trusted touch.
          if (browserName === "webkit") await artifactFrame.locator("h1").click();
          else await artifactFrame.locator("h1").tap();
          const cardInput = artifactFrame.locator("#lavishCardInput");
          const cardMic = artifactFrame.locator("#lavishCardVoice");
          await cardInput.fill("Tighten cards");
          await cardInput.evaluate((element) => element.setSelectionRange(7, 7));
          await cardMic.tap();
          await page.waitForFunction("voiceTest.recognizers.at(-1)?.started");
          assert.equal(await cardMic.getAttribute("aria-pressed"), "true");
          await screenshot("annotation-listening");
          await cardMic.tap();
          await page.waitForFunction("voiceTest.recognizers.at(-1).stops === 1");
          await finish();
          await assertValue(cardInput, "Tighten the spacing on the cards");
          assert.equal(await input.inputValue(), composerDraft, "the existing composer draft stays unchanged");
          await cardMic.tap();
          await page.waitForFunction("voiceTest.recognizers.length === 2 && voiceTest.recognizers[1].started");
          await page.evaluate(
            "window.lateVoiceResult = voiceTest.recognizers.at(-1).onresult; window.lateVoiceEnd = voiceTest.recognizers.at(-1).onend",
          );
          await artifactFrame.locator(".lavish-cancel").click();
          await page.waitForFunction("voiceTest.recognizers[1].aborted");
          await artifactFrame.locator("p").click();
          await page.evaluate(
            "lateVoiceResult({ resultIndex: 0, results: [[{ transcript: 'late' }]] }); lateVoiceEnd()",
          );
          assert.equal(await cardInput.inputValue(), "");
          await assertClosed();
          assert.deepEqual(messages, []);
        },
      );

      await t.test("unsupported recognition and insecure context have explicit states", async () => {
        for (const unavailable of ["recognition", "secure-context"]) {
          await openComposer();
          if (unavailable === "recognition")
            await page.evaluate("window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined");
          else
            await page.evaluate(
              "Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true })",
            );
          await mic.tap();
          await page.waitForFunction(
            "document.querySelector('#chatVoice').getAttribute('aria-label').includes('does not provide speech recognition') || document.querySelector('#chatVoice').getAttribute('aria-label').includes('https')",
          );
          assert.equal(await page.evaluate("voiceTest.requests"), 0);
          assert.match(
            await mic.getAttribute("aria-label"),
            unavailable === "recognition" ? /does not provide speech recognition/ : /https/,
          );
        }
      });

      await t.test("a prefixed recognizer works without a browser-name check", async () => {
        await openComposer();
        await page.evaluate(
          "window.webkitSpeechRecognition = window.SpeechRecognition; window.SpeechRecognition = undefined",
        );
        await mic.tap();
        await mic.tap();
        await finish();
        assert.equal(await input.inputValue(), "Tighten the spacing on the cards");
      });

      await t.test("navigation closes the microphone before leaving the review", async () => {
        await openComposer();
        await mic.tap();
        await page.evaluate(
          "window.addEventListener('pagehide', () => sessionStorage.setItem('microphone-closed', String(voiceTest.tracks.every(track => track.readyState === 'ended'))), { once: true })",
        );
        await page.goto(`${base}/health`);
        assert.equal(await page.evaluate("sessionStorage.getItem('microphone-closed')"), "true");
      });

      await t.test("desktop held keys and mouse access to history remain usable", async () => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await openComposer();
        await page.keyboard.down("Control");
        await page.keyboard.down("Shift");
        await page.keyboard.down("Space");
        await page.waitForFunction("voiceTest.recognizers.at(-1)?.started");
        await page.keyboard.up("Space");
        await page.keyboard.up("Shift");
        await page.keyboard.up("Control");
        await finish();
        assert.equal(await input.inputValue(), "Tighten the spacing on the cards");
        await mic.click();
        assert.equal(await page.locator("#chatVoiceRecent").isVisible(), true);
      });

      await t.test("session end cancels pending recognition and rejects its late text", async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        await openComposer();
        await mic.tap();
        await page.evaluate("window.lateVoiceEnd = voiceTest.recognizers.at(-1).onend");
        const ended = await fetch(`${base}/api/${key}/end`, { method: "POST" });
        assert.equal(ended.ok, true);
        await page.waitForFunction("document.querySelector('#chatVoice').disabled");
        await page.evaluate("lateVoiceEnd()");
        await assertClosed();
        assert.equal(await input.inputValue(), "Tighten cards");
        assert.deepEqual(messages, []);
      });
    } finally {
      await browser?.close();
      await server.close();
      await rm(temp, { recursive: true, force: true, maxRetries: 5 });
    }
  },
);
