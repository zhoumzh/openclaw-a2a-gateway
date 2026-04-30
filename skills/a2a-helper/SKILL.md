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

- If `discoveredPeers` contains a peer and `effectivePeers` contains it with `source=discovered`, HTTP discovery is active and that peer is usable at runtime.
- If a peer appears in `collisions`, static config wins for that name.
- If `mergeWithStatic` is `false`, `effectivePeers` should be discovery-only.
- If `resolvedRegistryUrl` is empty in HTTP mode, inspect `/workspace/.a2a` and `WHOAMI`.

## Positioning

- Prefer this skill over the legacy `a2a-setup` skill when the task is not installation.
- Treat this skill as the plugin's assistant surface.
- Future helper actions can grow under `a2a_helper` without changing the skill's identity.
