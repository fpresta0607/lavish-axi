import assert from "node:assert/strict";
import test from "node:test";

import { pageDefaultsCss, pageSetsItsOwnColors } from "../src/page-colors.js";

const UNSET = {
  color: "rgb(0, 0, 0)",
  backgroundColor: "rgba(0, 0, 0, 0)",
  backgroundImage: "none",
  colorScheme: "normal",
};

// A page as the SDK reads it: elements with computed styles, found by tag the way querySelector does.
function page({ root = {}, body = {}, elements = [], meta = false } = {}) {
  const make = (tag, style, skipped = false) => ({ tag, style: { ...UNSET, ...style }, skipped });
  const documentElement = make("html", root);
  const bodyElement = make("body", body);
  const all = elements.map(({ tag = "p", style = {}, skipped = false }) => make(tag, style, skipped));
  bodyElement.querySelectorAll = () => all;
  for (const element of all) element.closest = () => (element.skipped ? element : null);
  return {
    documentElement,
    body: bodyElement,
    querySelector: (selector) =>
      (selector.includes("svg") && all.find((element) => ["svg", "canvas"].includes(element.tag))) ||
      (selector.includes("color-scheme") && meta) ||
      null,
  };
}
const styleOf = (element) => element.style;

test("a page of plain text with no colours of its own takes the frame's", () => {
  assert.equal(pageSetsItsOwnColors(page({ elements: [{ tag: "h1" }, { tag: "p" }] }), styleOf), false);
});

for (const { name, setup } of [
  { name: "a background on html", setup: { root: { backgroundColor: "rgb(250, 248, 245)" } } },
  { name: "a background image on body", setup: { body: { backgroundImage: "linear-gradient(red, blue)" } } },
  { name: "a text colour on html", setup: { root: { color: "rgb(51, 51, 51)" } } },
  { name: "a text colour on body", setup: { body: { color: "rgb(51, 51, 51)" } } },
  { name: "a colour scheme", setup: { root: { colorScheme: "dark" } } },
  { name: "a color-scheme meta tag", setup: { meta: true } },
  { name: "a heading in its own colour", setup: { elements: [{ tag: "h1", style: { color: "rgb(1, 106, 113)" } }] } },
  {
    name: "a card with a background",
    setup: { elements: [{ tag: "div", style: { backgroundColor: "rgb(240, 240, 240)" } }] },
  },
  { name: "a drawing that assumes its own background", setup: { elements: [{ tag: "svg" }] } },
]) {
  test(`a page with ${name} keeps its own colours`, () => {
    assert.equal(pageSetsItsOwnColors(page(setup), styleOf), true);
  });
}

test("links, marks and form controls wear the browser's colours and do not count as the page's", () => {
  const elements = [{ tag: "a", style: { color: "rgb(0, 0, 238)" }, skipped: true }];
  assert.equal(pageSetsItsOwnColors(page({ elements }), styleOf), false);
});

test("pageDefaultsCss gives html the frame's colours with no specificity", () => {
  assert.equal(
    pageDefaultsCss({ background: "#03050a", color: "#edf4f3", scheme: "dark" }),
    ":where(html){background:#03050a;color:#edf4f3;color-scheme:dark}",
  );
});
