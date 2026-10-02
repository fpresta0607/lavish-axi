import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Where the Code Goblins board's own files are read from: the code-goblins checkout beside this
// repository's main checkout, or the one CODE_GOBLINS_DIR names.
export const BOARD_STYLES = "frontend/src/styles.css";
export const BOARD_FONTS = "frontend/public/assets/fonts";
export const BOARD_FONT_FILES = ["pixelify-sans.woff2", "nunito.woff2", "jetbrains-mono.woff2"];
export const BOARD_FONT_LICENSES = ["pixelify-sans-OFL.txt", "nunito-OFL.txt", "jetbrains-mono-OFL.txt"];

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function git(cwd, args, encoding) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
}

/**
 * A worktree's shared git directory lives in the main checkout, so the board is looked for
 * beside that, not beside the worktree.
 *
 * @returns {string}
 */
export function codeGoblinsDir() {
  if (process.env.CODE_GOBLINS_DIR) return process.env.CODE_GOBLINS_DIR;
  const commonDir = path.resolve(repoRoot, git(repoRoot, ["rev-parse", "--git-common-dir"], "utf8").trim());
  return path.join(path.dirname(commonDir), "..", "code-goblins");
}

/**
 * @param {string} dir
 * @returns {boolean}
 */
export function hasBoard(dir) {
  return existsSync(path.join(dir, BOARD_STYLES));
}

/**
 * The board's current file is the one on its main branch as last fetched: the checkout's working
 * tree may sit on another branch or behind. A plain copy of the source with no such ref is read
 * from disk.
 *
 * @template {"utf8" | "buffer"} E
 * @param {string} dir
 * @param {string} file
 * @param {E} encoding
 * @returns {E extends "utf8" ? string : Buffer}
 */
export function readBoardFile(dir, file, encoding) {
  try {
    return /** @type {any} */ (git(dir, ["show", `origin/main:${file}`], encoding));
  } catch {
    return /** @type {any} */ (readFileSync(path.join(dir, file), encoding === "buffer" ? undefined : encoding));
  }
}
