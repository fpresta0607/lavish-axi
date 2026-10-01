import { execFile as nodeExecFile, spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const crossSpawn = createRequire(import.meta.url)("cross-spawn");
const nodeExecFileAsync = promisify(nodeExecFile);

// Every process Lavish starts goes through this module, so a new call site cannot forget to hide
// its window. On Windows a console program started by a process with no console of its own, as
// the detached server is, gets a new console, and Windows shows that console as a window unless
// the start asks to hide it, which every function here does with windowsHide.

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {import("node:child_process").SpawnOptions} [options]
 * @returns {import("node:child_process").ChildProcess}
 */
export function spawn(command, args, options = {}) {
  return nodeSpawn(command, args, { ...options, windowsHide: true });
}

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {import("node:child_process").SpawnSyncOptionsWithStringEncoding} options
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
export function spawnSync(command, args, options) {
  return nodeSpawnSync(command, args, { ...options, windowsHide: true });
}

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {import("node:child_process").ExecFileOptionsWithStringEncoding} options
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export function execFileAsync(command, args, options) {
  return nodeExecFileAsync(command, args, { ...options, windowsHide: true });
}

/**
 * cross-spawn resolves a Windows command shim, such as an npm `.cmd`, the way a shell would.
 *
 * @param {string} command
 * @param {readonly string[]} args
 * @param {import("node:child_process").SpawnSyncOptionsWithStringEncoding} options
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
export function crossSpawnSync(command, args, options) {
  return crossSpawn.sync(command, args, { ...options, windowsHide: true });
}
