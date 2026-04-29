import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  mergeSelfIdentityIntoAgentCard,
  normalizeAgentTransportUrl,
  parseSelfIdentity,
} from "../src/self-identity.js";
import type { AgentCardConfig } from "../src/types.js";

describe("self identity", () => {
  it("parses C-side .a2a metadata into an agent card identity", () => {
    const identity = parseSelfIdentity([
      "WHOAMI=zhoumingzhu-da71",
      "sandbox_id=sandbox-workspace--openclaw-air-sidecar-20260414-xhrdz",
      "slug=zhoumingzhu-da71",
      "name=测试专家",
      "description=专职测试、是个高手",
      "skills=slame",
      "host=https://a2a-zhoumingzhu-da71.openclawpages-test.inner.chj.cloud",
    ].join("\n"));

    assert.ok(identity);
    assert.equal(identity.name, "测试专家");
    assert.equal(identity.description, "专职测试、是个高手");
    assert.deepEqual(identity.skills, ["slame"]);
    assert.equal(
      identity.publicUrl,
      "https://a2a-zhoumingzhu-da71.openclawpages-test.inner.chj.cloud/a2a/jsonrpc",
    );
  });

  it("normalizes card endpoints and bare hosts to JSON-RPC transport URLs", () => {
    assert.equal(
      normalizeAgentTransportUrl("https://a2a-example/.well-known/agent-card.json"),
      "https://a2a-example/a2a/jsonrpc",
    );
    assert.equal(
      normalizeAgentTransportUrl("a2a-example.openclawpages-test.inner.chj.cloud"),
      "https://a2a-example.openclawpages-test.inner.chj.cloud/a2a/jsonrpc",
    );
    assert.equal(
      normalizeAgentTransportUrl("http://localhost:18800/a2a/jsonrpc"),
      "http://localhost:18800/a2a/jsonrpc",
    );
  });

  it("overrides persisted/default card fields with self identity values", () => {
    const card: AgentCardConfig = {
      name: "Local Agent",
      description: "old",
      url: "http://localhost:18800/a2a/jsonrpc",
      skills: [],
    };
    const changed = mergeSelfIdentityIntoAgentCard(card, {
      whoami: "zhoumingzhu-da71",
      slug: "zhoumingzhu-da71",
      name: "测试专家",
      description: "专职测试、是个高手",
      hasDescription: true,
      skills: ["slame"],
      hasSkills: true,
      publicUrl: "https://a2a-zhoumingzhu-da71.openclawpages-test.inner.chj.cloud/a2a/jsonrpc",
    });

    assert.equal(changed, true);
    assert.equal(card.name, "测试专家");
    assert.equal(card.description, "专职测试、是个高手");
    assert.deepEqual(card.skills, ["slame"]);
    assert.equal(
      card.url,
      "https://a2a-zhoumingzhu-da71.openclawpages-test.inner.chj.cloud/a2a/jsonrpc",
    );
  });

  it("treats empty .a2a skills as an explicit clear", () => {
    const identity = parseSelfIdentity([
      "WHOAMI=zhoumingzhu-da71",
      "name=测试专家",
      "skills=",
    ].join("\n"));
    const card: AgentCardConfig = {
      name: "Old Agent",
      description: "old",
      url: "",
      skills: ["old-skill"],
    };

    assert.ok(identity);
    mergeSelfIdentityIntoAgentCard(card, identity);
    assert.deepEqual(card.skills, []);
  });
});
