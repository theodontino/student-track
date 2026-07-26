const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function isLoopbackHost(hostname: string) {
  return LOOPBACK_HOSTS.has(hostname.replace(/^\[|\]$/g, "").toLowerCase());
}

export function isAllowedLocalApiRequest(input: {
  requestOrigin: string;
  origin?: string | null;
  secFetchSite?: string | null;
  host?: string | null;
}) {
  try {
    const requestUrl = new URL(input.requestOrigin);
    if (!isLoopbackHost(requestUrl.hostname)) return false;
    if (input.host) {
      const hostName = new URL(`http://${input.host}`).hostname;
      if (!isLoopbackHost(hostName)) return false;
    }
    if (input.origin) {
      const originUrl = new URL(input.origin);
      if (originUrl.origin !== requestUrl.origin) return false;
    }
    const secFetchSite = input.secFetchSite?.trim().toLowerCase();
    if (secFetchSite && !["same-origin", "none"].includes(secFetchSite)) return false;
    return true;
  } catch {
    return false;
  }
}
