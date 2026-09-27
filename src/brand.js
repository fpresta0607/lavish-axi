// The name the review page shows for itself: in its top bar, its tab title and
// its landing pages. LAVISH_AXI_BRAND renames it for a team that runs Lavish
// inside its own tool; the CLI and every message about the server keep the
// Lavish name.
export const DEFAULT_BRAND = "Lavish Editor";
const MAX_BRAND_LENGTH = 48;
// This fork runs inside Code Goblins, so its review page carries that name
// unless LAVISH_AXI_BRAND names another.
const FORK_BRAND = "Code Goblins";

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function brandName(env = process.env) {
  const brand = (env.LAVISH_AXI_BRAND || FORK_BRAND).replace(/\s+/g, " ").trim();
  return brand && brand.length <= MAX_BRAND_LENGTH ? brand : DEFAULT_BRAND;
}

/**
 * The name a review tab's title ends with.
 * @param {string} brand
 * @returns {string}
 */
export function brandTitleSuffix(brand) {
  return brand === DEFAULT_BRAND ? "Lavish" : brand;
}
