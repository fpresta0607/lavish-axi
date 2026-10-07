import assert from "node:assert/strict";
import test from "node:test";

import {
  detectTailscale,
  parseTailscaleStatus,
  readTailscaleServeStatus,
  tailscaleHttpsProxyOrigin,
} from "../src/tailscale.js";

test("parseTailscaleStatus returns the running node IPv4 and MagicDNS name", () => {
  const result = parseTailscaleStatus(
    JSON.stringify({
      BackendState: "Running",
      Self: {
        TailscaleIPs: ["fd7a:115c:a1e0::1", "100.64.12.34"],
        DNSName: "review-phone.tailnet.ts.net.",
      },
    }),
  );
  assert.deepEqual(result, { ipv4: "100.64.12.34", magicDnsName: "review-phone.tailnet.ts.net" });
});

test("Tailscale detection fails closed when the command is unavailable or not running", async () => {
  const missing = await detectTailscale({
    // The injected command is intentionally only a test double; it need not expose
    // child-process methods from promisify(execFile).
    execFile: /** @type {any} */ (
      async () => {
        throw new Error("not installed");
      }
    ),
  });
  assert.equal(missing, null);

  const stopped = await detectTailscale({
    execFile: /** @type {any} */ (async () => ({ stdout: JSON.stringify({ BackendState: "Stopped" }) })),
  });
  assert.equal(stopped, null);
});

test("Tailscale detection falls back to the macOS application bundle", async () => {
  const attempted = [];
  const result = await detectTailscale({
    commands: ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"],
    execFile: /** @type {any} */ (
      async (command) => {
        attempted.push(command);
        if (command === "tailscale") {
          return {
            stdout: JSON.stringify({ BackendState: "Running", Self: { TailscaleIPs: ["100.64.12.34"] } }),
          };
        }
        return {
          stdout: JSON.stringify({
            BackendState: "Running",
            Self: { TailscaleIPs: ["100.64.12.34"], DNSName: "review.tailnet.ts.net." },
          }),
        };
      }
    ),
  });
  assert.deepEqual(attempted, ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]);
  assert.deepEqual(result, { ipv4: "100.64.12.34", magicDnsName: "review.tailnet.ts.net" });
});

test("Tailscale detection reports missing MagicDNS when no complete candidate exists", async () => {
  const result = await detectTailscale({
    commands: ["tailscale"],
    execFile: /** @type {any} */ (
      async () => ({
        stdout: JSON.stringify({ BackendState: "Running", Self: { TailscaleIPs: ["100.64.12.34"] } }),
      })
    ),
  });
  assert.deepEqual(result, {
    ipv4: null,
    magicDnsName: null,
    warning:
      "Tailscale is running but MagicDNS is unavailable; there is no phone access. Lavish remains available on loopback.",
  });
});

test("Tailscale detection shares one timeout budget across candidates", async () => {
  let now = 0;
  const attempts = [];
  const result = await detectTailscale({
    timeoutMs: 50,
    commands: ["one", "two", "three"],
    now: () => now,
    execFile: /** @type {any} */ (
      async (command, _args, options) => {
        attempts.push({ command, timeout: options.timeout });
        now += 30;
        throw new Error("unavailable");
      }
    ),
  });
  assert.equal(result, null);
  assert.deepEqual(attempts, [
    { command: "one", timeout: 50 },
    { command: "two", timeout: 20 },
  ]);
});

test("parseTailscaleStatus ignores malformed or non-running status", () => {
  assert.equal(parseTailscaleStatus("not json"), null);
  assert.equal(
    parseTailscaleStatus(
      JSON.stringify({ BackendState: "Running", Self: { TailscaleIPs: ["100.64.12.34"], DNSName: "bad host" } }),
    ),
    null,
  );
  assert.equal(
    parseTailscaleStatus(JSON.stringify({ BackendState: "Running", Self: { TailscaleIPs: ["999.1.1.1"] } })),
    null,
  );
});

const MAGIC_DNS_NAME = "review.tailnet.ts.net";
const LAVISH_PORT = 4387;

function httpsServe(listenPort, proxy, { mount = "/", host = MAGIC_DNS_NAME } = {}) {
  return {
    TCP: { [listenPort]: { HTTPS: true } },
    Web: { [`${host}:${listenPort}`]: { Handlers: { [mount]: { Proxy: proxy } } } },
  };
}

for (const { behavior, status, expected } of [
  {
    behavior: "returns the https origin of a proxy to the Lavish port",
    status: httpsServe(4388, "http://127.0.0.1:4387"),
    expected: "https://review.tailnet.ts.net:4388",
  },
  {
    behavior: "accepts a localhost proxy target",
    status: httpsServe(4388, "http://localhost:4387"),
    expected: "https://review.tailnet.ts.net:4388",
  },
  {
    behavior: "drops the default https port from the origin",
    status: httpsServe(443, "http://127.0.0.1:4387"),
    expected: "https://review.tailnet.ts.net",
  },
  {
    behavior: "reads a foreground serve",
    status: { Foreground: { "session-1": httpsServe(4388, "http://127.0.0.1:4387") } },
    expected: "https://review.tailnet.ts.net:4388",
  },
  {
    behavior: "picks the lowest port when several listeners proxy to Lavish",
    status: {
      TCP: { 4388: { HTTPS: true }, 443: { HTTPS: true } },
      Web: {
        [`${MAGIC_DNS_NAME}:4388`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:4387" } } },
        [`${MAGIC_DNS_NAME}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:4387" } } },
      },
    },
    expected: "https://review.tailnet.ts.net",
  },
  { behavior: "returns null with no serve config", status: {}, expected: null },
  {
    behavior: "ignores a proxy to another port",
    status: httpsServe(443, "http://localhost:5173"),
    expected: null,
  },
  {
    behavior: "ignores a plain http listener",
    status: {
      TCP: { 80: { HTTP: true } },
      Web: { [`${MAGIC_DNS_NAME}:80`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:4387" } } } },
    },
    expected: null,
  },
  {
    behavior: "ignores a handler mounted below the root",
    status: httpsServe(4388, "http://127.0.0.1:4387", { mount: "/scrawl" }),
    expected: null,
  },
  {
    behavior: "ignores a proxy target with a path",
    status: httpsServe(4388, "http://127.0.0.1:4387/scrawl"),
    expected: null,
  },
  {
    behavior: "ignores a proxy target that is not loopback",
    status: httpsServe(4388, "http://192.168.1.5:4387"),
    expected: null,
  },
  {
    behavior: "ignores a proxy target that is not plain http",
    status: httpsServe(4388, "https+insecure://127.0.0.1:4387"),
    expected: null,
  },
  {
    behavior: "ignores a listener on another name",
    status: httpsServe(4388, "http://127.0.0.1:4387", { host: "other.tailnet.ts.net" }),
    expected: null,
  },
]) {
  test(`tailscaleHttpsProxyOrigin ${behavior}`, () => {
    const origin = tailscaleHttpsProxyOrigin(JSON.stringify(status), {
      magicDnsName: MAGIC_DNS_NAME,
      port: LAVISH_PORT,
    });

    assert.equal(origin, expected);
  });
}

test("tailscaleHttpsProxyOrigin returns null without a status or a MagicDNS name", () => {
  const status = JSON.stringify(httpsServe(4388, "http://127.0.0.1:4387"));

  assert.equal(tailscaleHttpsProxyOrigin(null, { magicDnsName: MAGIC_DNS_NAME, port: LAVISH_PORT }), null);
  assert.equal(tailscaleHttpsProxyOrigin("not json", { magicDnsName: MAGIC_DNS_NAME, port: LAVISH_PORT }), null);
  assert.equal(tailscaleHttpsProxyOrigin(status, { magicDnsName: null, port: LAVISH_PORT }), null);
});

test("readTailscaleServeStatus returns the first answering command's serve status", async () => {
  const attempts = [];
  const status = await readTailscaleServeStatus({
    commands: ["tailscale", "/usr/bin/tailscale"],
    execFile: /** @type {any} */ (
      async (command, args) => {
        attempts.push([command, ...args]);
        if (command === "tailscale") throw new Error("not installed");
        return { stdout: "{}" };
      }
    ),
  });

  assert.equal(status, "{}");
  assert.deepEqual(attempts, [
    ["tailscale", "serve", "status", "--json"],
    ["/usr/bin/tailscale", "serve", "status", "--json"],
  ]);
});

test("readTailscaleServeStatus returns null when no command answers", async () => {
  const status = await readTailscaleServeStatus({
    commands: ["tailscale"],
    execFile: /** @type {any} */ (
      async () => {
        throw new Error("not installed");
      }
    ),
  });

  assert.equal(status, null);
});
