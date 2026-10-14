import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Creating a symlink needs a privilege an ordinary Windows account lacks. Tests that assert
// on a real on-disk link use `symlinkTest` (or `{ skip: symlinkSkip }`) so they skip only where
// the machine cannot make one, and run everywhere it can (CI, Developer Mode, elevated shells).
export function probeSymlinkSkip(createSymlink = symlinkSync) {
  const probe = mkdtempSync(path.join(os.tmpdir(), "lavish-symlink-probe-"));
  try {
    createSymlink(path.join(probe, "target"), path.join(probe, "link"));
    return false;
  } catch (error) {
    return `symlink creation unavailable: ${error.code || error.message}`;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

export const symlinkSkip = probeSymlinkSkip();

export function symlinkTest(name, run) {
  return test(name, { skip: symlinkSkip }, run);
}
