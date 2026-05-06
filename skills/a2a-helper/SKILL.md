---
name: a2a-helper
description: |
  General assistant skill for the OpenClaw A2A Gateway plugin.
  Use when the user wants help operating, verifying, inspecting, or troubleshooting A2A gateway behavior:
  peers, discovery, routing, agent cards, peer auth, outbound messaging, and day-to-day A2A usage.
  This is the primary assistant-facing skill shipped with the plugin, not a one-off setup or diagnostics script.
---

# A2A Helper

Use this skill as the main assistant entrypoint for the `a2a-gateway` plugin.

This skill is broader than setup and broader than peer diagnostics. Its job is to help the agent understand and operate the plugin at runtime.

## Primary tools

Call:

- `a2a_helper` for runtime inspection and helper actions
- `a2a_send_message` for sending text messages to a peer
- `a2a_send_file` for sending files to a peer

Current helper action:

```json
{
  "action": "inspect_peers",
  "refreshDiscovery": true
}
```

If `refreshDiscovery` is omitted, the helper should still refresh before answering.

To focus on one peer:

```json
{
  "action": "inspect_peers",
  "refreshDiscovery": true,
  "peer": "a2a-zhoumingzhu-ee58"
}
```

## Current scope

- Inspect static peers
- Inspect runtime discovered peers
- Inspect final effective peers after merge rules
- Inspect `WHOAMI`-derived HTTP registry URL
- Explain `mergeWithStatic` behavior
- Identify static-vs-discovered name collisions
- Send a text message to a named peer
- Send a file to a named peer

## Interpretation rules

- When the user asks which A2A participants/peers are visible or available, answer strictly from `a2a_helper(action=inspect_peers)` and use `effectivePeers` as the final list.
- Do not infer, merge, or append agents from registry `/agents` endpoints, host memory, prior conversation context, self identity, or any other agent catalog. In this plugin, visibility is limited to discovery results plus static peers after merge rules.
- Do not list the current instance itself unless it already appears inside `effectivePeers`.
- If `discoveredPeers` contains a peer and `effectivePeers` contains it with `source=discovered`, HTTP discovery is active and that peer is usable at runtime.
- If a peer appears in `collisions`, static config wins for that name.
- If `mergeWithStatic` is `false`, `effectivePeers` should be discovery-only.
- If `resolvedRegistryUrl` is empty in HTTP mode, inspect `/workspace/.a2a` and `WHOAMI`.

## Output format

Present the tool result as follows. Do NOT invent field names or reformat the snapshot into custom structures like `count`/`entries`.

**When peers exist** — for each entry in `effectivePeers`, fetch its `agentCardUrl` (HTTP GET, expect JSON) and extract the `name` field from the agent card. Display the agent card `name` as the primary label; show the peer ID (`effectivePeers[].name`) as secondary context, along with `source` (static/discovered) and `agentCardUrl`. If the fetch fails or the field is absent, fall back to the peer ID as the display name. Also show `summary` counts.

**When `effectivePeers` is empty** — report it directly using the counts from `summary` (e.g. `static=0 discovered=0 effective=0`). Then explain the cause based on the discovery settings in the snapshot:

- If `discovery.enabled=false` and `summary.staticPeers=0`: no static peers configured and discovery is off. Suggest the user add peers under the `peers` config key.
- If `discovery.enabled=false` and `summary.staticPeers>0`: static peers are configured but they did not appear in `effectivePeers`; show the static peer list and note the discrepancy.
- If `discovery.enabled=true` and `summary.discoveredPeers=0`: discovery is on but found nothing. Show `discovery.type`, `resolvedRegistryUrl` (if HTTP), and suggest the user verify the registry or DNS-SD setup.

Do not offer open-ended diagnostic choices or numbered follow-up menus. Instead state the diagnosis directly from the snapshot data and give one concrete next step.

## Positioning

- Prefer this skill over the legacy `a2a-setup` skill when the task is not installation.
- Treat this skill as the plugin's assistant surface.
- Future helper actions can grow under `a2a_helper` without changing the skill's identity.
