---
date: 2026-04-14
title: Fix Gateway Token Missing and Operator Scope Downgrade Issues
author: AI Assistant
---

# 修复 OpenClaw Gateway Token 缺失及 operator.write 权限丢失问题

## 问题现象

在针对 A2A 插件（OpenClaw Agent-to-Agent Gateway）的运行环境（尤其是沙箱及容器化环境）进行实测时，发现了两个阶段性的严重阻碍：

1. **Gateway Token 鉴权失败**：消息无法完整 dispatch，底层 OpenClaw 报错 `unauthorized: gateway token missing`。
2. **连接成功后权限丢失**：即便成功注入或配置了网关 token，在派发 Agent 任务时依然会在 RPC 层被拦截，报错缺少 `operator.write` 权限。

## 根因分析

经过对 `src/executor.ts` 的深入源码分析，确定了这是由于插件设计中缺乏必要的环境回退机制和格式兼容适配所导致的“连环坑”：

1. **Token 读取写死在 `api.config.gateway.auth.token`**：
   OpenClaw Plugin SDK 在运行时往往会将涉及高敏权限的 `api.config.gateway.auth.token` 剥离以作脱敏。而本插件代码仅从该路径读取 token 连接本机的 RPC 网关，且未对环境变量 (`OPENCLAW_GATEWAY_TOKEN`) 或 `gateway.remote.token` 进行回退兼容。这导致 A2A 网关无法认证宿主的 RPC 端点。

2. **设备身份 (Device Identity) 获取失败导致降级**：
   由于 OpenClaw ≥ 2026.3.13 版本实施了极强的设备校验以收拢权限：
   - 当沙箱内的 `~/.openclaw/identity/device.json` 文件路径错位、文件不存在、或其内部秘钥字段名出现版本更迭差异（如 `publicKey` 替代了 `publicKeyPem`）时，`getOrCreateDeviceIdentity()` 会因为无法正常加载预先配对好的本机设备特征，从而直接兜底生成一套**全新的临时且未经配对的、随机的密钥对**。
   - 当插件携带此临时并且在 OpenClaw 中未曾登记的签名发出伪装的 `cli` 请求时，OpenClaw 安全机制虽然放行了拥有合法 Token 的网络连接，但为了防止盗权，静态剥离了 `operator.write` 等敏感 Scope 权限。从而导致最终发起 Agent 调用时权限报缺。

## 修复内容 (Modified Files)

**`src/executor.ts`**

1. **增强了 `resolveGatewayRuntimeConfig` 方法 (约 第 1247 - 1262 行)**：
   - 增加对环境变量 `process.env.OPENCLAW_GATEWAY_TOKEN` 的读取作为第一优先级。
   - 增加对 `gateway.remote.token` 路径的回退读取。

2. **增强了 `getOrCreateDeviceIdentity` 方法的容错和兼容 (约 第 471 - 486 行)**：
   - 解析 `device.json` 时，增加了兼容较新的不带 `Pem` 后缀的秘钥字段定义：`publicKey(Pem)` 以及 `privateKey(Pem)` 进行并集判断取值。
   - 在由于缺少必填字段或 IO 读取失败从而 fallback 到生成临时随机秘钥之前，显式在控制台 (`console.warn`) 暴露出具体的错误原因以及文件路径，以使得未来排查问题时能第一眼在日志中定位到设备文件的问题。
