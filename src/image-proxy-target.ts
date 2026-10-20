/*
 * Which upstream URLs the image proxy may fetch: checked when ingest signs a
 * URL and again on every redirect hop.
 *
 * Workers cannot resolve DNS, so a hostname is judged by its text. IP-literal
 * hosts in loopback, private, link-local, shared, reserved or documentation
 * ranges are refused, and so are local-only names and known cloud metadata
 * hostnames. A public name that resolves to a private address is the residual
 * risk: Workers egress goes to the public Internet only (private services need
 * a Workers VPC binding), so it cannot reach a private network. The Node
 * server is for local development and has no such egress boundary.
 *
 * Rendro's own hosts are refused too, so a proxied fetch never re-enters the
 * site: the production and development domains and their subdomains, the
 * site's Workers on any workers.dev subdomain (preview URLs included), and
 * the host the request itself arrived on.
 */

/** [first address as a 32-bit number, prefix length] */
const BLOCKED_V4: Array<[number, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
].map(([address, bits]) => [ipv4Number(address as string) as number, bits as number]);

const METADATA_HOSTS = new Set([
  "metadata", "metadata.goog", "metadata.google.internal", "instance-data", "instance-data.ec2.internal",
  "metadata.azure.com", "metadata.tencentyun.com", "metadata.platformequinix.com",
]);
const LOCAL_SUFFIXES = [".localhost", ".local", ".localdomain", ".internal", ".intranet", ".lan", ".home.arpa", ".corp"];
/** rendro.app (production) and dev.rendro.app (development) and every other subdomain. */
const OWN_DOMAIN = "rendro.app";
/** The site's Worker names (wrangler*.toml) all carry this label: `rendro`, `rendro-dev`, `<version>-rendro-dev`, … */
const OWN_WORKER_LABEL = "rendro";

function ipv4Number(host: string): number | null {
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!parts) return null;
  return parts.slice(1).reduce((value, part) => value * 256 + Number(part), 0);
}

function blockedIpv4(address: number): boolean {
  return BLOCKED_V4.some(([first, bits]) => Math.floor(address / 2 ** (32 - bits)) === Math.floor(first / 2 ** (32 - bits)));
}

/** Eight 16-bit pieces of a WHATWG-serialized IPv6 host (lower-case hex, `::` compression, no dotted tail). */
function ipv6Pieces(host: string): number[] {
  const [head, tail] = host.split("::");
  const pieces = (part: string | undefined) => (part ? part.split(":").map((piece) => parseInt(piece, 16)) : []);
  const left = pieces(head);
  const right = pieces(tail);
  return tail === undefined ? left : [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
}

/**
 * Only global unicast (2000::/3) is allowed, minus documentation (2001:db8::/32
 * and RFC 9637's 3fff::/20), 6to4 and the IETF protocol block (Teredo and
 * friends), which can embed private IPv4.
 * Loopback, unspecified, IPv4-mapped and -compatible, NAT64, ULA, link-local
 * and multicast all fall outside 2000::/3.
 */
function blockedIpv6(host: string): boolean {
  const [first, second] = ipv6Pieces(host);
  return (first & 0xe000) !== 0x2000 || first === 0x2002 || (first === 0x2001 && (second < 0x0200 || second === 0x0db8))
    || (first === 0x3fff && second < 0x1000);
}

function ownHost(host: string, extra: readonly string[]): boolean {
  if (host === OWN_DOMAIN || host.endsWith(`.${OWN_DOMAIN}`)) return true;
  if (host.endsWith(".workers.dev") && host.split(".")[0].split("-").includes(OWN_WORKER_LABEL)) return true;
  return extra.some((own) => host === own.toLowerCase().replace(/\.$/, ""));
}

/** `ownHosts`: further hosts that are the site itself, such as the one the current request arrived on. */
export function isProxyableImageUrl(href: string, ownHosts: readonly string[] = []): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.port) return false;
  const host = url.hostname.replace(/\.$/, "");
  if (host.startsWith("[")) return !blockedIpv6(host.slice(1, -1));
  const v4 = ipv4Number(host);
  if (v4 !== null) return !blockedIpv4(v4);
  // A single-label name only resolves on a local network.
  if (!host.includes(".") || METADATA_HOSTS.has(host) || ownHost(host, ownHosts)) return false;
  return !LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}
