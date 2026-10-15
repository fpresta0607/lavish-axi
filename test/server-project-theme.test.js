import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { saveProjectTheme, SIQ_THEME, validateProjectTheme } from "../src/project-theme.js";
import { createChromeHtml, createSdkJs, serve } from "../src/server.js";

const PARCHMENT = {
  name: "Parchment",
  colors: {
    page: "#faf8f5",
    surface: "#fdfbfa",
    raised: "#f3f0ea",
    text: "#27251e",
    muted: "#5f5d58",
    accent: "#016a71",
    accentText: "#ffffff",
    border: "#d1d1cd",
  },
  fonts: { body: '"Inter", ui-sans-serif, system-ui, sans-serif' },
  radius: "12px",
};
const SESSION = { key: "abc", file: "/tmp/artifact.html" };

// Everything the head says before the stylesheet arrives is what the browser paints first.
function beforeStylesheet(html) {
  const end = html.indexOf('<link rel="stylesheet" href="/chrome.css">');
  assert.ok(end > 0, "the page links its stylesheet");
  return html.slice(0, end);
}

test("a page with no project theme paints the SIQ page colour before its stylesheet loads", () => {
  const head = beforeStylesheet(createChromeHtml(SESSION));

  assert.match(head, /<meta name="color-scheme" content="dark">/);
  assert.match(head, new RegExp(`html\\{background:${SIQ_THEME.colors.page}`));
  assert.doesNotMatch(head, /data-project-theme/);
});

test("a page whose project saved a theme wears it from the first paint", () => {
  const html = createChromeHtml(SESSION, { projectTheme: validateProjectTheme(PARCHMENT) });
  const head = beforeStylesheet(html);

  assert.match(html, /<html data-project-theme="light">/);
  assert.match(head, /<meta name="color-scheme" content="light">/);
  assert.match(head, /html\{background:#faf8f5/);
  assert.match(head, /--theme-accent:#016a71;/);
});

test("the review stylesheet carries the project theme layer and never paints the page frame white", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-theme-css-"));
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const css = await (await fetch(`http://127.0.0.1:${server.port}/chrome.css`)).text();
    assert.match(css, /html\[data-project-theme\]/);
    const frameRule = /(^|\n)iframe \{[^}]*\}/.exec(css)?.[0] || "";
    assert.ok(frameRule, "the stylesheet styles the artifact frame");
    assert.doesNotMatch(frameRule, /white|#fff/i);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a review page and its SDK take the theme its project saved", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-theme-route-"));
  const stateFile = path.join(dir, "state", "state.json");
  const checkout = path.join(dir, "Site");
  await mkdir(path.join(checkout, ".git"), { recursive: true });
  const artifact = path.join(checkout, "plan.html");
  await writeFile(artifact, "<!doctype html><html><body><p>Plan</p></body></html>");
  await saveProjectTheme(path.dirname(stateFile), checkout, PARCHMENT);
  const server = await serve({ port: 0, stateFile, version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const open = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const { key } = await open.json();

    const page = await (await fetch(`${base}/session/${key}`)).text();
    assert.match(page, /<html data-project-theme="light">/);
    assert.match(page, /--theme-page:#faf8f5;/);

    const boot = JSON.parse(/<script id="lavish-session" type="application\/json">([\s\S]*?)<\/script>/.exec(page)[1]);
    const begun = await fetch(`${base}/api/${key}/artifact-loads/begin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: "theme-load",
        request_sequence: boot.initialArtifactLoadSequence + 1,
        chrome_load_token: boot.chromeLoadToken,
      }),
    }).then((response) => response.json());
    const load = new URLSearchParams({
      key,
      artifact_load_token: begun.artifact_load_token,
      artifact_revision: String(begun.artifact_revision),
    });
    const sdk = await (await fetch(`${base}/sdk.js?${load}`)).text();
    assert.match(sdk, /"pageDefaults":\{"background":"#faf8f5","color":"#27251e","scheme":"light"\}/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the SDK gives a page with no project theme the SIQ page colours", () => {
  const sdk = createSdkJs("abc");
  assert.match(
    sdk,
    new RegExp(
      `"pageDefaults":\\{"background":"${SIQ_THEME.colors.page}","color":"${SIQ_THEME.colors.text}","scheme":"dark"\\}`,
    ),
  );
});
