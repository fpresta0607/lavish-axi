import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (name) => readFile(new URL(`../src/${name}`, import.meta.url), "utf8");

// Colours that mean the same on any page: the dark ink on the amber count badge, and the red dot
// of a live microphone.
const THEME_NEUTRAL = new Set([".count-badge|color", ".voice-dot|background"]);

function rules(css) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@media[^{]*\{/g, "");
  return [...stripped.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({
    selectors: selectors.split(",").map((selector) => selector.replace(/\s+/g, " ").trim()),
    declarations: body
      .split(";")
      .map((declaration) => declaration.split(":"))
      .filter((parts) => parts.length > 1)
      .map(([property, ...value]) => ({ property: property.trim(), value: value.join(":").trim() })),
  }));
}

// The property a project theme overrides for a written-out colour: a border colour or a whole
// background, say, both count.
function family(property) {
  return property.startsWith("border") ? "border" : property.startsWith("background") ? "background" : property;
}

test("the project theme layer re-colours every colour the frame's rules write out", async () => {
  const markup = (await read("server.js")) + (await read("chrome-client.js"));
  const used = new Set(markup.match(/[A-Za-z][\w-]*/g));
  const covered = new Set();
  for (const rule of rules(await read("project-theme.css"))) {
    for (const selector of rule.selectors) {
      const scoped = /^html\[data-project-theme\] (.+)$/.exec(selector);
      if (!scoped) continue;
      for (const { property } of rule.declarations) covered.add(`${scoped[1]}|${family(property)}`);
    }
  }

  const missing = [];
  for (const file of ["board-components.css", "chrome.css"]) {
    for (const rule of rules(await read(file))) {
      for (const selector of rule.selectors) {
        if (selector.startsWith(":root") || /^(\d+%|from|to)$/.test(selector)) continue;
        const classes = [...selector.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
        if (!classes.every((name) => used.has(name))) continue;
        for (const { property, value } of rule.declarations) {
          if (property.startsWith("--") || !/#[0-9a-f]{3,8}\b|rgba?\(|\bwhite\b/i.test(value)) continue;
          const key = `${selector}|${family(property)}`;
          if (!covered.has(key) && !THEME_NEUTRAL.has(key))
            missing.push(`${file}: ${selector} { ${property}: ${value} }`);
        }
      }
    }
  }
  assert.deepEqual(missing, []);
});
