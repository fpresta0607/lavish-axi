import { writeFile } from "node:fs/promises";

import { boardTokenBlock } from "../src/board-tokens.js";
import {
  BOARD_FONT_FILES,
  BOARD_FONT_LICENSES,
  BOARD_FONTS,
  BOARD_STYLES,
  codeGoblinsDir,
  hasBoard,
  readBoardFile,
} from "./board-source.js";

// Copies the board's token block and its fonts into this repository again, for when
// test/board-tokens.test.js reports that the board changed.
const HEADER = `/* The Code Goblins board's token block, copied by value from code-goblins
   ${BOARD_STYLES}: its font faces, its :root rule and the rules that only
   declare tokens. Never edit a value here. When the board changes, run
   \`node scripts/sync-board-tokens.js\`; test/board-tokens.test.js fails while the
   two differ. */
`;

const dir = codeGoblinsDir();
if (!hasBoard(dir)) {
  console.error(`no code-goblins checkout at ${dir}; set CODE_GOBLINS_DIR`);
  process.exit(1);
}

await writeFile(
  new URL("../src/board-tokens.css", import.meta.url),
  HEADER + boardTokenBlock(readBoardFile(dir, BOARD_STYLES, "utf8")),
);
for (const name of [...BOARD_FONT_FILES, ...BOARD_FONT_LICENSES]) {
  await writeFile(
    new URL(`../src/fonts/${name}`, import.meta.url),
    readBoardFile(dir, `${BOARD_FONTS}/${name}`, "buffer"),
  );
}
console.log(`copied the board's token block and fonts from ${dir}`);
