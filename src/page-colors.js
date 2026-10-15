// Whether a page sets any colours of its own. A goblin's page keeps its own colours; one that
// sets none, plain text with the browser's black on nothing, is shown on the frame's own page
// colours instead of a white sheet. Serialized into the SDK (serializeModuleHelpers), so this
// module exports functions only.

/**
 * @param {any} doc the page's document
 * @param {(element: any) => { color: string, backgroundColor: string, backgroundImage: string, colorScheme?: string }} styleOf
 */
export function pageSetsItsOwnColors(doc, styleOf) {
  const isClear = (style) =>
    /^(transparent|rgba\(\d+, \d+, \d+, 0\))$/.test(style.backgroundColor) && style.backgroundImage === "none";
  // The browser's own black, the colour of text nothing coloured.
  const browserText = "rgb(0, 0, 0)";
  for (const root of [doc.documentElement, doc.body]) {
    if (!root) continue;
    const style = styleOf(root);
    if (!isClear(style) || style.color !== browserText) return true;
    if (style.colorScheme && style.colorScheme !== "normal") return true;
  }
  // A drawing assumes the background it was drawn for, and a declared scheme is a choice.
  if (doc.querySelector('svg, canvas, meta[name="color-scheme"]')) return true;
  const elements = doc.body ? doc.body.querySelectorAll("*") : [];
  // Reading every element of a very large page would hold its first look; past this many it
  // keeps its own colours, the safe side.
  const limit = 5000;
  if (elements.length > limit) return true;
  for (const element of elements) {
    // Links, marks and form controls wear the browser's colours, which follow the scheme.
    if (element.closest("a, mark, button, input, select, textarea, option, script, style, template, noscript"))
      continue;
    const style = styleOf(element);
    if (style.color !== browserText || !isClear(style)) return true;
  }
  return false;
}

/**
 * The frame's page colours for a page that sets none. `:where` gives the rule no specificity, so
 * anything the page says still wins.
 * @param {{ background: string, color: string, scheme: string }} defaults
 */
export function pageDefaultsCss(defaults) {
  return `:where(html){background:${defaults.background};color:${defaults.color};color-scheme:${defaults.scheme}}`;
}
