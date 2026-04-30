import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DiscoveredPeer } from "../src/dns-discovery.js";
import { buildPeerInspectionSnapshot, formatPeerInspectionText } from "../src/peer-inspector.js";
import type { PeerConfig } from "../src/types.js";

const staticPeers: PeerConfig[] = [
  {
    name: "peer-a",
    agentCardUrl: "https://static.example.com/.well-known/agent-card.json",
    auth: { type: "bearer", token: "static-secret-token" },
  },
];

const discoveredPeers: DiscoveredPeer[] = [
  {
    name: "peer-a",
    host: "dynamic.example.com",
    port: 443,
    agentCardUrl: "https://dynamic.example.com/.well-known/agent-card.json",
    protocol: "jsonrpc",
    auth: { type: "bearer", token: "dynamic-secret-token" },
    discoveredAt: 1_700_000_000_000,
    ttl: 60,
  },
  {
    name: "peer-b",
    host: "peer-b.example.com",
    port: 443,
    agentCardUrl: "https://peer-b.example.com/.well-known/agent-card.json",
    protocol: "jsonrpc",
    auth: { type: "bearer", token: "second-secret-token" },
    discoveredAt: 1_700_000_000_000,
    ttl: 60,
  },
];

describe("buildPeerInspectionSnapshot", () => {
  it("reports collisions and keeps static peers when mergeWithStatic is true", () => {
    const snapshot = buildPeerInspectionSnapshot({
      discovery: {
        enabled: true,
        type: "http",
        serviceName: "_a2a._tcp.local",
        httpRegistryUrl: "https://registry.example.com",
        refreshIntervalMs: 30_000,
        mergeWithStatic: true,
      },
      staticPeers,
      discoveredPeers,
      selfIdentityResult: {
        path: "/workspace/.a2a",
        identity: { whoami: "bot-1", hasDescription: false, hasSkills: false, skills: [] },
      },
    });

    assert.equal(snapshot.summary.staticPeers, 1);
    assert.equal(snapshot.summary.discoveredPeers, 2);
    assert.equal(snapshot.summary.effectivePeers, 2);
    assert.equal(snapshot.summary.collisions, 1);
    assert.equal(snapshot.collisions[0].name, "peer-a");
    assert.equal(snapshot.effectivePeers[0].name, "peer-a");
    assert.equal(snapshot.effectivePeers[0].source, "static");
    assert.equal(snapshot.effectivePeers[1].name, "peer-b");
    assert.equal(snapshot.effectivePeers[1].source, "discovered");
    assert.equal(
      snapshot.discovery.resolvedRegistryUrl,
      "https://registry.example.com/agents/bot-1/discovery",
    );
  });

  it("uses only discovered peers when mergeWithStatic is false", () => {
    const snapshot = buildPeerInspectionSnapshot({
      discovery: {
        enabled: true,
        type: "http",
        serviceName: "_a2a._tcp.local",
        httpRegistryUrl: "https://registry.example.com",
        refreshIntervalMs: 30_000,
        mergeWithStatic: false,
      },
      staticPeers,
      discoveredPeers,
      selfIdentityResult: {
        path: "/workspace/.a2a",
        identity: { whoami: "bot-1", hasDescription: false, hasSkills: false, skills: [] },
      },
    });

    assert.equal(snapshot.summary.effectivePeers, 2);
    assert.deepEqual(
      snapshot.effectivePeers.map((peer) => peer.source),
      ["discovered", "discovered"],
    );
  });
});

describe("formatPeerInspectionText", () => {
  it("includes counts, resolved URL, and masked auth previews", () => {
    const snapshot = buildPeerInspectionSnapshot({
      discovery: {
        enabled: true,
        type: "http",
        serviceName: "_a2a._tcp.local",
        httpRegistryUrl: "https://registry.example.com",
        refreshIntervalMs: 30_000,
        mergeWithStatic: true,
      },
      staticPeers,
      discoveredPeers,
      selfIdentityResult: {
        path: "/workspace/.a2a",
        identity: { whoami: "bot-1", hasDescription: false, hasSkills: false, skills: [] },
      },
    });

    const text = formatPeerInspectionText(snapshot);

    assert.match(text, /Counts: static=1 discovered=2 effective=2 collisions=1/);
    assert.match(text, /Resolved registry URL: https:\/\/registry\.example\.com\/agents\/bot-1\/discovery/);
    assert.match(text, /auth=bearer\(stat\.\.\.oken\)/);
  });
});
