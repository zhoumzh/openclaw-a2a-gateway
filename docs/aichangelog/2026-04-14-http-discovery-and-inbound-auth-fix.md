---
date: 2026-04-14
title: HTTP Registry Discovery and Inbound Auth Fail-Open Fix
author: AI Assistant
---

# 引入 HTTP 注册中心拉取机制并修复入站鉴权裸奔漏洞

## 背景与需求

1. **云原生沙箱网络隔离**：OpenClaw A2A Gateway 默认的 `mDNS` 组播发现在类似阿里云 E2B 沙箱、Kubernetes 容器等环境中因物理/层级网络隔离而失效。为了支持这类环境，我们需要使其能够从外部的统一注册中心拉取（HTTP Discovery）节点信息。控制面/管理面会负责注册动作以及分发带有 Agent Card 的节点，网关仅需作为纯消费者持续拉取和建表。
2. **鉴权漏配的灾难性兜底**：在之前的鉴权校验层代码中存在严重的安全缺陷。配置为 Bearer 鉴权后，如果用户由于失误在配置文件里漏配了有效的安全 Token（如 `validTokens.size === 0`），代码的逻辑判断会导致直接绕过鉴权，发生 Fail Open（全面放行裸奔）。

## 改造内容 (Modified Files)

### 1. `src/types.ts` & `src/dns-discovery.ts` (核心机制抽象与扩展)
- 提取并梳理出了通用的发现管理器接口 `IDiscoveryManager`。
- 对配置结构 `DnsDiscoveryConfig` 进行扩展，新增 `type?: "dns" | "http"` 以及访问注册中心专用的环境变量 `httpRegistryUrl` 和 `httpRegistryToken`。配置做了向下兼容。

### 2. `src/http-discovery.ts` (基于 HTTP 的新型发现驱动实现)
- 新增 `HttpDiscoveryManager` 模块以完全替代传统的 mDNS 发送逻辑。
- 通过内部定时任务（默认 30s），轮询 `httpRegistryUrl` 拉取存活并解析为数组。
- **智能 Name 提取 (Fallback)**：优先读取控制面在 JSON 字段里下发的直接别名（`name`），这避免了本地网关还需逐一触发二次请求去查 `agent-card.json` 提取名称的网络损耗；如果在 JSON 中没找到显式 `name`，模块也极具鲁棒性地会截取沙箱的顶级 Hostname 作为 fallback 别名填补路由表。

### 3. `src/quorum-discovery.ts` (防抖退避逻辑解耦)
- 将此前的静态依赖（`DnsDiscoveryManager`）上浮为针对抽象接口（`IDiscoveryManager`）的依赖注入。
- 从此 HTTP 请求机制也能透明获得生物防抖算法的群落感应退避加成，在面对庞大沙箱集群时也能保护控制面免遭 DDoS 轮询压垮。

### 4. `index.ts` (入站安全兜底 & 网络引擎接管)

**漏洞修补 (Fail Closed 兜底)：**
彻底清理并改写了基础 RPC `userBuilder` 交互、`metricsAuth` 监控接口以及 Webhook 推送的防线：
- 当开启系统级别的鉴权 (`inboundAuth === "bearer"`) 但却实际上因配置问题没有注入可用凭证时，拦截动作将极其强硬，系统不再默默绕过，而是直接切断该 TCP 连接并响应 `Unauthorized: gateway token missing`。实现从 Fail Open 到 Fail Closed 的正向防御闭环。

**发现引擎动态挂载：**
- 修改了网关层对于 Manager 的挂载树，根据用户指定的 `discovery.type` 按需激活 HTTP 拉取组件还是原有的组播查找组件。

## 结论
目前系统完成了单边（Pull/Discovery 端）的云原生网络升级，并和控制面（管理面负责 Push/注册，通过下发 `agent-card.json` 内容）无缝对接。同时，补齐了入站网络层面缺乏配置引发静默全开的高危隐患。
