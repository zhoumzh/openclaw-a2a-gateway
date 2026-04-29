import fs from "node:fs";

import type { AgentCardConfig } from "./types.js";

export interface SelfIdentity {
  whoami?: string;
  sandboxId?: string;
  slug?: string;
  name?: string;
  description?: string;
  hasDescription: boolean;
  skills: string[];
  hasSkills: boolean;
  publicUrl?: string;
}

export interface LoadSelfIdentityResult {
  path: string;
  identity?: SelfIdentity;
  error?: string;
}

export const DEFAULT_SELF_IDENTITY_PATH = "/workspace/.a2a";

function parseKvFile(content: string): Record<string, string> {
  const kvs: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^([^=]+)=(.*)$/);
    if (match) {
      kvs[match[1].trim().toLowerCase()] = match[2].trim();
    }
  }
  return kvs;
}

function getValue(kvs: Record<string, string>, ...keys: string[]): string {
  for (const key of keys) {
    const value = kvs[key.toLowerCase()];
    if (value) return value;
  }
  return "";
}

function hasKey(kvs: Record<string, string>, ...keys: string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(kvs, key.toLowerCase()));
}

export function normalizeAgentTransportUrl(raw: string): string | undefined {
  if (!raw) return undefined;

  const value = raw.trim().replace(/\/+$/, "");
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;

  try {
    const parsed = new URL(withProtocol);
    if (parsed.pathname.includes("/.well-known/")) {
      return `${parsed.origin}/a2a/jsonrpc`;
    }
    if (parsed.pathname.endsWith("/a2a/jsonrpc")) {
      return withProtocol;
    }
    return `${parsed.origin}/a2a/jsonrpc`;
  } catch {
    return undefined;
  }
}

export function parseSelfIdentity(content: string): SelfIdentity | undefined {
  const kvs = parseKvFile(content);
  const whoami = getValue(kvs, "whoami");
  const slug = getValue(kvs, "slug");
  const name = getValue(kvs, "name");
  const identityKey = whoami || slug || name;
  if (!identityKey) return undefined;

  const skillsRaw = getValue(kvs, "skills");
  const hasDescription = hasKey(kvs, "description");
  const hasSkills = hasKey(kvs, "skills");
  const publicUrl = normalizeAgentTransportUrl(
    getValue(kvs, "agent_card_url", "agentcardurl", "public_url", "publicurl", "base_url", "baseurl", "host", "url"),
  );

  return {
    whoami: whoami || undefined,
    sandboxId: getValue(kvs, "sandbox_id", "sandboxid") || undefined,
    slug: slug || undefined,
    name: name || slug || whoami || undefined,
    description: hasDescription ? getValue(kvs, "description") : undefined,
    hasDescription,
    skills: hasSkills && skillsRaw ? skillsRaw.split(",").map((item) => item.trim()).filter(Boolean) : [],
    hasSkills,
    publicUrl,
  };
}

export function loadSelfIdentity(path = DEFAULT_SELF_IDENTITY_PATH): LoadSelfIdentityResult {
  try {
    const identity = parseSelfIdentity(fs.readFileSync(path, "utf-8"));
    return { path, identity };
  } catch (err) {
    return { path, error: err instanceof Error ? err.message : String(err) };
  }
}

export function mergeSelfIdentityIntoAgentCard(agentCard: AgentCardConfig, identity: SelfIdentity): boolean {
  const next: AgentCardConfig = {
    ...agentCard,
    name: identity.name || agentCard.name,
    description: identity.hasDescription ? identity.description : agentCard.description,
    url: identity.publicUrl || agentCard.url,
    skills: identity.hasSkills ? identity.skills : agentCard.skills,
  };

  const changed = JSON.stringify(agentCard) !== JSON.stringify(next);
  if (changed) {
    agentCard.name = next.name;
    agentCard.description = next.description;
    agentCard.url = next.url;
    agentCard.skills = next.skills;
  }
  return changed;
}
