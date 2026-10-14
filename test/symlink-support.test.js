import assert from "node:assert/strict";
import { test } from "node:test";

import { probeSymlinkSkip } from "./symlink-support.js";

const DENIAL_CASES = [
  {
    name: "EPERM",
    error: Object.assign(new Error("EPERM: operation not permitted, symlink"), { code: "EPERM" }),
    reason: "EPERM",
  },
  {
    name: "EACCES",
    error: Object.assign(new Error("EACCES: permission denied, symlink"), { code: "EACCES" }),
    reason: "EACCES",
  },
  { name: "an error without a code", error: new Error("no links here"), reason: "no links here" },
];

for (const { name, error, reason } of DENIAL_CASES) {
  test(`probeSymlinkSkip returns a skip reason when symlink creation fails with ${name}`, () => {
    const skip = probeSymlinkSkip(() => {
      throw error;
    });

    assert.equal(skip, `symlink creation unavailable: ${reason}`);
  });
}

test("probeSymlinkSkip returns false when symlink creation works", () => {
  const attempts = [];

  const skip = probeSymlinkSkip((target, linkPath) => attempts.push({ target, linkPath }));

  assert.equal(skip, false);
  assert.equal(attempts.length, 1, "the probe attempts exactly one link");
});

test("probeSymlinkSkip leaves no probe directory behind", async () => {
  const { existsSync } = await import("node:fs");
  const seen = [];

  probeSymlinkSkip((target) => seen.push(target));

  assert.equal(existsSync(seen[0].replace(/[\\/]target$/, "")), false);
});
