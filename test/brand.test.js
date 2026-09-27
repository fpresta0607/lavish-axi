import assert from "node:assert/strict";
import test from "node:test";

import { brandName, brandTitleSuffix, DEFAULT_BRAND } from "../src/brand.js";

test("brandName defaults to Code Goblins in this fork and honors LAVISH_AXI_BRAND", () => {
  assert.equal(brandName({}), "Code Goblins");
  assert.equal(brandName({ LAVISH_AXI_BRAND: "" }), "Code Goblins");
  assert.equal(brandName({ LAVISH_AXI_BRAND: "   " }), DEFAULT_BRAND);
  assert.equal(brandName({ LAVISH_AXI_BRAND: "Acme Review" }), "Acme Review");
  assert.equal(brandName({ LAVISH_AXI_BRAND: "  Acme \n Review  " }), "Acme Review");
});

test("brandName keeps the default for a name too long for the top bar", () => {
  assert.equal(brandName({ LAVISH_AXI_BRAND: "x".repeat(48) }), "x".repeat(48));
  assert.equal(brandName({ LAVISH_AXI_BRAND: "x".repeat(49) }), DEFAULT_BRAND);
});

test("a review tab's title ends with Lavish, or with the brand that replaces it", () => {
  assert.equal(brandTitleSuffix(DEFAULT_BRAND), "Lavish");
  assert.equal(brandTitleSuffix("Acme Review"), "Acme Review");
});
