import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Every note he writes on a page waits in one list until Send & End delivers them all at once, in a
// real browser through the real chrome and server: two notes on elements and one on the whole
// page, one of them reworded and a fourth taken out, nothing delivered before the send, and then
// one delivery holding the three in the order he wrote them. The same review runs once on
// 127.0.0.1 and once through a proxy that rewrites each request as the Code Goblins tailnet proxy
// does, and both deliver the same notes. Controls are found as a reader finds them, in the
// browser's accessibility tree.
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

// The Code Goblins tailnet proxy (internal/remoteaccess serveScrawl) hands Scrawl each request as
// if it came from 127.0.0.1: Host, Origin and Referer name the loopback server and every
// forwarding header is dropped. The browser meanwhile sits on another origin of its own. It runs
// in a process of its own: this test blocks while it reads the browser, and a proxy inside it
// would answer nothing meanwhile. It prints the port it took, then a line for each sent batch.
async function rewritingProxy(target) {
  const http = await import("node:http");
  const net = await import("node:net");
  const loopback = "127.0.0.1:" + target;
  const rewrite = (headers) => {
    const out = {};
    for (const [name, value] of Object.entries(headers)) {
      if (/^(x-forwarded-|tailscale-)/i.test(name) || /^forwarded$/i.test(name)) continue;
      out[name] = value;
    }
    out.host = loopback;
    if (out.origin) out.origin = "http://" + loopback;
    if (out.referer) {
      const referer = new URL(String(out.referer));
      referer.protocol = "http:";
      referer.host = loopback;
      out.referer = referer.toString();
    }
    return out;
  };
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && String(req.url).endsWith("/prompts")) process.stdout.write("post " + req.url + "\n");
    const upstream = http.request(
      { host: "127.0.0.1", port: target, method: req.method, path: req.url, headers: rewrite(req.headers) },
      (response) => {
        const headers = { ...response.headers };
        if (headers.location) {
          const location = new URL(String(headers.location), "http://" + loopback);
          if (location.host === loopback) location.host = String(req.headers.host);
          headers.location = location.toString();
        }
        res.writeHead(response.statusCode || 502, headers);
        response.pipe(res);
      },
    );
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  });
  // The live-event WebSocket goes through the same rewrite.
  server.on("upgrade", (req, socket, head) => {
    const upstream = net.connect(target, "127.0.0.1", () => {
      const lines = Object.entries(rewrite(req.headers)).flatMap(([name, value]) =>
        (Array.isArray(value) ? value : [value]).map((one) => name + ": " + one),
      );
      upstream.write(req.method + " " + req.url + " HTTP/1.1\r\n" + lines.join("\r\n") + "\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  server.listen({ port: 0, host: "127.0.0.1" }, () => {
    const address = server.address();
    process.stdout.write("listening " + (address && typeof address === "object" ? address.port : 0) + "\n");
  });
}

async function startRewritingProxy(target) {
  const child = spawn(
    process.execPath,
    ["-e", `(${rewritingProxy.toString()})(Number(process.argv[1]))`, String(target)],
    { stdio: ["ignore", "pipe", "inherit"], windowsHide: true },
  );
  const lines = [];
  let partial = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    const parts = (partial + chunk).split("\n");
    partial = parts.pop() || "";
    lines.push(...parts.filter(Boolean));
  });
  const deadline = Date.now() + 15_000;
  while (!lines.some((line) => line.startsWith("listening "))) {
    if (Date.now() > deadline || child.exitCode !== null) assert.fail(`the proxy never listened: ${lines}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    port: Number(lines.find((line) => line.startsWith("listening ")).slice("listening ".length)),
    // The proxy's own count of sent batches, read once this test yields to take its output in.
    posts: async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return lines.filter((line) => line.startsWith("post ")).length;
    },
    close: () => {
      if (child.exitCode === null) child.kill();
    },
  };
}

const ARTIFACT = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Notes fixture</title>
<style>html,body{background:#fff;color:#111}body{margin:0;padding:24px;font-family:system-ui,sans-serif}section{padding:16px;margin:16px 0}</style>
</head><body>
<h1>Checkout redesign</h1>
<section><h2>Step 1. Address</h2><p>Autofill from the browser profile.</p></section>
<section><h2>Step 2. Payment</h2><p>Card, Apple Pay and Link.</p></section>
<section><h2>Step 3. Review</h2><p>Confirm and place the order.</p></section>
</body></html>`;

const CARD_TEXTBOX = /textbox "Tell the agent what to change about this element\.\.\."/;
const CHIP = /"Comment on <h2>/;
const MAIN_BOX = /textbox "Write a note on /;

test(
  "notes wait in one list and Send & End delivers them together, the same on 127.0.0.1 and through the tailnet proxy",
  { skip: !runBrowserE2e, timeout: 1_200_000 },
  async (t) => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-notes-chain-"));
    const port = await freePort();
    const stateDir = path.join(temp, "state");
    const lavishEnv = {
      LAVISH_AXI_PORT: String(port),
      LAVISH_AXI_STATE_DIR: stateDir,
      LAVISH_AXI_NO_OPEN: "1",
      LAVISH_AXI_TELEMETRY: "0",
      LAVISH_AXI_HOST: "127.0.0.1",
      LAVISH_AXI_LINK_HOST: "127.0.0.1",
    };
    const chromeEnv = {
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-notes-chain-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };
    const proxy = await startRewritingProxy(port);

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const snapshot = () => run("chrome-devtools-axi", ["snapshot"], chromeEnv);
    const lineOf = (shot, pattern, which = "first") => {
      const lines = shot.split("\n").filter((candidate) => pattern.test(candidate));
      const line = which === "last" ? lines.at(-1) : lines[0];
      assert.ok(line, `no snapshot line matching ${pattern}:\n${shot}`);
      return `@${line.trim().split(/\s+/)[0].replace(/^uid=/, "")}`;
    };
    const has = (shot, pattern) => shot.split("\n").some((line) => pattern.test(line));
    const click = (pattern, which) =>
      run("chrome-devtools-axi", ["click", lineOf(snapshot(), pattern, which)], chromeEnv);
    const fill = (pattern, words) =>
      run("chrome-devtools-axi", ["fill", lineOf(snapshot(), pattern), words], chromeEnv);
    const press = (key) => run("chrome-devtools-axi", ["press", key], chromeEnv);
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

    // A state is waited for with a capped poll, never a fixed sleep.
    async function waitFor(description, isReady, seconds = 30) {
      const deadline = Date.now() + seconds * 1000;
      let shot = snapshot();
      while (!isReady(shot)) {
        if (Date.now() > deadline) assert.fail(`${description} within ${seconds}s:\n${shot}`);
        await wait(1000);
        shot = snapshot();
      }
      return shot;
    }

    // What the server holds for this page: the notes waiting for a poll, and the conversation.
    async function session(file) {
      const state = JSON.parse(await readFile(path.join(stateDir, "state.json"), "utf8"));
      const found = Object.values(state.sessions).find((candidate) => path.basename(candidate.file) === file);
      assert.ok(found, `no session for ${file}`);
      return found;
    }

    async function noteOnHeading(heading, words, how) {
      click(heading);
      await waitFor("the annotation box never opened", (shot) => has(shot, CARD_TEXTBOX));
      fill(CARD_TEXTBOX, words);
      if (how === "Enter") press("Enter");
      else click(/button "Add to your notes"/);
      await waitFor("the box never shrank to its chip", (shot) => !has(shot, CARD_TEXTBOX) && has(shot, CHIP));
    }

    // The 10-11 rule: the Conversation box keeps its paperclip at its bottom left and its
    // microphone at its bottom right, icons with no words, even with the selected element's line
    // above it.
    function assertBoxKeepsItsPlaces(where) {
      const measured = evaluate(`() => {
        const rect = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
        const field = document.getElementById("chatField");
        const attach = document.getElementById("chatAttach");
        const voice = document.getElementById("chatVoice");
        return JSON.stringify({ field: rect(field), attach: rect(attach), voice: rect(voice),
          words: [attach.textContent.trim(), voice.textContent.trim()],
          anchor: rect(document.getElementById("chatAnchor")), anchorShown: !document.getElementById("chatAnchor").hidden });
      }`);
      const { field, attach, voice } = measured;
      const detail = `${where}: ${JSON.stringify(measured)}`;
      for (const control of [attach, voice]) {
        assert.ok(
          control.left >= field.left - 0.5 &&
            control.right <= field.right + 0.5 &&
            control.top >= field.top - 0.5 &&
            control.bottom <= field.bottom + 0.5,
          `inside the box: ${detail}`,
        );
        assert.ok(field.bottom - control.bottom <= 16, `at the box's bottom: ${detail}`);
      }
      assert.ok(attach.left - field.left <= 16, `the paperclip at the bottom left: ${detail}`);
      assert.ok(field.right - voice.right <= 16, `the microphone at the bottom right: ${detail}`);
      assert.deepEqual(measured.words, ["", ""], `no words on either: ${detail}`);
      return measured;
    }

    async function reviewWithFourNotes(url, file, { measure = false } = {}) {
      run("chrome-devtools-axi", ["open", url], chromeEnv);
      await waitFor("the page never loaded", (shot) => has(shot, /heading "Step 2\. Payment"/));

      await noteOnHeading(/heading "Step 2\. Payment"/, "Make the payment step stand out", "Enter");
      await noteOnHeading(/heading "Step 3\. Review"/, "Say when the card is charged", "button");

      // The chip keeps its heading selected, so the Conversation box names it; the reader puts
      // the next note on the whole page instead.
      const selected = await waitFor("the Conversation box never named the selection", (shot) =>
        has(shot, /button "Write about the whole page instead"/),
      );
      assert.ok(has(selected, /Step 3\. Review/), `the line names the heading:\n${selected}`);
      if (measure) {
        assert.equal(assertBoxKeepsItsPlaces("with a selection").anchorShown, true);
      }
      click(/button "Write about the whole page instead"/);
      await waitFor("the selection never cleared", (shot) => has(shot, /textbox "Write a note on the whole page/));
      if (measure) assertBoxKeepsItsPlaces("with nothing selected");
      fill(MAIN_BOX, "Overall the flow reads well");
      press("Enter");
      fill(MAIN_BOX, "Take this one back");
      press("Enter");
      await waitFor("the fourth note never joined the list", (shot) => has(shot, /Take this one back/));

      click(/button "Remove queued prompt"/, "last");
      await waitFor("the removed note never left", (shot) => !has(shot, /Take this one back/));

      click(/button "Edit note"/);
      await waitFor("the editor never opened", (shot) => has(shot, /textbox "Edit note"/));
      fill(/textbox "Edit note"/, "Make the payment step stand out more");
      press("Enter");
      await waitFor("the edit never saved", (shot) => has(shot, /Make the payment step stand out more/));

      const before = await session(file);
      assert.deepEqual(before.prompts || [], [], "nothing is delivered before the send");
      assert.equal((before.chat || []).length, 0, "nothing joined the conversation before the send");

      click(/button "Send & End"/);
      const deadline = Date.now() + 30_000;
      let after = await session(file);
      while (after.status !== "ended") {
        if (Date.now() > deadline) assert.fail(`the review never ended: ${JSON.stringify(after)}`);
        await wait(500);
        after = await session(file);
      }
      return after;
    }

    // What the three notes say and what each is attached to.
    const delivered = (sessionState) =>
      sessionState.prompts.map(({ prompt, tag, text, selector }) => ({
        prompt,
        tag,
        text,
        selector: Boolean(selector),
      }));
    const EXPECTED = [
      { prompt: "Make the payment step stand out more", tag: "h2", text: "Step 2. Payment", selector: true },
      { prompt: "Say when the card is charged", tag: "h2", text: "Step 3. Review", selector: true },
      { prompt: "Overall the flow reads well", tag: "message", text: "Whole page", selector: false },
    ];
    function assertOneDelivery(where, sessionState) {
      assert.deepEqual(delivered(sessionState), EXPECTED, `${where}: the three notes in the order he wrote them`);
      assert.equal(sessionState.ended_by, "user", `${where}: he ended the review`);
      // One request stamps every note it carries with one time.
      const times = new Set(sessionState.chat.filter((entry) => entry.role === "user").map((entry) => entry.at));
      assert.equal(sessionState.chat.filter((entry) => entry.role === "user").length, 3, `${where}: three notes`);
      assert.equal(times.size, 1, `${where}: one delivery`);
    }

    try {
      // A fresh browser has no page to act on, so it opens a blank one first.
      run("chrome-devtools-axi", ["open", "data:text/html,"], chromeEnv);
      run("chrome-devtools-axi", ["emulate", "--viewport", "1707x950x1.5"], chromeEnv);
      const outcomes = {};
      for (const [where, file, origin] of [
        ["on 127.0.0.1", "review-local.html", null],
        ["through the tailnet proxy", "review-tailnet.html", `http://localhost:${proxy.port}`],
      ]) {
        await t.test(where, async () => {
          const artifact = path.join(temp, file);
          await writeFile(artifact, ARTIFACT);
          const output = run(process.execPath, ["bin/lavish-axi.js", artifact, "--no-open"], lavishEnv);
          const link = output.match(/url:\s*"([^"]+)"/)?.[1];
          assert.ok(link, output);
          const url = origin ? origin + new URL(link).pathname + new URL(link).search : link;
          const before = await proxy.posts();
          outcomes[where] = await reviewWithFourNotes(url, file, { measure: !origin });
          assertOneDelivery(where, outcomes[where]);
          if (origin) assert.equal((await proxy.posts()) - before, 1, "one request went through the proxy");
        });
      }
      await t.test("both deliver the same notes", () => {
        assert.deepEqual(delivered(outcomes["through the tailnet proxy"]), delivered(outcomes["on 127.0.0.1"]));
      });
    } finally {
      proxy.close();
      run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15_000);
      run("chrome-devtools-axi", ["stop"], chromeEnv);
      // Windows keeps the profile's lockfile a moment after Chrome exits.
      await rm(temp, { recursive: true, force: true, maxRetries: 10 });
    }
  },
);
