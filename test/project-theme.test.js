import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clearProjectTheme,
  contrastRatio,
  loadProjectTheme,
  projectRootOf,
  projectThemeCss,
  readableAccent,
  saveProjectTheme,
  SIQ_THEME,
  themeScheme,
  validateProjectTheme,
} from "../src/project-theme.js";

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
  fonts: { body: '"Inter", ui-sans-serif, system-ui, sans-serif', display: '"Newsreader", Georgia, serif' },
  radius: "12px",
};

async function withTemp(run) {
  // The real path, as a review session carries it: Windows runners name their temp folder in 8.3 form.
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "lavish-theme-")));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

test("contrastRatio follows WCAG relative luminance", () => {
  assert.equal(contrastRatio("#000000", "#ffffff"), 21);
  assert.equal(contrastRatio("#ffffff", "#ffffff"), 1);
  assert.ok(Math.abs(contrastRatio("#767676", "#ffffff") - 4.54) < 0.01);
});

test("a complete readable theme validates and keeps only the fields it knows", () => {
  const theme = validateProjectTheme({ ...PARCHMENT, extra: "dropped" });
  assert.deepEqual(Object.keys(theme).sort(), ["colors", "fonts", "name", "radius"]);
  assert.equal(theme.colors.page, "#faf8f5");
  assert.equal(theme.fonts.mono, SIQ_THEME.fonts.mono, "a missing mono face falls back to the SIQ one");
  assert.equal(themeScheme(theme), "light");
  assert.equal(themeScheme(SIQ_THEME), "dark");
});

for (const { name, change, message } of [
  { name: "a color that is not a six-digit hex", change: { colors: { page: "red" } }, message: /colors\.page/ },
  {
    name: "a color that could carry CSS",
    change: { colors: { text: "#000;background:url(x)" } },
    message: /colors\.text/,
  },
  { name: "a missing color", change: { colors: { border: undefined } }, message: /colors\.border/ },
  { name: "pure white as the page", change: { colors: { page: "#ffffff" } }, message: /pure white/ },
  { name: "pure white as a surface", change: { colors: { surface: "#FFFFFF" } }, message: /pure white/ },
  { name: "text that is hard to read on the page", change: { colors: { text: "#b0aea8" } }, message: /text on page/ },
  {
    name: "muted text that is hard to read on a surface",
    change: { colors: { muted: "#a5a39e" } },
    message: /muted on surface/,
  },
  {
    name: "button text that is hard to read on the accent",
    change: { colors: { accentText: "#3d8f94" } },
    message: /accentText on accent/,
  },
  {
    name: "a font list that could break out of its declaration",
    change: { fonts: { body: "Inter;}html{display:none" } },
    message: /fonts\.body/,
  },
  { name: "a radius that is not a small length", change: { radius: "50%" }, message: /radius/ },
]) {
  test(`a theme with ${name} is refused`, () => {
    const theme = {
      ...PARCHMENT,
      ...change,
      colors: { ...PARCHMENT.colors, ...change.colors },
      fonts: { ...PARCHMENT.fonts, ...change.fonts },
    };
    assert.throws(() => validateProjectTheme(theme), message);
  });
}

test("the SIQ theme is itself a valid theme", () => {
  assert.deepEqual(validateProjectTheme(SIQ_THEME), SIQ_THEME);
});

test("the project of a page in a plain checkout is that checkout", async () => {
  await withTemp(async (dir) => {
    const checkout = path.join(dir, "Site");
    await mkdir(path.join(checkout, ".git"), { recursive: true });
    await mkdir(path.join(checkout, "docs", ".lavish"), { recursive: true });
    assert.equal(await projectRootOf(path.join(checkout, "docs", ".lavish", "plan.html")), checkout);
  });
});

test("the project of a page in a git worktree is the main checkout it was made from", async () => {
  await withTemp(async (dir) => {
    const checkout = path.join(dir, "Site");
    const gitDir = path.join(checkout, ".git", "worktrees", "task-1");
    await mkdir(gitDir, { recursive: true });
    await writeFile(path.join(gitDir, "commondir"), "../..\n");
    const worktree = path.join(dir, "worktrees", "Site", "task-1");
    await mkdir(path.join(worktree, ".lavish"), { recursive: true });
    await writeFile(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    assert.equal(await projectRootOf(path.join(worktree, ".lavish", "plan.html")), checkout);
  });
});

test("a page outside any repository has no project", async () => {
  await withTemp(async (dir) => {
    assert.equal(await projectRootOf(path.join(dir, "loose", "plan.html")), null);
  });
});

test("a saved theme is found again for every page of its project, and clearing it removes it", async () => {
  await withTemp(async (dir) => {
    const stateDir = path.join(dir, "state");
    const checkout = path.join(dir, "Site");
    await mkdir(path.join(checkout, ".git"), { recursive: true });
    const page = path.join(checkout, "plan.html");

    assert.equal(await loadProjectTheme(stateDir, page), null);
    const saved = await saveProjectTheme(stateDir, checkout, PARCHMENT);
    assert.equal(saved.project, checkout);
    const stored = JSON.parse(await readFile(saved.file, "utf8"));
    assert.equal(stored.project, checkout);

    const loaded = await loadProjectTheme(stateDir, page);
    assert.equal(loaded?.colors.accent, "#016a71");

    assert.equal(await clearProjectTheme(stateDir, checkout), true);
    assert.equal(await loadProjectTheme(stateDir, page), null);
    assert.equal(await clearProjectTheme(stateDir, checkout), false);
  });
});

test("a theme file that no longer validates is ignored rather than applied", async () => {
  await withTemp(async (dir) => {
    const stateDir = path.join(dir, "state");
    const checkout = path.join(dir, "Site");
    await mkdir(path.join(checkout, ".git"), { recursive: true });
    const { file } = await saveProjectTheme(stateDir, checkout, PARCHMENT);
    const stored = JSON.parse(await readFile(file, "utf8"));
    stored.theme.colors.text = "#fdfbfa";
    await writeFile(file, JSON.stringify(stored));
    assert.equal(await loadProjectTheme(stateDir, path.join(checkout, "plan.html")), null);
  });
});

test("projectThemeCss declares the theme's tokens and nothing a theme value could escape", () => {
  const css = projectThemeCss(validateProjectTheme(PARCHMENT));
  assert.match(css, /^:root\{/);
  assert.match(css, /--theme-page:#faf8f5;/);
  assert.match(css, /--theme-accent-text:#ffffff;/);
  assert.match(css, /--theme-font-display:"Newsreader", Georgia, serif;/);
  assert.match(css, /--theme-radius:12px;/);
  assert.equal(css.split("{").length, 2, "one rule");
  assert.doesNotMatch(css, /<\/style/i);
});

test("readableAccent keeps an accent that reads as text and darkens one that does not", () => {
  const theme = validateProjectTheme(PARCHMENT);
  assert.equal(readableAccent(theme), "#016a71");
  const pale = validateProjectTheme({
    ...PARCHMENT,
    colors: { ...PARCHMENT.colors, accent: "#7b7bff", accentText: "#10122b" },
  });
  const ink = readableAccent(pale);
  assert.notEqual(ink, "#7b7bff");
  for (const background of ["#faf8f5", "#fdfbfa", "#f3f0ea"]) assert.ok(contrastRatio(ink, background) >= 4.5);
});
