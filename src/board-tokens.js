// Scrawl wears the Code Goblins board's look by value. src/board-tokens.css is a copy of the
// board's own token block; test/board-tokens.test.js fails when it differs from the board's.

// A one-line rule that declares custom properties and nothing else, such as the goblin palette
// the board's dialogue boxes share.
const TOKEN_ONLY_RULE = /^[^@{}/]+\{\s*(--[\w-]+:[^;{}]+;\s*)+\}$/;

/**
 * The token block of a board stylesheet: its font faces, its `:root` rule, and every later rule
 * that declares only custom properties. Line endings are normalized so a checkout's line-ending
 * setting never reads as a difference.
 *
 * @param {string} css
 * @returns {string}
 */
export function boardTokenBlock(css) {
  const lines = css.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.startsWith("@font-face"));
  const root = lines.findIndex((line, index) => index >= start && line.startsWith(":root {"));
  const end = lines.findIndex((line, index) => index > root && line === "}");
  if (start < 0 || root < 0 || end < 0) throw new Error("no board token block: font faces then a :root rule");
  const tokenRules = lines.slice(end + 1).filter((line) => TOKEN_ONLY_RULE.test(line));
  return [...lines.slice(start, end + 1), ...tokenRules].join("\n") + "\n";
}

/**
 * The value the token block's `:root` rule gives one custom property.
 *
 * @param {string} css
 * @param {string} name
 * @returns {string}
 */
export function boardTokenValue(css, name) {
  const match = boardTokenBlock(css).match(new RegExp(`^\\s*${name}:\\s*([^;]+);`, "m"));
  if (!match) throw new Error(`the board's token block has no ${name}`);
  return match[1].trim();
}

/**
 * The thumb colour the board gives every scrollbar, from its `scrollbar-color` declaration.
 *
 * @param {string} css
 * @returns {string}
 */
export function boardScrollbarThumb(css) {
  const match = css.match(/scrollbar-color:\s*(\S+)\s/);
  if (!match) throw new Error("the board's rules set no scrollbar-color");
  return match[1];
}

/**
 * The token block's font faces, one rule a line.
 *
 * @param {string} css
 * @returns {string}
 */
export function boardFontFaces(css) {
  return boardTokenBlock(css)
    .split("\n")
    .filter((line) => line.startsWith("@font-face"))
    .join("\n");
}

/**
 * The rules of a stylesheet whose selector list, or at-rule, starts with one of the given
 * prefixes: the part of the copied board rules a smaller surface needs, such as the annotation
 * card inside a reviewed page.
 *
 * @param {string} css
 * @param {readonly string[]} prefixes
 * @returns {string}
 */
export function boardRulesFor(css, prefixes) {
  const text = css.replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "");
  /** @type {string[]} */
  const rules = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    if (text[index] !== "}") continue;
    depth -= 1;
    if (depth > 0) continue;
    rules.push(text.slice(start, index + 1).trim());
    start = index + 1;
  }
  return rules
    .filter((rule) =>
      rule
        .slice(0, rule.indexOf("{"))
        .split(",")
        .some((selector) => prefixes.some((prefix) => selector.trim().startsWith(prefix))),
    )
    .join("\n");
}

/**
 * The declarations inside the token block's `:root` rule, for a shadow root's `:host` rule: the
 * annotation card lives in one, where `:root` selects nothing.
 *
 * @param {string} css
 * @returns {string}
 */
export function boardTokenDeclarations(css) {
  const block = boardTokenBlock(css);
  const root = block.indexOf(":root {");
  return block
    .slice(root + ":root {".length, block.indexOf("\n}\n", root))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("");
}
