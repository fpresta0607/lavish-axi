import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The curtain used to lift on the first completed layout pass, which waits for every font: a page
// whose font was slow sat behind it until the gate's 12-second safety timeout. This pins the
// replacement in a real browser. The page shows while its font is still on the wire, the late font
// swaps in on the shown page, and the layout check then runs there.
const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Well under the gate's 12-second safety timeout, the only thing that lifted this curtain before,
// with room for reading the page through the CLI, which takes about a second a read here. The
// held font is what proves "at once": the page shows while it is still on the wire.
const SHOWN_WITHIN_MS = 8000;
const POLL_INTERVAL_MS = 250;

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Two messages stacked in one grid cell: one severe finding once the layout check has run.
function slowFontArtifact(fontUrl) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Slow font</title>
    <style>
      @font-face {
        font-family: "Slow Sans";
        src: url("${fontUrl}") format("woff2");
        font-display: swap;
      }
      :root {
        font-family: "Slow Sans", system-ui, sans-serif;
        color: #1b2630;
        background: #eef1f3;
      }
      body {
        margin: 0;
        padding: 24px;
      }
      main {
        width: min(620px, 100%);
        margin: 0 auto;
        padding: 30px;
        background: #fff;
      }
      .stack {
        display: grid;
        margin-top: 22px;
        padding: 18px;
      }
      .stack p {
        grid-area: 1/1;
        margin: 0;
        padding: 18px;
        font-size: 20px;
      }
      .critical {
        color: #8f1d19;
        background: #ffd8d2;
      }
      .instructions {
        color: #173f65;
        background: #d6eaff;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Recovery instructions</h1>
      <p>Both ordinary messages accidentally occupy exactly the same bounded area.</p>
      <section class="stack">
        <p class="critical">Your security key has expired. Verify your identity before continuing.</p>
        <p class="instructions">Use the trusted phone ending in 8842 to approve this recovery request.</p>
      </section>
    </main>
  </body>
</html>
`;
}

const READ_CHROME = `JSON.stringify((() => {
  const overlay = document.getElementById("layoutGateOverlay");
  if (!overlay) return null;
  return {
    gate: document.body.classList.contains("layout-gate-active"),
    now: Math.round(performance.now()),
    badge: document.getElementById("warningsCount").textContent,
    wrapHidden: document.getElementById("warningsWrap").hidden,
    frameSrc: document.getElementById("artifact").getAttribute("src") || "",
  };
})())`;

test(
  "a page whose font is slow still shows at once, and its layout is checked once the font is in",
  { skip: !runBrowserE2e, timeout: 240_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-slow-font-"));
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
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-slow-font-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };

    // The font is held until the test lets it go, so "while the font is still on the wire" is a
    // fact of the run rather than a timing guess.
    const font = await readFile(path.join(repoRoot, "src/fonts/nunito.woff2"));
    let fontRequested = false;
    /** @type {http.ServerResponse[]} */
    const heldFontResponses = [];
    let fontReleased = false;
    const releaseFont = () => {
      fontReleased = true;
      for (const response of heldFontResponses.splice(0)) {
        response.writeHead(200, { "content-type": "font/woff2", "access-control-allow-origin": "*" });
        response.end(font);
      }
    };
    const fontServer = http.createServer((request, response) => {
      fontRequested = true;
      heldFontResponses.push(response);
      if (fontReleased) releaseFont();
    });
    await new Promise((resolve) => fontServer.listen(0, "127.0.0.1", () => resolve(undefined)));
    const fontAddress = fontServer.address();
    if (!fontAddress || typeof fontAddress === "string") throw new Error("the font server has no port");
    const artifact = path.join(temp, "slow-font.html");
    await writeFile(artifact, slowFontArtifact(`http://127.0.0.1:${fontAddress.port}/slow.woff2`));

    // `null` while the chrome page is not up yet: the first reads can land mid-navigation.
    function readChrome() {
      const result = spawnSync("chrome-devtools-axi", ["eval", READ_CHROME], {
        cwd: repoRoot,
        env: { ...process.env, ...chromeEnv },
        encoding: "utf8",
        timeout: 45_000,
      });
      const raw = `${result.stdout || ""}`.match(/result:\s*("(?:[^"\\]|\\.)*")/s)?.[1];
      if (result.status !== 0 || !raw) return null;
      let value = JSON.parse(raw);
      while (typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch {
          break;
        }
      }
      return value && typeof value === "object" ? value : null;
    }

    try {
      const output = run(process.execPath, ["bin/lavish-axi.js", artifact, "--no-open"], lavishEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);

      // `open` waits for the page's load, which waits for the artifact frame's, which waits for
      // the held font. Navigate from a page that is already up, and watch the chrome instead.
      run("chrome-devtools-axi", ["open", "data:text/html,"], chromeEnv);
      run("chrome-devtools-axi", ["emulate", "--viewport", "1440x1000x1"], chromeEnv);
      run("chrome-devtools-axi", ["eval", `location.assign(${JSON.stringify(url)})`], chromeEnv);

      // Watch past the gate's safety timeout, so a curtain that only that timeout lifts fails on
      // its time below rather than on running out of reads.
      let shown = readChrome();
      for (let attempt = 0; attempt < 120 && (!shown || (shown.gate && shown.now < 16_000)); attempt += 1) {
        await sleep(POLL_INTERVAL_MS);
        shown = readChrome();
      }
      assert.ok(shown, "the chrome page came up");
      assert.equal(shown.gate, false, "the curtain lifted");
      assert.ok(shown.now < SHOWN_WITHIN_MS, `the page showed ${shown.now} ms after it opened`);
      assert.equal(fontRequested, true, "the page asked for its font");
      assert.equal(fontReleased, false, "the font was still on the wire when the page showed");
      assert.equal(shown.wrapHidden, true, "the layout check waits for the font");

      releaseFont();
      let checked = readChrome();
      for (let attempt = 0; attempt < 120 && checked?.badge !== "1"; attempt += 1) {
        await sleep(POLL_INTERVAL_MS);
        checked = readChrome();
      }
      assert.ok(checked, "the chrome page is still up");
      assert.equal(checked.badge, "1", "the layout check ran on the shown page once its font was in");
      assert.equal(checked.gate, false, "the curtain did not come back for the late font");
      assert.equal(checked.frameSrc, shown.frameSrc, "the late font did not reload the page");
    } finally {
      releaseFont();
      fontServer.closeAllConnections();
      await new Promise((resolve) => fontServer.close(() => resolve(undefined)));
      run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15_000);
      run("chrome-devtools-axi", ["stop"], chromeEnv);
      await rm(temp, { recursive: true, force: true, maxRetries: 10 });
    }
  },
);
