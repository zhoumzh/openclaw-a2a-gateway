import fs from "node:fs";
import type { IDiscoveryManager, DiscoveredPeer, DnsDiscoveryConfig, DiscoveryLogFn } from "./dns-discovery.js";
import type { PeerConfig, AgentCardConfig } from "./types.js";
import { discoveredPeerToConfig } from "./dns-discovery.js";

/**
 * Extended config for HTTP registry discovery.
 * Adds the self-discovery callback that is only meaningful for the pull-based
 * HTTP registry model — DNS-SD has no equivalent concept.
 */
export interface HttpDiscoveryConfig extends DnsDiscoveryConfig {
  /** Fired when this agent's own entry is found in the registry (matched via /workspace/.a2a WHOAMI). */
  onSelfDiscovered?: (card: AgentCardConfig) => void;
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

  /** Begin periodic HTTP registry polling. */
  start(): void {
    if (!this.config.enabled || this.running) return;
    if (!this.config.httpRegistryUrl) {
      this.log("warn", "http-discovery.start-failed", { error: "Missing httpRegistryUrl" });
      return;
    }
    this.running = true;

    this.log("info", "http-discovery.start", {
      registryUrl: this.config.httpRegistryUrl,
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
    if (!this.config.httpRegistryUrl) return;

    const headers: Record<string, string> = {
      "Accept": "application/json",
    };
    if (this.config.httpRegistryToken) {
      headers["Authorization"] = `Bearer ${this.config.httpRegistryToken}`;
    }

    const res = await fetch(this.config.httpRegistryUrl, { headers });
    if (!res.ok) {
      throw new Error(`Registry responded with status ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    if (!Array.isArray(data)) {
      throw new Error("Invalid registry response: expected JSON array");
    }

    let whoami: string | null = null;
    try {
      const content = fs.readFileSync("/workspace/.a2a", "utf-8");
      const match = content.match(/^WHOAMI=(.+)$/m);
      if (match && match[1]) {
        whoami = match[1].trim();
      }
    } catch {
      // Ignore if file is missing or unreadable
    }

    const now = Date.now();
    const newPeers: DiscoveredPeer[] = [];

    for (const item of data) {
      if (!item || typeof item !== "object") continue;

      if (whoami && item.id === whoami && this.config.onSelfDiscovered) {
        try {
          const cardConfig: AgentCardConfig = {
            name: typeof item.name === "string" ? item.name : "",
            description: typeof item.description === "string" ? item.description : undefined,
            skills: Array.isArray(item.skills) ? item.skills.map((s: any) => {
              if (typeof s === "string") return s;
              return {
                id: s?.id,
                name: s?.name,
                description: s?.description
              };
            }) : [],
          };
          this.config.onSelfDiscovered(cardConfig);
        } catch (err) {
          this.log("warn", "http-discovery.self-inject-failed", { error: String(err) });
        }
      }

      const agentCardUrl = typeof item.agentCardUrl === "string" ? item.agentCardUrl : "";
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
      const rawName = typeof item.name === "string" ? item.name : "";
      const fallbackName = host.split(".")[0] || "peer";
      const peerName = rawName || fallbackName;

      const peer: DiscoveredPeer = {
        name: peerName,
        host,
        port,
        agentCardUrl,
        protocol: typeof item.protocol === "string" ? item.protocol : "jsonrpc",
        discoveredAt: now,
        ttl: (this.config.refreshIntervalMs / 1000) * 2, // TTL is 2x refresh interval to allow 1 missed ping
      };

      if (item.auth && typeof item.auth === "object") {
        const authRaw = item.auth as Record<string, unknown>;
        const typeRaw = typeof authRaw.type === "string" ? authRaw.type : "";
        const token = typeof authRaw.token === "string" ? authRaw.token : "";
        if ((typeRaw === "bearer" || typeRaw === "apiKey") && token) {
          peer.auth = { type: typeRaw, token };
        }
      }

      newPeers.push(peer);
    }

    // Full replacement for hot reload
    this.discoveredPeers = newPeers;

    this.log("info", "http-discovery.refreshed", {
      registryUrl: this.config.httpRegistryUrl,
      activePeers: this.discoveredPeers.length,
      peerNames: this.discoveredPeers.map((p) => p.name),
    });
  }
}
