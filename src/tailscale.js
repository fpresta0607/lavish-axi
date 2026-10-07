import { isIP } from "node:net";

import { execFileAsync } from "./child-process.js";

export function tailscaleCommandCandidates(platform = process.platform, env = process.env) {
  const candidates = ["tailscale"];
  if (platform === "darwin") {
    candidates.push(
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      "/Applications/Tailscale.app/Contents/MacOS/tailscale",
      "/opt/homebrew/bin/tailscale",
      "/usr/local/bin/tailscale",
    );
  } else if (platform === "win32") {
    const programFiles = env.ProgramFiles || "C:\\Program Files";
    candidates.push(`${programFiles}\\Tailscale\\tailscale.exe`);
  } else {
    candidates.push("/usr/bin/tailscale", "/usr/local/bin/tailscale");
  }
  return [...new Set(candidates)];
}

/**
 * @typedef {{ ipv4: string, magicDnsName: string }} TailscaleNet
 * @typedef {{ ipv4: null, magicDnsName: null, warning: string }} IncompleteTailscaleNet
 */

/**
 * Parse `tailscale status --json` into this machine's Tailscale IPv4 and MagicDNS
 * name, or null when Tailscale is not up. Never throws.
 * @param {string} raw
 * @returns {TailscaleNet | null}
 */
export function parseTailscaleStatus(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const state = String(data.BackendState || "");
  if (state !== "Running") return null;

  const ips = [];
  const selfIps = data.Self && Array.isArray(data.Self.TailscaleIPs) ? data.Self.TailscaleIPs : [];
  const topIps = Array.isArray(data.TailscaleIPs) ? data.TailscaleIPs : [];
  for (const ip of [...selfIps, ...topIps]) {
    if (typeof ip === "string") ips.push(ip.trim());
  }
  const ipv4 = ips.find((ip) => isIP(ip) === 4);
  if (!ipv4) return null;

  const dnsRaw = typeof data.Self?.DNSName === "string" ? data.Self.DNSName.trim() : "";
  const magicDnsName = dnsRaw.replace(/\.$/, "").toLowerCase();
  const labels = magicDnsName.split(".");
  if (
    magicDnsName.length > 253 ||
    labels.length < 2 ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    return null;
  }
  return { ipv4, magicDnsName };
}

/**
 * Detect a running Tailscale node on this machine. Missing binary, a stopped
 * tailnet, or any error returns null - never throws.
 * @param {{ execFile?: typeof execFileAsync, timeoutMs?: number, commands?: string[], now?: () => number }} [options]
 * @returns {Promise<TailscaleNet | IncompleteTailscaleNet | null>}
 */
export async function detectTailscale({
  execFile = execFileAsync,
  timeoutMs = 2000,
  commands = tailscaleCommandCandidates(),
  now = Date.now,
} = {}) {
  const deadline = now() + timeoutMs;
  let incompleteRunningStatus = false;
  for (const command of commands) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    try {
      const { stdout } = await execFile(command, ["status", "--json"], {
        timeout: remainingMs,
        maxBuffer: 2_000_000,
        encoding: "utf8",
      });
      const raw = String(stdout || "");
      const status = parseTailscaleStatus(raw);
      if (status) return status;
      incompleteRunningStatus ||= isIncompleteRunningTailscaleStatus(raw);
    } catch {
      continue;
    }
  }
  if (incompleteRunningStatus) {
    return {
      ipv4: null,
      magicDnsName: null,
      warning:
        "Tailscale is running but MagicDNS is unavailable; there is no phone access. Lavish remains available on loopback.",
    };
  }
  return null;
}

function isIncompleteRunningTailscaleStatus(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!data || typeof data !== "object" || String(data.BackendState || "") !== "Running") return false;
  const addresses = [
    ...(Array.isArray(data.Self?.TailscaleIPs) ? data.Self.TailscaleIPs : []),
    ...(Array.isArray(data.TailscaleIPs) ? data.TailscaleIPs : []),
  ];
  return addresses.some((address) => typeof address === "string" && isIP(address.trim()) === 4);
}

/**
 * Raw `tailscale serve status --json`, or null when no Tailscale command answers. Never throws.
 * @param {{ execFile?: typeof execFileAsync, timeoutMs?: number, commands?: string[], now?: () => number }} [options]
 * @returns {Promise<string | null>}
 */
export async function readTailscaleServeStatus({
  execFile = execFileAsync,
  timeoutMs = 2000,
  commands = tailscaleCommandCandidates(),
  now = Date.now,
} = {}) {
  const deadline = now() + timeoutMs;
  for (const command of commands) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    try {
      const { stdout } = await execFile(command, ["serve", "status", "--json"], {
        timeout: remainingMs,
        maxBuffer: 2_000_000,
        encoding: "utf8",
      });
      return String(stdout || "");
    } catch {
      continue;
    }
  }
  return null;
}

// `tailscale serve <port>` proxies to 127.0.0.1; a target written as localhost reaches the same
// listener. Lavish never listens on ::1, so a proxy to it would not reach Lavish.
const LOOPBACK_PROXY_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);

/**
 * The https origin `tailscale serve` proxies to the Lavish server on `port`, from the output of
 * `tailscale serve status --json`, or null. Only a TLS listener on this node's MagicDNS name whose
 * root handler proxies to plain http on loopback at that port qualifies, because every Lavish
 * route is root-absolute. Several qualifying listeners resolve to the lowest port. Never throws.
 * @param {string | null} raw
 * @param {{ magicDnsName: string | null | undefined, port: number }} target
 * @returns {string | null}
 */
export function tailscaleHttpsProxyOrigin(raw, { magicDnsName, port }) {
  if (!raw || !magicDnsName) return null;
  let status;
  try {
    status = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!status || typeof status !== "object") return null;
  const listenPorts = [];
  for (const config of [status, ...Object.values(status.Foreground || {})]) {
    for (const [hostPort, web] of Object.entries(config?.Web || {})) {
      const separator = hostPort.lastIndexOf(":");
      const listenPort = Number(hostPort.slice(separator + 1));
      if (hostPort.slice(0, separator).toLowerCase() !== magicDnsName) continue;
      if (config.TCP?.[listenPort]?.HTTPS !== true) continue;
      if (proxiesToLoopbackPort(web?.Handlers?.["/"]?.Proxy, port)) listenPorts.push(listenPort);
    }
  }
  if (listenPorts.length === 0) return null;
  return new URL(`https://${magicDnsName}:${Math.min(...listenPorts)}`).origin;
}

function proxiesToLoopbackPort(proxy, port) {
  if (typeof proxy !== "string" || !URL.canParse(proxy)) return false;
  const url = new URL(proxy);
  return (
    url.protocol === "http:" &&
    LOOPBACK_PROXY_HOSTNAMES.has(url.hostname) &&
    Number(url.port || 80) === port &&
    url.pathname === "/"
  );
}
