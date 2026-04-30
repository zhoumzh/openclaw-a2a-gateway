import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  HttpDiscoveryManager,
  buildHttpRegistryUrl,
  resolveDiscoveredAgentCardUrl,
  resolveHttpRegistryAgentId,
  unwrapHttpRegistryPayload,
} from "../src/http-discovery.js";
import type { DnsDiscoveryConfig } from "../src/dns-discovery.js";

const noopLog = () => {};

function makeConfig(overrides: Partial<DnsDiscoveryConfig> = {}): DnsDiscoveryConfig {
  return {
    enabled: true,
    type: "http",
    serviceName: "_a2a._tcp.local",
    httpRegistryUrl: "https://registry.example.com",
    refreshIntervalMs: 30_000,
    mergeWithStatic: true,
    ...overrides,
  };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restoreAll();
});

describe("resolveHttpRegistryAgentId", () => {
  it("prefers WHOAMI over slug and name", () => {
    assert.equal(
      resolveHttpRegistryAgentId({ whoami: "agent-whoami", slug: "agent-slug", name: "Agent Name" }),
      "agent-whoami",
    );
  });

  it("falls back to slug when WHOAMI is absent", () => {
    assert.equal(resolveHttpRegistryAgentId({ slug: "agent-slug", name: "Agent Name" }), "agent-slug");
  });
});

describe("buildHttpRegistryUrl", () => {
  it("builds a discovery URL from a bare registry host", () => {
    assert.equal(
      buildHttpRegistryUrl("https://registry.example.com", "bot-1"),
      "https://registry.example.com/agents/bot-1/discovery",
    );
  });

  it("replaces an {agentId} placeholder when present", () => {
    assert.equal(
      buildHttpRegistryUrl("https://registry.example.com/agents/{agentId}/discovery", "bot-1"),
      "https://registry.example.com/agents/bot-1/discovery",
    );
  });

  it("appends the agentId after an /agents base path", () => {
    assert.equal(
      buildHttpRegistryUrl("https://registry.example.com/agents", "bot-1"),
      "https://registry.example.com/agents/bot-1/discovery",
    );
  });
});

describe("unwrapHttpRegistryPayload", () => {
  it("accepts top-level arrays", () => {
    const result = unwrapHttpRegistryPayload([{ id: "peer-1" }]);

    assert.deepEqual(result, [{ id: "peer-1" }]);
  });

  it("accepts empty arrays", () => {
    assert.deepEqual(unwrapHttpRegistryPayload([]), []);
  });
});

describe("resolveDiscoveredAgentCardUrl", () => {
  it("uses a host field directly when it already points at an agent card", () => {
    assert.equal(
      resolveDiscoveredAgentCardUrl({
        host: "https://peer.example.com/.well-known/agent-card.json",
      }),
      "https://peer.example.com/.well-known/agent-card.json",
    );
  });
});

describe("HttpDiscoveryManager", () => {
  it("builds the discovery URL from WHOAMI and parses array responses", async () => {
    mock.method(fs, "readFileSync", () => "WHOAMI=bot-1\n");

    globalThis.fetch = (async (input: string | URL | Request) => {
      assert.equal(String(input), "https://registry.example.com/agents/bot-1/discovery");
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ([
          {
            id: "peer-1",
            name: "Peer 1",
            agentCardUrl: "https://peer.example.com/.well-known/agent-card.json",
            auth: { type: "bearer", token: "secret-token" },
          },
        ]),
      } as Response;
    }) as typeof fetch;

    const manager = new HttpDiscoveryManager(makeConfig(), noopLog);
    await manager.triggerRefresh();

    const peers = manager.getDiscoveredPeers();
    assert.equal(peers.length, 1);
    assert.equal(peers[0].name, "Peer 1");
    assert.equal(peers[0].agentCardUrl, "https://peer.example.com/.well-known/agent-card.json");
    assert.deepEqual(peers[0].auth, { type: "bearer", token: "secret-token" });
  });

  it("treats empty discovery arrays as a valid no-peer result", async () => {
    mock.method(fs, "readFileSync", () => "WHOAMI=bot-1\n");

    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ([]),
    })) as typeof fetch;

    const manager = new HttpDiscoveryManager(makeConfig(), noopLog);
    await manager.triggerRefresh();

    assert.deepEqual(manager.getDiscoveredPeers(), []);
  });
});
