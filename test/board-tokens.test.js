import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BOARD_FONT_FILES,
  BOARD_FONTS,
  BOARD_STYLES,
  codeGoblinsDir,
  hasBoard,
  readBoardFile,
} from "../scripts/board-source.js";
import {
  boardFontFaces,
  boardRulesFor,
  boardScrollbarThumb,
  boardTokenBlock,
  boardTokenDeclarations,
  boardTokenValue,
} from "../src/board-tokens.js";

// Scrawl wears the Code Goblins board's look by value: src/board-tokens.css is a copy of the
// board's own token block, and src/board-components.css holds rules copied from the board word
// for word, never a second palette. These tests read the board's current stylesheet from the
// code-goblins checkout beside this repository and fail when a copy differs, so the two cannot
// drift apart unnoticed.
const boardDir = codeGoblinsDir();
const skip = hasBoard(boardDir)
  ? false
  : `no code-goblins checkout at ${boardDir}; set CODE_GOBLINS_DIR to compare against the board`;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** @param {string} css */
function ruleLines(css) {
  return css
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

test("the token file equals the board's current token block", { skip }, async () => {
  const board = boardTokenBlock(readBoardFile(boardDir, BOARD_STYLES, "utf8"));
  const copy = boardTokenBlock(await readFile(new URL("../src/board-tokens.css", import.meta.url), "utf8"));

  assert.ok(board.includes("--accent-green"), "the board's token block was not found in its stylesheet");
  assert.ok(board.includes("--lantern"), "the board's goblin palette was not found in its stylesheet");
  assert.equal(copy, board, "src/board-tokens.css differs from the board: run `node scripts/sync-board-tokens.js`");
});

test("every rule copied from the board is still in the board's stylesheet", { skip }, async () => {
  const board = new Set(ruleLines(readBoardFile(boardDir, BOARD_STYLES, "utf8")));
  const copied = ruleLines(await readFile(new URL("../src/board-components.css", import.meta.url), "utf8"));
  const changed = copied.filter((line) => !board.has(line));

  assert.ok(copied.length > 0, "src/board-components.css holds no rules");
  assert.deepEqual(
    changed,
    [],
    "these rules in src/board-components.css are no longer in the board: copy the board's current ones",
  );
});

test("the fonts Scrawl serves are the board's own files", { skip }, async () => {
  for (const name of BOARD_FONT_FILES) {
    const board = readBoardFile(boardDir, `${BOARD_FONTS}/${name}`, "buffer");
    const copy = await readFile(new URL(`../src/fonts/${name}`, import.meta.url));

    assert.equal(sha256(copy), sha256(board), `src/fonts/${name} differs from the board's font`);
  }
});

test("boardTokenBlock takes the font faces, the :root rule and later rules that only declare tokens", () => {
  const css = [
    "/* a comment */",
    '@font-face { font-family: "A"; }',
    ":root {",
    "  --one: 1;",
    "}",
    "body { margin: 0; }",
    ".dialogue, .voice-dock { --hide: #241C15; --corners: polygon(0 4px, 2px 4px); }",
    ".dialogue { --tone: var(--lantern); position: relative; }",
    ".dialogue.done { --tone: var(--moss); }",
  ].join("\r\n");

  assert.equal(
    boardTokenBlock(css),
    [
      '@font-face { font-family: "A"; }',
      ":root {",
      "  --one: 1;",
      "}",
      ".dialogue, .voice-dock { --hide: #241C15; --corners: polygon(0 4px, 2px 4px); }",
      ".dialogue.done { --tone: var(--moss); }",
      "",
    ].join("\n"),
  );
});

test("boardTokenBlock refuses a stylesheet with no token block", () => {
  assert.throws(() => boardTokenBlock("body { margin: 0; }"), /token block/);
});

const SAMPLE_BLOCK =
  '@font-face { font-family: "A"; }\n@font-face { font-family: "B"; }\n:root {\n  --accent-green: #00e59b;\n}\n';

test("boardTokenValue reads one token and refuses a name the block does not declare", () => {
  assert.equal(boardTokenValue(SAMPLE_BLOCK, "--accent-green"), "#00e59b");
  assert.throws(() => boardTokenValue(SAMPLE_BLOCK, "--accent"), /no --accent/);
});

test("boardScrollbarThumb reads the thumb colour and refuses rules that set none", () => {
  assert.equal(boardScrollbarThumb("* { scrollbar-width: thin; scrollbar-color: #38564d transparent; }"), "#38564d");
  assert.throws(() => boardScrollbarThumb("* { box-sizing: border-box; }"), /no scrollbar-color/);
});

test("boardFontFaces keeps only the font faces", () => {
  assert.equal(boardFontFaces(SAMPLE_BLOCK), '@font-face { font-family: "A"; }\n@font-face { font-family: "B"; }');
});

test("boardRulesFor keeps the rules whose selectors start with a prefix, whole", () => {
  const css = [
    "/* base */",
    "button, input {",
    "  border: 0;",
    "}",
    ".primary { color: #000; }",
    ".topbar { display: grid; }",
    "a:hover, .comment-overlay header { display: grid; }",
    "@media (max-width: 50rem) { .comment-overlay.floating { left: 8px; } }",
    "@keyframes card-in { from { opacity: 0; } }",
  ].join("\n");

  assert.equal(
    boardRulesFor(css, ["button", ".comment-", "@keyframes card-in"]),
    [
      "button, input {\n  border: 0;\n}",
      "a:hover, .comment-overlay header { display: grid; }",
      "@keyframes card-in { from { opacity: 0; } }",
    ].join("\n"),
  );
});

test("boardTokenDeclarations keeps the :root declarations for a shadow root's :host rule", () => {
  const declarations = boardTokenDeclarations(
    '@font-face { font-family: "A"; }\n:root {\n  /* note */\n  --one: 1;\n  color: #fff;\n}\n.dialogue { --hide: #241C15; }\n',
  );

  assert.equal(declarations, "--one: 1;color: #fff;");
});
