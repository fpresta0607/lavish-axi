import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createDesignOutput } from "../src/cli.js";

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url));

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

async function lavish(stateDir, ...args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [BIN, ...args], {
      env: { ...process.env, LAVISH_AXI_STATE_DIR: stateDir, LAVISH_AXI_TELEMETRY: "0", LAVISH_AXI_NO_OPEN: "1" },
      windowsHide: true,
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code, stdout: String(error.stdout || "") };
  }
}

// A project with a main checkout and a goblin's worktree of it, as git lays them out.
async function project(dir) {
  const checkout = path.join(dir, "Site");
  const gitDir = path.join(checkout, ".git", "worktrees", "task-1");
  await mkdir(gitDir, { recursive: true });
  await writeFile(path.join(gitDir, "commondir"), "../..\n");
  const worktree = path.join(dir, "worktrees", "task-1");
  await mkdir(path.join(worktree, ".lavish"), { recursive: true });
  await writeFile(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
  return { checkout, worktree };
}

test("lavish-axi theme saves a project's theme once for all its worktrees, shows it, and clears it", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "lavish-cli-theme-")));
  try {
    const stateDir = path.join(dir, "state");
    const { checkout, worktree } = await project(dir);
    const themeFile = path.join(dir, "theme.json");
    await writeFile(themeFile, JSON.stringify(PARCHMENT));

    const unsaved = await lavish(stateDir, "theme", worktree);
    assert.equal(unsaved.code, 0, unsaved.stdout);
    assert.match(unsaved.stdout, /saved: false/);
    assert.match(unsaved.stdout, /Code Goblins SIQ/);

    const saved = await lavish(stateDir, "theme", worktree, "--set", themeFile);
    assert.equal(saved.code, 0, saved.stdout);
    assert.match(saved.stdout, /saved: true/);
    // A path with backslashes is written as a JSON string, escapes and all.
    assert.ok(
      saved.stdout.includes(JSON.stringify(checkout).slice(1, -1)),
      `the theme belongs to the main checkout:\n${saved.stdout}`,
    );
    assert.equal((await readdir(path.join(stateDir, "themes"))).length, 1, "one theme file for the project");

    const shown = await lavish(stateDir, "theme", checkout);
    assert.match(shown.stdout, /name: Parchment/);
    assert.match(shown.stdout, /scheme: light/);

    const cleared = await lavish(stateDir, "theme", checkout, "--clear");
    assert.equal(cleared.code, 0, cleared.stdout);
    assert.match((await lavish(stateDir, "theme", worktree)).stdout, /saved: false/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lavish-axi theme refuses a theme that is hard to read and saves nothing", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "lavish-cli-theme-")));
  try {
    const stateDir = path.join(dir, "state");
    const { checkout } = await project(dir);
    const themeFile = path.join(dir, "theme.json");
    await writeFile(themeFile, JSON.stringify({ ...PARCHMENT, colors: { ...PARCHMENT.colors, text: "#c9c6bf" } }));

    const refused = await lavish(stateDir, "theme", checkout, "--set", themeFile);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stdout, /text on page/);
    assert.match((await lavish(stateDir, "theme", checkout)).stdout, /saved: false/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lavish-axi theme refuses a path outside any git checkout", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "lavish-cli-theme-")));
  try {
    const refused = await lavish(path.join(dir, "state"), "theme", dir);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stdout, /git checkout/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lavish-axi design tells agents to save the frame theme of a project with a frontend", () => {
  const { frame_theme: frameTheme } = createDesignOutput();
  assert.match(frameTheme.how, /lavish-axi theme <project-dir> --set <file\.json>/);
  assert.match(frameTheme.use_when, /frontend/);
  assert.deepEqual(Object.keys(JSON.parse(frameTheme.example).colors), Object.keys(PARCHMENT.colors));
});
