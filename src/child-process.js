import { execFile as nodeExecFile, spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const crossSpawn = createRequire(import.meta.url)("cross-spawn");
const nodeExecFileAsync = promisify(nodeExecFile);

// Every process Lavish starts goes through this module.
/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {import("node:child_process").SpawnOptions} [options]
 * @returns {import("node:child_process").ChildProcess}
 */
export function spawn(command, args, options = {}) {
  return nodeSpawn(command, args, options);
}

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {import("node:child_process").SpawnSyncOptionsWithStringEncoding} options
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
export function spawnSync(command, args, options) {
  return nodeSpawnSync(command, args, options);
}

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {import("node:child_process").ExecFileOptionsWithStringEncoding} options
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export function execFileAsync(command, args, options) {
  return nodeExecFileAsync(command, args, options);
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
  return crossSpawn.sync(command, args, options);
}
