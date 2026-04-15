# A2A Gateway — 扩展功能文档

> 本文档记录在开源 `openclaw-a2a-gateway` 基础上进行的**二次开发扩展**，涵盖云原生沙箱环境下的 HTTP 注册中心发现、动态身份注入（灵魂注入）、鉴权加固以及沙箱兼容性修复。
>
> 上游原始文档请参阅 [README_CN.md](./README_CN.md)。

---

## 目录

1. [安装](#1-安装)
2. [HTTP 注册中心发现](#2-http-注册中心发现)
3. [灵魂注入：AgentCard 动态热重载](#3-灵魂注入agentcard-动态热重载)
4. [入站鉴权 Fail-Closed 加固](#4-入站鉴权-fail-closed-加固)
5. [沙箱环境兼容性修复](#5-沙箱环境兼容性修复)
6. [注册中心 JSON 格式规范](#6-注册中心-json-格式规范)
7. [故障排查](#7-故障排查)

---

## 1. 安装

### 一键安装（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/zhoumzh/openclaw-a2a-gateway/develop/install.sh | bash
```

安装时同步配置 HTTP 发现注册中心：

```bash
REGISTRY_URL="https://your-registry.example.com/agents" \
  curl -fsSL https://raw.githubusercontent.com/zhoumzh/openclaw-a2a-gateway/develop/install.sh | bash
```

### 安装逻辑

| 步骤 | 操作 |
|------|------|
| 1 | 检查 `openclaw` CLI 是否可用（不可用则退出） |
| 2 | Clone 仓库到 `~/.openclaw/workspace/plugins/a2a-gateway`；已存在时执行 `git pull` |
| 3 | `npm install --production` |
| 4 | `openclaw plugins install` 注册插件 |
| 5 | 若传入 `REGISTRY_URL` 则自动写入发现配置 |
| 6 | `openclaw gateway restart` |

脚本幂等，可重复执行。

### 安装后验证

```bash
openclaw plugins list
curl -s http://localhost:18800/.well-known/agent.json | python3 -m json.tool
```

---

## 2. HTTP 注册中心发现

### 背景

默认的 mDNS/DNS-SD 发现机制依赖 UDP 组播，在以下环境中会完全失效：

- 阿里云 E2B / Sandbox 沙箱
- Kubernetes Pod 网络（跨 Namespace）
- 任何禁止 UDP 广播的云 VPC

为此扩展了 **HTTP 注册中心拉取模式**：网关定期向中心化 HTTP 端点轮询节点列表，无需任何网络组播支持。

### 配置方法

```bash
# 1. 开启发现，切换为 HTTP 模式
openclaw config set plugins.entries.a2a-gateway.config.discovery.enabled true
openclaw config set plugins.entries.a2a-gateway.config.discovery.type '"http"'

# 2. 注册中心地址（必填，需返回符合规范的 JSON 数组，见第 5 节）
openclaw config set plugins.entries.a2a-gateway.config.discovery.httpRegistryUrl '"https://your-registry.example.com/agents"'

# 3. 注册中心 Bearer Token（可选）
openclaw config set plugins.entries.a2a-gateway.config.discovery.httpRegistryToken '"your-registry-token"'

# 4. 轮询间隔，单位毫秒，默认 30000
openclaw config set plugins.entries.a2a-gateway.config.discovery.refreshIntervalMs 30000
```

或直接写入插件配置文件：

```json
{
  "discovery": {
    "enabled": true,
    "type": "http",
    "httpRegistryUrl": "https://your-registry.example.com/agents",
    "httpRegistryToken": "optional-bearer-token",
    "refreshIntervalMs": 30000,
    "mergeWithStatic": true
  }
}
```

`mergeWithStatic: true`（默认）时，通过 HTTP 发现的节点与 `peers` 中静态配置的节点合并，静态配置优先级更高（同名时静态节点覆盖发现节点）。

### 工作原理

```
每隔 refreshIntervalMs
    ↓
GET httpRegistryUrl  →  JSON 数组
    ↓
解析每个节点的 agentCardUrl / name / auth
    ↓
更新内存中的 discoveredPeers 列表
    ↓
（同时检查 WHOAMI 匹配 → 触发灵魂注入，见第 2 节）
```

---

## 3. 灵魂注入：AgentCard 动态热重载

### 背景

在多租户或控制面统一调度的场景下，网关启动时可能尚不知道自己的"身份"（名称、描述、技能列表）。控制面会在注册中心为每个沙箱分配身份信息。灵魂注入机制让网关能够**自动认领**控制面下发的身份，并在运行时热更新，无需重启。

### 前置条件

HTTP 发现模式必须已启用（见第 1 节）。

### 步骤一：写入身份标识文件

在网关所在的沙箱中创建 `/workspace/.a2a` 文件，内容为 `KEY=VALUE` 格式：

```bash
echo "WHOAMI=my-agent-slug" > /workspace/.a2a
```

`WHOAMI` 的值必须与注册中心 JSON 中对应节点的 `id` 字段完全一致。

### 步骤二：注册中心返回带身份信息的节点

注册中心对应条目需包含 `name`、`description`、`skills` 字段（格式见第 5 节）：

```json
[
  {
    "id": "my-agent-slug",
    "name": "我的智能助手",
    "description": "专注于数据分析的 A2A 节点",
    "skills": [
      { "id": "data-analysis", "name": "数据分析", "description": "处理结构化数据" }
    ],
    "agentCardUrl": "http://sandbox-host:18800/a2a/jsonrpc"
  }
]
```

### 触发时机

每次 HTTP 轮询（默认每 30 秒）时，网关会：

1. 读取 `/workspace/.a2a` 中的 `WHOAMI` 值
2. 在拉取到的节点列表中寻找 `id` 匹配的条目
3. 与当前内存中的 AgentCard 进行深比对（序列化 JSON 比较）
4. 若有变化则执行热重载：
   - 重建内存态 AgentCard，`/.well-known/agent.json` 立即返回新身份
   - 将新身份持久化到 `~/.openclaw/agent-card-state.json`
   - 若启用了 mDNS 自广播，更新实例名并重启广播
   - 输出日志：`a2a-gateway: Soul successfully injected/updated from control plane — name="...", skills=N`

### 记忆恢复

网关每次**重启**时会优先读取 `~/.openclaw/agent-card-state.json`，以上次认领到的身份覆盖静态配置中的 `agentCard`，实现跨重启的身份记忆恢复。

```
网关启动
    ↓
读取 ~/.openclaw/agent-card-state.json
    ├── 存在且有效 → 使用持久化的身份（覆盖静态配置）
    └── 不存在 → 使用静态配置中的 agentCard
```

### 验证方式

```bash
# 检查当前网关的 AgentCard 是否已注入
curl http://localhost:18800/.well-known/agent.json | jq '.name'

# 查看持久化状态文件
cat ~/.openclaw/agent-card-state.json
```

---

## 4. 入站鉴权 Fail-Closed 加固

### 问题

原始代码存在 Fail-Open 漏洞：当配置了 `inboundAuth: "bearer"` 但未配置有效 token（`validTokens.size === 0`）时，鉴权逻辑会静默放行所有请求。

### 修复后行为

现在只要开启了 Bearer 鉴权，若 token 未配置，**所有入站请求一律拒绝**，返回：

```json
{ "error": "Unauthorized: gateway token missing" }
```

受影响的端点：
- `/a2a/jsonrpc`（JSON-RPC）
- `/a2a/rest`（REST）
- `/a2a/metrics`（Metrics，若设置了 `metricsAuth: "bearer"`）
- `/a2a/push/*`（Push 通知注册）
- gRPC 入站连接

**正确配置示例：**

```bash
openclaw config set plugins.entries.a2a-gateway.config.security.inboundAuth '"bearer"'
openclaw config set plugins.entries.a2a-gateway.config.security.token '"your-strong-token"'
```

---

## 5. 沙箱环境兼容性修复

### 5.1 Gateway Token 多路径回退

在 E2B 等沙箱中，OpenClaw Plugin SDK 会在运行时脱敏 `api.config.gateway.auth.token`，导致插件无法读取到合法 token 从而无法连接本机 RPC 网关。

**现已支持以下优先级顺序读取 token：**

| 优先级 | 来源 |
|--------|------|
| 1（最高）| 环境变量 `OPENCLAW_GATEWAY_TOKEN` |
| 2 | 配置路径 `gateway.remote.token` |
| 3 | 配置路径 `gateway.auth.token`（原始路径） |

**推荐配置方式（沙箱）：**

```bash
export OPENCLAW_GATEWAY_TOKEN="your-gateway-token"
```

### 5.2 设备身份兼容性

OpenClaw ≥ 2026.3.13 版本对 `~/.openclaw/identity/device.json` 的密钥字段名进行了变更（`publicKeyPem` → `publicKey`）。原始代码在字段名不匹配时会静默生成临时随机密钥对，导致 `operator.write` 权限被安全机制剥离。

**修复内容：**
- `device.json` 解析时同时兼容 `publicKey` / `publicKeyPem` 及 `privateKey` / `privateKeyPem` 两套字段名
- 回退到生成临时密钥前，在日志中输出具体的失败原因和文件路径，便于定位

**排查命令：**

```bash
# 确认 device.json 字段格式
cat ~/.openclaw/identity/device.json | jq 'keys'
```

---

## 6. 注册中心 JSON 格式规范

HTTP 注册中心端点需返回一个 JSON 数组，每个元素格式如下：

```typescript
interface RegistryEntry {
  // 节点唯一标识（用于 WHOAMI 灵魂注入匹配）
  id: string;

  // 节点显示名称（优先用于路由表，避免二次请求 agent-card.json）
  name?: string;

  // AgentCard 描述（灵魂注入时写入）
  description?: string;

  // 技能列表（字符串或对象均可）
  skills?: Array<string | { id?: string; name: string; description?: string }>;

  // 入站 RPC 地址（必填，缺失则该节点被跳过）
  agentCardUrl: string;

  // 传输协议，默认 "jsonrpc"
  protocol?: "jsonrpc" | "rest" | "grpc";

  // 节点鉴权信息（可选）
  auth?: {
    type: "bearer" | "apiKey";
    token: string;
  };
}
```

**最小示例：**

```json
[
  {
    "id": "agent-001",
    "name": "分析助手",
    "agentCardUrl": "http://10.0.0.1:18800/a2a/jsonrpc"
  }
]
```

**完整示例：**

```json
[
  {
    "id": "agent-001",
    "name": "分析助手",
    "description": "专注于结构化数据分析的智能体",
    "skills": [
      { "id": "sql-query", "name": "SQL 查询", "description": "执行只读数据库查询" },
      "report-generation"
    ],
    "agentCardUrl": "http://10.0.0.1:18800/a2a/jsonrpc",
    "protocol": "jsonrpc",
    "auth": {
      "type": "bearer",
      "token": "peer-access-token"
    }
  }
]
```

---

## 7. 故障排查

### 灵魂注入未触发

| 检查项 | 命令 |
|--------|------|
| `/workspace/.a2a` 是否存在 | `cat /workspace/.a2a` |
| `WHOAMI` 值是否与注册中心 `id` 完全一致 | 对比日志与注册中心数据 |
| HTTP 发现是否已启用 | `openclaw config get plugins.entries.a2a-gateway.config.discovery` |
| 网关日志中是否有 `http-discovery.refreshed` | 查看 OpenClaw 日志 |

### HTTP 发现拉不到节点

```bash
# 手动验证注册中心地址可达
curl -H "Authorization: Bearer your-token" https://your-registry.example.com/agents | jq '.[0]'
```

常见原因：
- `agentCardUrl` 缺失（该字段必填，缺失时节点被静默跳过）
- 注册中心返回非数组 JSON
- Bearer Token 未配置或已过期

### operator.write 权限被拒

```bash
# 检查设备文件字段名
cat ~/.openclaw/identity/device.json | jq 'keys'
# 应包含 publicKey 或 publicKeyPem

# 检查 token 是否通过环境变量注入
echo $OPENCLAW_GATEWAY_TOKEN
```

### 持久化身份未生效

```bash
# 检查状态文件
cat ~/.openclaw/agent-card-state.json

# 若需要清除记忆，强制重新认领
rm ~/.openclaw/agent-card-state.json
# 重启网关后等待下一次轮询
```
