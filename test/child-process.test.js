import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

import { createCopilotCliAmbientContextScript, createServerSpawnOptions } from "../src/cli.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const PROCESS_MODULES = new Set(["child_process", "node:child_process", "cross-spawn"]);

/** @param {string} dir @returns {Promise<string[]>} */
async function javascriptFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/**
 * Every place a file loads a module that starts processes: an import or export declaration, or a
 * call such as require(), createRequire(...)() or import() whose first argument names one.
 *
 * @param {string} file
 * @param {string} text
 */
function processModuleLoads(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  /** @type {string[]} */
  const loads = [];
  /** @param {ts.Node} node */
  const visit = (node) => {
    const specifier =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
        ? node.moduleSpecifier
        : ts.isCallExpression(node)
          ? node.arguments[0]
          : undefined;
    if (specifier && ts.isStringLiteral(specifier) && PROCESS_MODULES.has(specifier.text)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      loads.push(`${path.relative(root, file)}:${line + 1} loads ${specifier.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return loads;
}

test("every process Lavish starts goes through src/child-process.js", async () => {
  const files = [
    ...(await javascriptFiles(path.join(root, "src"))),
    ...(await javascriptFiles(path.join(root, "bin"))),
  ];
  const helper = path.join(root, "src", "child-process.js");
  /** @type {string[]} */
  const elsewhere = [];
  let helperLoads = 0;
  for (const file of files) {
    const loads = processModuleLoads(file, await readFile(file, "utf8"));
    if (file === helper) helperLoads += loads.length;
    else elsewhere.push(...loads);
  }
  // A guard that stops reading files approves everything, so it proves it read them.
  assert.ok(files.length > 20, `read only ${files.length} files`);
  assert.ok(helperLoads >= 2, "the guard no longer sees src/child-process.js load child_process and cross-spawn");
  assert.deepEqual(elsewhere, [], "start these processes through src/child-process.js, which hides their windows");
});

test("the generated Copilot ambient-context hook hides the window of the command it runs", () => {
  assert.match(createCopilotCliAmbientContextScript(), /spawnSync\(command, \[\], \{[^}]*windowsHide: true[^}]*\}\)/);
});

// GetConsoleWindow, printed by a PowerShell child: 0 for a console with no window.
const PROBE = Buffer.from(
  "Add-Type -Namespace LavishProbe -Name Console -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern System.IntPtr GetConsoleWindow();'; [LavishProbe.Console]::GetConsoleWindow().ToInt64()",
  "utf16le",
).toString("base64");

test(
  "a process Lavish starts from the detached server opens no console window",
  { skip: process.platform !== "win32" && "console windows exist only on Windows", timeout: 120_000 },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lavish-hidden-windows-"));
    try {
      const helper = pathToFileURL(path.join(root, "src", "child-process.js")).href;
      const parent = path.join(dir, "parent.mjs");
      const report = path.join(dir, "report.json");
      await writeFile(
        parent,
        [
          `import { writeFileSync } from "node:fs";`,
          `import { crossSpawnSync, execFileAsync, spawn, spawnSync } from ${JSON.stringify(helper)};`,
          `const probe = ["-NoProfile", "-NonInteractive", "-EncodedCommand", ${JSON.stringify(PROBE)}];`,
          `const results = {};`,
          `results.execFileAsync = (await execFileAsync("powershell.exe", probe, { encoding: "utf8" })).stdout.trim();`,
          `results.spawnSync = spawnSync("powershell.exe", probe, { encoding: "utf8" }).stdout.trim();`,
          `results.crossSpawnSync = crossSpawnSync("powershell.exe", probe, { encoding: "utf8" }).stdout.trim();`,
          `results.spawn = await new Promise((resolve, reject) => {`,
          `  const child = spawn("powershell.exe", probe, { stdio: ["ignore", "pipe", "ignore"] });`,
          `  let output = "";`,
          `  child.stdout.on("data", (chunk) => (output += chunk));`,
          `  child.on("error", reject);`,
          `  child.on("close", () => resolve(output.trim()));`,
          `});`,
          `writeFileSync(process.argv[2], JSON.stringify(results));`,
        ].join("\n"),
      );
      // Started exactly as the CLI starts its server: detached, so it has no console of its own.
      const child = nodeSpawn(process.execPath, [parent, report], createServerSpawnOptions());
      const code = await new Promise((resolve) => child.on("exit", resolve));
      assert.equal(code, 0);
      assert.deepEqual(JSON.parse(await readFile(report, "utf8")), {
        execFileAsync: "0",
        spawnSync: "0",
        crossSpawnSync: "0",
        spawn: "0",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
