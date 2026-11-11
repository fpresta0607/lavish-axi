import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(args, env, timeout = 60_000) {
  const result = spawnSync("chrome-devtools-axi", args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `chrome-devtools-axi ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout || ""}${result.stderr || ""}`;
}

function evaluate(expression, env) {
  const output = run(["eval", expression], env);
  const raw = output.match(/result:\s*("(?:[^"\\]|\\.)*")/s)?.[1];
  assert.ok(raw, output);
  let value = JSON.parse(raw);
  while (typeof value === "string") value = JSON.parse(value);
  return value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A page in the board look with a stat row and a review's six column findings table in the form
// that queues the ticked rows, the shape an agent writes.
function boardPage() {
  const stylesheet = (name) => pathToFileURL(path.join(repoRoot, "src", name)).href;
  const row = (id, finding, evidence, fix) =>
    `<tr><td><input type="checkbox" aria-label="Fix ${id}"></td><td class="id">${id}</td>` +
    `<td><span class="status bad">Must fix</span></td><td class="finding">${finding}</td>` +
    `<td>${evidence}</td><td>${fix}</td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${stylesheet("board-tokens.css")}">
<link rel="stylesheet" href="${stylesheet("board-page.css")}"></head>
<body><main class="page"><section class="stats">
<div class="stat"><strong>6</strong><span>findings</span></div>
<div class="stat"><strong>2</strong><span>must fix</span></div>
<div class="stat"><strong>3</strong><span>should fix</span></div></section>
<section><h2>Findings</h2><form><div class="table-wrap"><table class="evidence">
<thead><tr><th>Fix</th><th>ID</th><th>Priority</th><th>Finding</th><th>Evidence</th><th>Fix</th></tr></thead>
<tbody>
${row("R-01", "The storm warning switch is off by default, so a new reader gets no warning until they find it.", "Most test accounts never turned it on.", "On by default.")}
${row("R-02", "Turning off every warning gives no notice.", "The screen saves at once with no message.", "Ask once before the last warning is switched off.")}
</tbody></table></div></form></section></main></body></html>`;
}

// What a reader sees of the table: whether the page or only the table's wrapper scrolls sideways,
// whether any word of a short code or a sentence is split across lines, the sentence's width, and
// how many rows the stat row takes.
const MEASURE = `JSON.stringify((() => {
  const wrap = document.querySelector(".table-wrap");
  const wordsWhole = (element) => {
    const text = element.firstChild;
    const range = document.createRange();
    return [...text.data.matchAll(/\\S+/g)].every((word) => {
      range.setStart(text, word.index);
      range.setEnd(text, word.index + word[0].length);
      return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size === 1;
    });
  };
  const finding = document.querySelector(".finding");
  return {
    pageScrolls: document.documentElement.scrollWidth > window.innerWidth,
    wrapScrolls: wrap.scrollWidth > wrap.clientWidth,
    idWhole: wordsWhole(document.querySelector(".id")),
    findingWhole: wordsWhole(finding),
    findingWidth: finding.getBoundingClientRect().width,
    statRows: new Set([...document.querySelectorAll(".stat")].map((stat) => Math.round(stat.getBoundingClientRect().top))).size,
  };
})())`;

test(
  "a board look page scrolls a wide table inside its wrapper on a phone, keeps its words whole and sets a stat row side by side on a desktop",
  { skip: !runBrowserE2e, timeout: 300_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-board-table-"));
    const chromeEnv = {
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-board-table-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };
    const page = path.join(temp, "findings.html");
    await writeFile(page, boardPage());

    async function measureAt(viewport) {
      run(["emulate", "--viewport", viewport], chromeEnv);
      run(["open", pathToFileURL(page).href], chromeEnv);
      await sleep(1500);
      return evaluate(MEASURE, chromeEnv);
    }

    try {
      run(["open", "data:text/html,"], chromeEnv);

      const phone = await measureAt("390x844x1,mobile,touch");
      const desktop = await measureAt("1440x1000x1");

      assert.equal(phone.pageScrolls, false, "the page stays phone wide");
      assert.equal(phone.wrapScrolls, true, "the table scrolls sideways inside its wrapper");
      assert.equal(phone.idWhole, true, "a short code stays on one line on a phone");
      assert.equal(phone.findingWhole, true, "a sentence wraps between words on a phone");
      assert.ok(phone.findingWidth >= 112, `a sentence gets a readable column on a phone, not ${phone.findingWidth}px`);
      assert.equal(desktop.pageScrolls, false);
      assert.equal(desktop.wrapScrolls, false, "a desktop table fits its wrapper");
      assert.equal(desktop.idWhole, true, "a short code stays on one line on a desktop");
      assert.equal(desktop.findingWhole, true, "a sentence wraps between words on a desktop");
      assert.equal(desktop.statRows, 1, "the stat row sits side by side on a desktop");
    } finally {
      try {
        run(["stop"], chromeEnv);
      } finally {
        await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    }
  },
);
