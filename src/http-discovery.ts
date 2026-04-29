import type { IDiscoveryManager, DiscoveredPeer, DnsDiscoveryConfig, DiscoveryLogFn } from "./dns-discovery.js";
import type { PeerConfig } from "./types.js";
import { discoveredPeerToConfig } from "./dns-discovery.js";
import { loadSelfIdentity, type SelfIdentity } from "./self-identity.js";

/**
 * Extended config for HTTP registry discovery.
 * Kept as a named extension point for HTTP registry-specific options.
 */
export interface HttpDiscoveryConfig extends DnsDiscoveryConfig {}

export function resolveHttpRegistryAgentId(identity?: Pick<SelfIdentity, "whoami" | "slug" | "name">): string | undefined {
  const raw = identity?.whoami || identity?.slug || identity?.name || "";
  const value = raw.trim();
  return value || undefined;
}

export function buildHttpRegistryUrl(configuredUrl: string, agentId?: string): string | undefined {
  const raw = configuredUrl.trim();
  if (!raw) return undefined;

  if (raw.includes("{agentId}")) {
    if (!agentId) return undefined;
    return raw.replaceAll("{agentId}", encodeURIComponent(agentId));
  }

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const parsed = new URL(withProtocol);
  const normalizedPath = parsed.pathname.replace(/\/+$/, "");

  if (/\/agents\/[^/]+\/discovery$/i.test(normalizedPath)) {
    return parsed.toString();
  }

  if (!agentId) return undefined;

  if (!normalizedPath || normalizedPath === "/") {
    parsed.pathname = `/agents/${encodeURIComponent(agentId)}/discovery`;
    return parsed.toString();
  }

  if (/\/agents$/i.test(normalizedPath)) {
    parsed.pathname = `${normalizedPath}/${encodeURIComponent(agentId)}/discovery`;
    return parsed.toString();
  }

  parsed.pathname = `${normalizedPath}/agents/${encodeURIComponent(agentId)}/discovery`;
  return parsed.toString();
}

export function unwrapHttpRegistryPayload(rawData: unknown): unknown[] {
  if (Array.isArray(rawData)) {
    return rawData;
  }

  if (rawData && typeof rawData === "object") {
    const record = rawData as Record<string, unknown>;
    if (record.data && typeof record.data === "object") {
      const data = record.data as Record<string, unknown>;
      if (Array.isArray(data.dependencies)) {
        return data.dependencies;
      }
      if (Array.isArray(data.items)) {
        return data.items;
      }
    }

    if (Array.isArray(record.items)) {
      return record.items;
    }
  }

  throw new Error("Invalid registry response: expected JSON array or { data: { dependencies/items: [] } } envelope");
}

export function resolveDiscoveredAgentCardUrl(item: Record<string, unknown>): string {
  const direct = typeof item.agentCardUrl === "string" ? item.agentCardUrl.trim() : "";
  if (direct) {
    return direct;
  }

  const host = typeof item.host === "string" ? item.host.trim() : "";
  if (!host) {
    return "";
  }

  try {
    const parsed = new URL(host);
    if (parsed.pathname.includes("/.well-known/")) {
      return parsed.toString();
    }
    if (parsed.pathname.endsWith("/a2a/jsonrpc")) {
      return `${parsed.origin}/.well-known/agent-card.json`;
    }
    return `${parsed.origin}/.well-known/agent-card.json`;
  } catch {
    const baseHost = host.endsWith("/") ? host.slice(0, -1) : host;
    return `${baseHost}/.well-known/agent-card.json`;
  }
}

/**
 * HTTP Registry-based dynamic agent discovery.
 * 
 * Polls a central HTTP endpoint to retrieve an array of available peers.
 * Excellent for cloud/container environments (like K8s or E2B sandboxes)
 * where mDNS / DNS-SD broadcast is blocked or unsupported.
 */
export class HttpDiscoveryManager implements IDiscoveryManager {
  private readonly config: HttpDiscoveryConfig;
  private readonly log: DiscoveryLogFn;
  private discoveredPeers: DiscoveredPeer[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(config: HttpDiscoveryConfig, log: DiscoveryLogFn) {
    this.config = config;
    this.log = log;
  }

  private resolveRegistryUrl(): string | undefined {
    if (!this.config.httpRegistryUrl) {
      return undefined;
    }

    const identityResult = loadSelfIdentity();
    const agentId = resolveHttpRegistryAgentId(identityResult.identity);
    return buildHttpRegistryUrl(this.config.httpRegistryUrl, agentId);
  }

  /** Begin periodic HTTP registry polling. */
  start(): void {
    if (!this.config.enabled || this.running) return;
    if (!this.config.httpRegistryUrl) {
      this.log("warn", "http-discovery.start-failed", { error: "Missing httpRegistryUrl" });
      return;
    }
    const resolvedUrl = this.resolveRegistryUrl();
    if (!resolvedUrl) {
      this.log("warn", "http-discovery.start-failed", {
        error: "Unable to resolve registry discovery URL from httpRegistryUrl + /workspace/.a2a WHOAMI/slug",
      });
      return;
    }
    this.running = true;

    this.log("info", "http-discovery.start", {
      registryUrl: resolvedUrl,
      refreshIntervalMs: this.config.refreshIntervalMs,
    });

    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.config.refreshIntervalMs);
  }

  /** Stop periodic discovery and clear cached peers. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const cleared = this.discoveredPeers.length;
    this.discoveredPeers = [];
    this.running = false;
    this.log("info", "http-discovery.stop", { peersCleared: cleared });
  }

  getDiscoveredPeers(): DiscoveredPeer[] {
    return [...this.discoveredPeers];
  }

  toPeerConfigs(): PeerConfig[] {
    return this.discoveredPeers.map(discoveredPeerToConfig);
  }

  findPeer(name: string): DiscoveredPeer | undefined {
    return this.discoveredPeers.find((p) => p.name === name);
  }

  async triggerRefresh(): Promise<void> {
    try {
      await this.discover();
    } catch (err) {
      this.log("warn", "http-discovery.refresh-failed", {
        error: err instanceof Error ? err.message : String(err),
        retainedPeers: this.discoveredPeers.length,
      });
    }
  }

  private refresh(): void {
    this.discover().catch((err) => {
      this.log("warn", "http-discovery.refresh-failed", {
        error: err instanceof Error ? err.message : String(err),
        retainedPeers: this.discoveredPeers.length,
      });
    });
  }

  private async discover(): Promise<void> {
    const registryUrl = this.resolveRegistryUrl();
    if (!registryUrl) {
      throw new Error("Unable to resolve registry discovery URL from httpRegistryUrl + /workspace/.a2a WHOAMI/slug");
    }

    const headers: Record<string, string> = {
      "Accept": "application/json",
    };
    if (this.config.httpRegistryToken) {
      headers["Authorization"] = `Bearer ${this.config.httpRegistryToken}`;
    }

    const res = await fetch(registryUrl, { headers });
    if (!res.ok) {
      throw new Error(`Registry responded with status ${res.status} ${res.statusText}`);
    }

    const rawData = await res.json();
    const data = unwrapHttpRegistryPayload(rawData);

    const now = Date.now();
    const newPeers: DiscoveredPeer[] = [];

    for (const item of data) {
      if (!item || typeof item !== "object") continue;

      const record = item as Record<string, unknown>;
      const agentCardUrl = resolveDiscoveredAgentCardUrl(record);
      if (!agentCardUrl) continue; // agentCardUrl is strictly required

      let host = "";
      let port = 0;
      try {
        const parsed = new URL(agentCardUrl);
        host = parsed.hostname;
        port = parseInt(parsed.port, 10) || (parsed.protocol === "https:" ? 443 : 80);
      } catch {
        continue;
      }

      // Name fallback logic
      const rawName = typeof record.name === "string" ? record.name : "";
      const rawId = typeof record.id === "string" ? record.id : "";
      const fallbackName = rawId || host.split(".")[0] || "peer";
      const peerName = rawName || fallbackName;

      const peer: DiscoveredPeer = {
        name: peerName,
        host,
        port,
        agentCardUrl,
        protocol: typeof record.protocol === "string" ? record.protocol : "jsonrpc",
        discoveredAt: now,
        ttl: (this.config.refreshIntervalMs / 1000) * 2, // TTL is 2x refresh interval to allow 1 missed ping
      };

      if (record.auth && typeof record.auth === "object") {
        const authRaw = record.auth as Record<string, unknown>;
        const typeRaw = typeof authRaw.type === "string" ? authRaw.type : "";
        const token = typeof authRaw.token === "string" ? authRaw.token : "";
        if ((typeRaw === "bearer" || typeRaw === "apiKey") && token) {
          peer.auth = { type: typeRaw, token };
        }
      } else if (typeof record.token === "string" && record.token) {
        // Fallback: If registry only returns a flat 'token' string, wrap it as bearer
        peer.auth = { type: "bearer", token: record.token };
      }

      newPeers.push(peer);
    }

    // Full replacement for hot reload
    this.discoveredPeers = newPeers;

    this.log("info", "http-discovery.refreshed", {
      registryUrl,
      activePeers: this.discoveredPeers.length,
      peerNames: this.discoveredPeers.map((p) => p.name),
    });
  }
}
