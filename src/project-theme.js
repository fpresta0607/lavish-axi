// A project's own look for Scrawl's frame. A goblin reads the frontend of the project a page
// belongs to and saves its colours, type and corner radius with `lavish-axi theme`; every page of
// that project then opens in a frame that wears them. A project with no saved theme wears the
// Code Goblins SIQ theme, the board's own look.
//
// Themes live in Lavish's state directory, one file per project, never in the project's
// repository. A theme is data, not CSS: every value is checked against a narrow shape before it is
// written into the review page, and its text must be readable on its surfaces.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const THEME_COLOR_NAMES = Object.freeze([
  "page",
  "surface",
  "raised",
  "text",
  "muted",
  "accent",
  "accentText",
  "border",
]);

// WCAG AA for body text, the bar his rule sets for every text pair the frame draws.
const MIN_TEXT_CONTRAST = 4.5;
const TEXT_PAIRS = Object.freeze([
  ["text", "page"],
  ["text", "surface"],
  ["text", "raised"],
  ["muted", "page"],
  ["muted", "surface"],
  ["muted", "raised"],
  ["accentText", "accent"],
]);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
// Family names, quotes, commas and spaces only: nothing that ends a declaration or calls a URL.
const FONT_LIST = /^[A-Za-z0-9 ,"'-]{1,200}$/;
const RADIUS = /^(\d{1,2}(?:\.\d{1,3})?)(px|rem)$/;
const NAME_MAX = 60;

/**
 * @typedef {{ page: string, surface: string, raised: string, text: string, muted: string, accent: string, accentText: string, border: string }} ThemeColors
 * @typedef {{ name: string, colors: ThemeColors, fonts: { body: string, display: string, mono: string }, radius: string }} ProjectTheme
 */

// The board's own look (src/board-tokens.css), as a theme: the frame's default.
/** @type {Readonly<ProjectTheme>} */
export const SIQ_THEME = Object.freeze({
  name: "Code Goblins SIQ",
  colors: Object.freeze({
    page: "#03050a",
    surface: "#0c1219",
    raised: "#10222a",
    text: "#edf4f3",
    muted: "#a3b3c2",
    accent: "#00e59b",
    accentText: "#03130c",
    border: "#2f7d66",
  }),
  fonts: Object.freeze({
    body: '"Nunito", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
    display: '"Pixelify Sans", "Nunito", ui-sans-serif, system-ui, sans-serif',
    mono: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
  }),
  radius: "0.625rem",
});

export function contrastRatio(foreground, background) {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
}

function relativeLuminance(hex) {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
  const [r, g, b] = channels.map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// A theme is light when its page is: the frame then draws status colours and shadows for a light
// surface, and tells the browser so before anything paints.
export function themeScheme(theme) {
  return relativeLuminance(theme.colors.page) > 0.4 ? "light" : "dark";
}

/**
 * Checks a theme and returns the fields Scrawl uses, lower-cased colours included. Throws with
 * every problem at once, so a goblin fixes its theme in one pass.
 * @param {unknown} input
 * @returns {ProjectTheme}
 */
export function validateProjectTheme(input) {
  const source = input && typeof input === "object" ? /** @type {Record<string, any>} */ (input) : {};
  const problems = [];
  /** @type {Record<string, string>} */
  const colors = {};
  for (const name of THEME_COLOR_NAMES) {
    const value = source.colors?.[name];
    if (typeof value !== "string" || !HEX_COLOR.test(value)) {
      problems.push(`colors.${name} must be a six-digit hex colour such as #1a2b3c`);
      continue;
    }
    colors[name] = value.toLowerCase();
  }
  for (const name of ["page", "surface", "raised"]) {
    if (colors[name] === "#ffffff") problems.push(`colors.${name} must not be pure white`);
  }
  if (THEME_COLOR_NAMES.every((name) => colors[name])) {
    for (const [foreground, background] of TEXT_PAIRS) {
      const ratio = contrastRatio(colors[foreground], colors[background]);
      if (ratio < MIN_TEXT_CONTRAST) {
        problems.push(`${foreground} on ${background} is ${ratio}:1, below ${MIN_TEXT_CONTRAST}:1`);
      }
    }
  }
  /** @type {Record<string, string>} */
  const fonts = {};
  for (const name of ["body", "display", "mono"]) {
    const value = source.fonts?.[name];
    if (value === undefined && name !== "body") {
      fonts[name] = name === "display" ? fonts.body : SIQ_THEME.fonts.mono;
      continue;
    }
    if (typeof value !== "string" || !FONT_LIST.test(value.trim())) {
      problems.push(`fonts.${name} must be a font family list of names, quotes, commas and spaces`);
      continue;
    }
    fonts[name] = value.trim();
  }
  const radius = source.radius === undefined ? SIQ_THEME.radius : source.radius;
  const radiusMatch = typeof radius === "string" ? RADIUS.exec(radius) : null;
  const radiusPx = radiusMatch ? Number(radiusMatch[1]) * (radiusMatch[2] === "rem" ? 16 : 1) : -1;
  if (radiusPx < 0 || radiusPx > 32) problems.push("radius must be a length from 0px to 32px, in px or rem");
  const name = typeof source.name === "string" ? source.name.trim().slice(0, NAME_MAX) : "";
  if (problems.length) throw new Error(`invalid theme: ${problems.join("; ")}`);
  // Every colour and font was checked above, so the shape is complete.
  return /** @type {ProjectTheme} */ ({ name, colors, fonts, radius });
}

/**
 * The checkout a page or directory belongs to: the nearest directory at or above it that holds
 * `.git`, and for a git worktree the main checkout it was made from, so every worktree of a
 * project shares its theme.
 * @param {string} start a page file or a directory
 */
export async function projectRootOf(start) {
  const resolved = path.resolve(start);
  const isDirectory = (await stat(resolved).catch(() => null))?.isDirectory() === true;
  let dir = isDirectory ? resolved : path.dirname(resolved);
  while (true) {
    const dotGit = path.join(dir, ".git");
    const entry = await stat(dotGit).catch(() => null);
    if (entry?.isDirectory()) return dir;
    if (entry?.isFile()) return (await mainCheckoutOf(dir, dotGit)) ?? dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function mainCheckoutOf(dir, dotGit) {
  const match = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, "utf8").catch(() => ""));
  if (!match) return null;
  const gitDir = path.resolve(dir, match[1].trim());
  const commonDir = await readFile(path.join(gitDir, "commondir"), "utf8").catch(() => "");
  if (!commonDir.trim()) return null;
  const common = path.resolve(gitDir, commonDir.trim());
  return path.basename(common) === ".git" ? path.dirname(common) : null;
}

function themeFile(stateDir, projectRoot) {
  const identity = process.platform === "win32" ? projectRoot.toLowerCase() : projectRoot;
  const name = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return path.join(stateDir, "themes", `${name}.json`);
}

/**
 * @param {string} stateDir
 * @param {string} projectRoot
 * @param {unknown} theme
 */
export async function saveProjectTheme(stateDir, projectRoot, theme) {
  const checked = validateProjectTheme(theme);
  const file = themeFile(stateDir, projectRoot);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(
    temporary,
    JSON.stringify({ project: projectRoot, saved_at: new Date().toISOString(), theme: checked }, null, 2),
  );
  await rename(temporary, file);
  return { project: projectRoot, file, theme: checked };
}

export async function clearProjectTheme(stateDir, projectRoot) {
  const file = themeFile(stateDir, projectRoot);
  const existed = await stat(file).then(
    () => true,
    () => false,
  );
  await rm(file, { force: true });
  return existed;
}

/**
 * The theme the page's project saved, or null for a page with no project or no valid theme.
 * @param {string} stateDir
 * @param {string} file
 */
export async function loadProjectTheme(stateDir, file) {
  const projectRoot = await projectRootOf(file);
  if (!projectRoot) return null;
  return readProjectTheme(stateDir, projectRoot);
}

export async function readProjectTheme(stateDir, projectRoot) {
  let stored;
  try {
    stored = JSON.parse(await readFile(themeFile(stateDir, projectRoot), "utf8"));
  } catch {
    return null;
  }
  try {
    return validateProjectTheme(stored?.theme);
  } catch {
    return null;
  }
}

// The accent as the frame writes it in text, such as a link or the agent's working line: the
// theme's own accent when it reads at 4.5:1 on the page and its surfaces, otherwise the accent
// moved toward the text colour, a tenth at a time, until it does. The text colour itself reads.
export function readableAccent(theme) {
  const { accent, text, page, surface, raised } = theme.colors;
  for (let step = 0; step <= 10; step += 1) {
    const candidate = mixHex(accent, text, step / 10);
    if ([page, surface, raised].every((background) => contrastRatio(candidate, background) >= MIN_TEXT_CONTRAST)) {
      return candidate;
    }
  }
  return text;
}

function mixHex(from, to, amount) {
  const channel = (hex, start) => Number.parseInt(hex.slice(start, start + 2), 16);
  return `#${[1, 3, 5]
    .map((start) => Math.round(channel(from, start) + (channel(to, start) - channel(from, start)) * amount))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

// The theme as custom properties for the review page's head. Every value already passed
// validateProjectTheme, whose shapes cannot close a declaration, a rule or the style element.
export function projectThemeCss(theme) {
  const declarations = {
    "--theme-page": theme.colors.page,
    "--theme-surface": theme.colors.surface,
    "--theme-raised": theme.colors.raised,
    "--theme-text": theme.colors.text,
    "--theme-muted": theme.colors.muted,
    "--theme-accent": theme.colors.accent,
    "--theme-accent-text": theme.colors.accentText,
    "--theme-accent-ink": readableAccent(theme),
    "--theme-border": theme.colors.border,
    "--theme-font-body": theme.fonts.body,
    "--theme-font-display": theme.fonts.display,
    "--theme-font-mono": theme.fonts.mono,
    "--theme-radius": theme.radius,
  };
  return `:root{${Object.entries(declarations)
    .map(([name, value]) => `${name}:${value};`)
    .join("")}}`;
}
