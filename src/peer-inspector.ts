import type { DiscoveredPeer, DnsDiscoveryConfig } from "./dns-discovery.js";
import { discoveredPeerToConfig } from "./dns-discovery.js";
import {
  buildHttpRegistryUrl,
  resolveHttpRegistryAgentId,
} from "./http-discovery.js";
import type {
  LoadSelfIdentityResult,
  SelfIdentity,
} from "./self-identity.js";
import type { PeerConfig } from "./types.js";

export interface MaskedAuthView {
  type: string;
  tokenPreview?: string;
}

export interface PeerConfigView {
  name: string;
  agentCardUrl: string;
  auth?: MaskedAuthView;
}

export interface DiscoveredPeerView extends PeerConfigView {
  host: string;
  port: number;
  protocol?: string;
  discoveredAt: number;
  ttl: number;
}

export interface EffectivePeerView extends PeerConfigView {
  source: "static" | "discovered";
}

export interface PeerCollisionView {
  name: string;
  winner: "static";
  staticPeer: PeerConfigView;
  discoveredPeer: DiscoveredPeerView;
}

export interface DiscoveryInspectionView {
  enabled: boolean;
  type: "dns" | "http";
  serviceName: string;
  refreshIntervalMs: number;
  mergeWithStatic: boolean;
  httpRegistryUrl?: string;
  httpRegistryHasToken: boolean;
  resolvedRegistryUrl?: string;
  selfIdentityPath: string;
  selfIdentity?: {
    whoami?: string;
    slug?: string;
    name?: string;
  };
  selfIdentityError?: string;
}

export interface PeerInspectionSnapshot {
  summary: {
    staticPeers: number;
    discoveredPeers: number;
    effectivePeers: number;
    collisions: number;
  };
  discovery: DiscoveryInspectionView;
  staticPeers: PeerConfigView[];
  discoveredPeers: DiscoveredPeerView[];
  effectivePeers: EffectivePeerView[];
  collisions: PeerCollisionView[];
}

function maskToken(token: string): string | undefined {
  const value = token.trim();
  if (!value) return undefined;
  if (value.length <= 8) {
    return `${value[0]}...${value[value.length - 1]}`;
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function toAuthView(
  auth?: {
    type?: string;
    token?: string;
  },
): MaskedAuthView | undefined {
  if (!auth?.type || !auth?.token) return undefined;
  return {
    type: auth.type,
    tokenPreview: maskToken(auth.token),
  };
}

export function toPeerConfigView(peer: PeerConfig): PeerConfigView {
  return {
    name: peer.name,
    agentCardUrl: peer.agentCardUrl,
    auth: toAuthView(peer.auth),
  };
}

export function toDiscoveredPeerView(peer: DiscoveredPeer): DiscoveredPeerView {
  return {
    name: peer.name,
    agentCardUrl: peer.agentCardUrl,
    auth: toAuthView(peer.auth),
    host: peer.host,
    port: peer.port,
    protocol: peer.protocol,
    discoveredAt: peer.discoveredAt,
    ttl: peer.ttl,
  };
}

function pickIdentity(identity?: SelfIdentity): DiscoveryInspectionView["selfIdentity"] | undefined {
  if (!identity) return undefined;
  return {
    whoami: identity.whoami,
    slug: identity.slug,
    name: identity.name,
  };
}

export function buildPeerInspectionSnapshot(params: {
  discovery: DnsDiscoveryConfig;
  staticPeers: PeerConfig[];
  discoveredPeers: DiscoveredPeer[];
  selfIdentityResult: LoadSelfIdentityResult;
}): PeerInspectionSnapshot {
  const { discovery, staticPeers, discoveredPeers, selfIdentityResult } = params;
  const staticViews = staticPeers.map(toPeerConfigView);
  const discoveredViews = discoveredPeers.map(toDiscoveredPeerView);
  const discoveredByName = new Map(discoveredViews.map((peer) => [peer.name, peer]));

  const collisions = staticViews
    .filter((peer) => discoveredByName.has(peer.name))
    .map((peer) => ({
      name: peer.name,
      winner: "static" as const,
      staticPeer: peer,
      discoveredPeer: discoveredByName.get(peer.name)!,
    }));

  const effectivePeers: EffectivePeerView[] = discovery.mergeWithStatic
    ? [
        ...staticViews.map((peer) => ({ ...peer, source: "static" as const })),
        ...discoveredPeers
          .filter((peer) => !staticPeers.some((staticPeer) => staticPeer.name === peer.name))
          .map((peer) => ({ ...toPeerConfigView(discoveredPeerToConfig(peer)), source: "discovered" as const })),
      ]
    : discoveredPeers.map((peer) => ({
        ...toPeerConfigView(discoveredPeerToConfig(peer)),
        source: "discovered" as const,
      }));

  const resolvedRegistryUrl = discovery.type === "http" && discovery.httpRegistryUrl
    ? buildHttpRegistryUrl(
        discovery.httpRegistryUrl,
        resolveHttpRegistryAgentId(selfIdentityResult.identity),
      )
    : undefined;

  return {
    summary: {
      staticPeers: staticViews.length,
      discoveredPeers: discoveredViews.length,
      effectivePeers: effectivePeers.length,
      collisions: collisions.length,
    },
    discovery: {
      enabled: discovery.enabled,
      type: discovery.type ?? "dns",
      serviceName: discovery.serviceName,
      refreshIntervalMs: discovery.refreshIntervalMs,
      mergeWithStatic: discovery.mergeWithStatic,
      httpRegistryUrl: discovery.httpRegistryUrl,
      httpRegistryHasToken: Boolean(discovery.httpRegistryToken),
      resolvedRegistryUrl,
      selfIdentityPath: selfIdentityResult.path,
      selfIdentity: pickIdentity(selfIdentityResult.identity),
      selfIdentityError: selfIdentityResult.error,
    },
    staticPeers: staticViews,
    discoveredPeers: discoveredViews,
    effectivePeers,
    collisions,
  };
}

function formatPeerLine(peer: PeerConfigView | EffectivePeerView): string {
  const source = "source" in peer ? ` source=${peer.source}` : "";
  const auth = peer.auth ? ` auth=${peer.auth.type}${peer.auth.tokenPreview ? `(${peer.auth.tokenPreview})` : ""}` : "";
  return `- ${peer.name}${source}${auth} ${peer.agentCardUrl}`;
}

export function formatPeerInspectionText(snapshot: PeerInspectionSnapshot, peerName?: string): string {
  const lines = [
    `Discovery: enabled=${snapshot.discovery.enabled} type=${snapshot.discovery.type} mergeWithStatic=${snapshot.discovery.mergeWithStatic} refreshIntervalMs=${snapshot.discovery.refreshIntervalMs}`,
    "Visibility scope: only runtime effective peers from static peers plus discovery results are included; never infer or append agents from registry /agents listings, host memory, or self identity unless they are already effective peers.",
  ];

  if (snapshot.discovery.selfIdentity) {
    const identity = snapshot.discovery.selfIdentity;
    lines.push(
      `Identity: whoami=${identity.whoami || "-"} slug=${identity.slug || "-"} name=${identity.name || "-"}`,
    );
  } else if (snapshot.discovery.selfIdentityError) {
    lines.push(`Identity: unavailable (${snapshot.discovery.selfIdentityError})`);
  } else {
    lines.push("Identity: unavailable");
  }

  if (snapshot.discovery.resolvedRegistryUrl) {
    lines.push(`Resolved registry URL: ${snapshot.discovery.resolvedRegistryUrl}`);
  }

  lines.push(
    `Counts: static=${snapshot.summary.staticPeers} discovered=${snapshot.summary.discoveredPeers} effective=${snapshot.summary.effectivePeers} collisions=${snapshot.summary.collisions}`,
  );

  if (snapshot.collisions.length > 0) {
    lines.push(`Collisions: ${snapshot.collisions.map((item) => item.name).join(", ")} (static wins)`);
  }

  const effective = peerName
    ? snapshot.effectivePeers.filter((peer) => peer.name === peerName)
    : snapshot.effectivePeers;

  if (effective.length === 0) {
    lines.push(peerName ? `Effective peers: none matched "${peerName}"` : "Effective peers: none");
    return lines.join("\n");
  }

  lines.push("Effective peers:");
  for (const peer of effective) {
    lines.push(formatPeerLine(peer));
  }

  return lines.join("\n");
}
