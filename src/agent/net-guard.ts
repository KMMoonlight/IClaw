import { lookup as dnsLookup } from "node:dns/promises";

/**
 * SSRF guard shared by `web_fetch` and URL watchers.
 *
 * Hostnames are resolved with DNS and every returned address is checked, so a
 * public-looking domain that resolves to loopback/private space (DNS rebinding,
 * `nip.io`, cloud metadata, ...) is rejected — not just literal private IPs.
 */

export type HostLookup = (hostname: string) => Promise<string[]>;

const defaultLookup: HostLookup = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
};

let hostLookup: HostLookup = defaultLookup;

/** Override the DNS resolver (tests); pass `null` to restore the default. */
export function setHostLookup(fn: HostLookup | null): void {
  hostLookup = fn ?? defaultLookup;
}

function normalizeHost(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const zone = host.indexOf("%"); // strip IPv6 zone id (fe80::1%en0)
  if (zone >= 0) host = host.slice(0, zone);
  return host;
}

function parseIpv4(ip: string): number[] | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.some((p) => p > 255) ? null : parts;
}

/** True for loopback / private / link-local / CGNAT / multicast / reserved IPv4. */
export function isPrivateIpv4(ip: string): boolean {
  const p = parseIpv4(ip);
  if (!p) return false;
  const [a, b] = p as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/** Expand an IPv6 literal into 8 16-bit groups (handles `::` and embedded IPv4). */
function expandIpv6(ip: string): number[] | null {
  let s = ip;
  if (s.includes(".")) {
    const idx = s.lastIndexOf(":");
    const v4 = parseIpv4(s.slice(idx + 1));
    if (!v4) return null;
    const [a, b, c, d] = v4 as [number, number, number, number];
    s = `${s.slice(0, idx)}:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toHextets = (part: string): number[] =>
    part ? part.split(":").map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)) : [];
  const head = toHextets(halves[0] ?? "");
  const back = halves.length === 2 ? toHextets(halves[1] ?? "") : [];
  if ([...head, ...back].some((n) => Number.isNaN(n))) return null;
  const fill = 8 - head.length - back.length;
  if (fill < 0) return null;
  return [...head, ...Array<number>(fill).fill(0), ...back];
}

/** True for loopback / unspecified / ULA / link-local / multicast / IPv4-mapped private IPv6. */
export function isPrivateIpv6(ip: string): boolean {
  const h = expandIpv6(ip);
  if (!h) return false;
  if (h.every((x) => x === 0)) return true; // ::
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true; // ::1
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) {
    return isPrivateIpv4(`${h[6]! >> 8}.${h[6]! & 255}.${h[7]! >> 8}.${h[7]! & 255}`);
  }
  if (h.slice(0, 6).every((x) => x === 0)) {
    // IPv4-compatible (deprecated) `::x.x.x.x`
    return isPrivateIpv4(`${h[6]! >> 8}.${h[6]! & 255}.${h[7]! >> 8}.${h[7]! & 255}`);
  }
  const first = h[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (first === 0x2001 && h[1] === 0x0db8) return true; // 2001:db8::/32 documentation
  return false;
}

/** True when `host` is an IPv4/IPv6 literal. */
export function isIpLiteral(host: string): boolean {
  if (parseIpv4(host)) return true;
  return host.includes(":") && /^[0-9a-f:.]+$/i.test(host);
}

/** True for any private/local IP literal (v4 or v6). */
export function isPrivateIp(ip: string): boolean {
  const host = normalizeHost(ip);
  if (parseIpv4(host)) return isPrivateIpv4(host);
  if (host.includes(":")) return isPrivateIpv6(host);
  return false;
}

/**
 * String-only host check: localhost names and private IP literals.
 * Domains are NOT resolved here (see {@link assertPublicHost} for that).
 */
export function isPrivateHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (host === "" || host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIpLiteral(host)) return isPrivateIp(host);
  return false;
}

const BLOCKED = "出于安全考虑，不允许访问内网/本机地址";

/**
 * Reject a URL host that is local, or that resolves (via DNS) to any local /
 * private address. Throws on DNS failure or empty results (fail closed).
 */
export async function assertPublicHost(hostname: string, lookup: HostLookup = hostLookup): Promise<void> {
  const host = normalizeHost(hostname);
  if (host === "" || host === "localhost" || host.endsWith(".localhost")) {
    throw new Error(`${BLOCKED}：${hostname}`);
  }
  if (isIpLiteral(host)) {
    if (isPrivateIp(host)) throw new Error(`${BLOCKED}：${hostname}`);
    return;
  }

  let ips: string[];
  try {
    ips = await lookup(host);
  } catch {
    throw new Error(`无法解析主机名：${host}`);
  }
  if (ips.length === 0) throw new Error(`无法解析主机名：${host}`);
  for (const ip of ips) {
    if (isPrivateIp(ip)) throw new Error(`主机名解析到内网地址，已阻止：${host} (${ip})`);
  }
}
