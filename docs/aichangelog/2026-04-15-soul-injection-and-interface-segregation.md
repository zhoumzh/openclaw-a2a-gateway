---
date: 2026-04-15
title: Soul Injection (Dynamic AgentCard Hot-Reload) and HTTP Discovery Interface Segregation
author: AI Assistant
---

# 灵魂注入（AgentCard 动态热重载）与 HTTP Discovery 接口职责隔离

## 背景与需求

前序工作已实现了 HTTP 注册中心拉取机制（`HttpDiscoveryManager`），控制面可以将带有 Agent Card 信息的节点列表推送到注册中心。但网关自身的"身份"（`agentCard`）仍然是启动时从本地配置文件静态读取的，无法感知控制面的动态分配。

本次工作分为两个阶段：

1. **衔接阶段（前序 Agent）**：实现基于"拉模型"的灵魂注入——网关从注册中心拉取自身条目、热更新内存态 AgentCard 并持久化到磁盘，实现跨重启的"记忆恢复"。
2. **重构阶段（本次 Agent）**：前序实现将回调接口 `onSelfDiscovered` 混入了 DNS-SD 的共享接口，职责边界不清晰，并存在副作用式 config 注入。对此进行接口隔离，使架构更为干净。

---

## 阶段一：灵魂注入功能实现

### 机制设计

网关通过读取 `/workspace/.a2a` 文件中的 `WHOAMI=${slug}` 字段来获得自身在注册中心的唯一标识（取代原方案中从 `process.env.WHOAMI` 读取，沙箱进程隔离导致环境变量不可靠）。每次 `HttpDiscoveryManager` 轮询注册中心时，遍历节点列表检查是否存在 `item.id === whoami` 的匹配项。若匹配成功，则从该条目提取 `name`、`description`、`skills` 字段，组装为 `AgentCardConfig` 并通过 `onSelfDiscovered` 回调通知上层网关。

### `src/http-discovery.ts`（第 117-151 行）

- **第 117-123 行**：`discover()` 方法中新增从 `/workspace/.a2a` 安全读取 `WHOAMI` 的逻辑（`try/catch` 容错，文件缺失时静默跳过）。
- **第 134-151 行**：遍历注册中心条目时，若检测到 `item.id === whoami` 且上层注册了回调，将控制面下发的身份数据封装为标准 `AgentCardConfig` 并触发回调；`skills` 字段兼容字符串和对象两种格式。

### `index.ts`

**启动阶段记忆恢复（第 333-345 行）：**
- 解析完静态配置后，立即尝试从 `~/.openclaw/agent-card-state.json` 读取上次持久化的 AgentCard 状态。
- 若文件存在且 `name` 字段非空，以其覆盖静态配置中的 `agentCard`，实现跨重启的"记忆恢复"。

**`handleSelfDiscovered` 回调（第 409-441 行）：**
1. **第 411-413 行，深比对（Diff Check）**：将新旧 `name`/`description`/`skills` 序列化为 JSON 字符串进行比对，无实质变化则直接跳过，避免无意义的重建与 IO。
2. **第 415-418 行，内存热替换（步骤 1）**：更新 `config.agentCard` 中的各字段。
3. **第 420-421 行，内存热替换（步骤 2）**：调用 `buildAgentCard(config)` 重新构建 AgentCard 对象。
4. **第 423-424 行，内存热替换（步骤 3）**：通过 `(requestHandler as any).agentCard = agentCard` 替换 SDK 内部引用，使 `/.well-known/agent.json` 接口立即返回新身份。
5. **第 426-433 行，落盘持久化**：将最新 `AgentCardConfig` 序列化写入 `~/.openclaw/agent-card-state.json`，为下次重启提供记忆底座。
6. **第 437-440 行，mDNS 重广播**：更新 `config.advertise.instanceName` 与 `config.advertise.txt.name`，调用 `mdnsResponder?.restart()` 重新广播本机 mDNS 身份。

---

## 阶段二：HTTP Discovery 接口职责隔离

### 问题诊断

前序实现将 `onSelfDiscovered` 混入了两个 DNS-SD 专属的共享接口，引发以下问题：

- **语义污染**：DNS-SD 协议没有"自我认领"概念，`DnsDiscoveryManager` 完全不使用该字段，却背负其类型定义。
- **接口膨胀**：`IDiscoveryManager` 公共契约出现仅对 HTTP 实现有意义的属性，违反接口隔离原则（ISP）。
- **重复定义**：`onSelfDiscovered` 同时出现在 `src/types.ts`（第 93 行附近）和 `src/dns-discovery.ts`（第 57 行附近）的 `DnsDiscoveryConfig` 中，形成两份冗余定义。
- **副作用注入**：`index.ts` 通过直接赋值 `config.discovery.onSelfDiscovered = handleSelfDiscovered` 修改共享 config 对象来注入回调，属于不透明的副作用。

### 修复内容

**`src/types.ts`（第 74-93 行，`DnsDiscoveryConfig`）**
- 删除 `onSelfDiscovered` 字段，接口回归纯粹的发现配置描述。

**`src/dns-discovery.ts`**
- **第 35-42 行，`IDiscoveryManager`**：删除 `onSelfDiscovered` 可选属性，接口最小化。
- **第 44-58 行，`DnsDiscoveryConfig`**：删除 `onSelfDiscovered` 字段，与 `types.ts` 保持一致。

**`src/http-discovery.ts`**
- **第 11-14 行**：新增 `export interface HttpDiscoveryConfig extends DnsDiscoveryConfig`，`onSelfDiscovered` 回调仅在此处定义，职责归属清晰。
- **第 24 行**：`private readonly config` 类型由 `DnsDiscoveryConfig` 改为 `HttpDiscoveryConfig`。
- **第 30 行**：构造函数签名同步更新为 `HttpDiscoveryConfig`；原 `public readonly onSelfDiscovered` 冗余字段随之删除，直接通过 `this.config.onSelfDiscovered` 访问。

**`index.ts`**
- **第 30 行**：新增 `import type { HttpDiscoveryConfig } from "./src/http-discovery.js"`。
- **第 34 行**：将 `sanitizeInstanceName` 加入 `dns-responder` 导入列表。
- **第 443-448 行**：删除原副作用赋值 `config.discovery.onSelfDiscovered = handleSelfDiscovered`；改为构造 `HttpDiscoveryManager` 时内联组装：`const httpConfig: HttpDiscoveryConfig = { ...config.discovery, onSelfDiscovered: handleSelfDiscovered }`，回调注入从"共享对象污染"升级为"局部构造时传参"，无副作用，意图明确。

**`src/dns-responder.ts`**
- **第 155-159 行**：新增 `restart()` 方法（`stop()` + `start()` 组合），供上层在 AgentCard 名称变更后重新广播 mDNS 记录。

---

## 结论

至此，A2A Gateway 具备了完整的"灵魂注入"能力：

- **拉取感知**：利用 HTTP 注册中心轮询，通过 `/workspace/.a2a` 中的 `WHOAMI` 完成自我认领。
- **热重载**：内存态、磁盘持久化、mDNS 广播三路同步更新，重启不失忆。
- **架构干净**：`onSelfDiscovered` 职责收敛在 `HttpDiscoveryConfig`，DNS-SD 路径完全不受影响，`IDiscoveryManager` 接口回归最小化。
