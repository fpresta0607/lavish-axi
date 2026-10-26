// The name the review page shows for itself: in its top bar, its tab title,
// its landing pages and everything the page says about its server.
// LAVISH_AXI_BRAND renames it for a team that runs Lavish inside its own tool;
// the CLI and every message to the agent keep the Lavish name.
export const DEFAULT_BRAND = "Lavish Editor";
const MAX_BRAND_LENGTH = 48;
// This fork is the review page of Code Goblins, where it is called Scrawl, so
// it carries that name unless LAVISH_AXI_BRAND names another.
const FORK_BRAND = "Scrawl";

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function brandName(env = process.env) {
  const brand = (env.LAVISH_AXI_BRAND || FORK_BRAND).replace(/\s+/g, " ").trim();
  return brand && brand.length <= MAX_BRAND_LENGTH ? brand : DEFAULT_BRAND;
}

/**
 * The short name the page goes by: what a review tab's title ends with, and
 * what the page calls its server in what it says.
 * @param {string} brand
 * @returns {string}
 */
export function brandTitleSuffix(brand) {
  return brand === DEFAULT_BRAND ? "Lavish" : brand;
}
