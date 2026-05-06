#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://gitlab.chehejia.com/zhoumingzhu/openclaw-a2a-gateway.git"
INSTALL_DIR="${HOME}/.openclaw/workspace/plugins/a2a-gateway"
PLUGIN_ID="a2a-gateway"
EXTENSION_DIR="${HOME}/.openclaw/extensions/${PLUGIN_ID}"

echo "==> A2A Gateway (Extended) Installer"
echo "    Repo : ${REPO_URL}"
echo "    Path : ${INSTALL_DIR}"
echo "    Extension : ${EXTENSION_DIR}"
[ -n "${REGISTRY_URL:-}" ] && echo "    Registry : ${REGISTRY_URL}"
echo ""

# 1. 检查 openclaw
if ! command -v openclaw &>/dev/null; then
  echo "[ERROR] openclaw CLI not found. Please install OpenClaw first."
  exit 1
fi

# 2. Clone 或更新仓库
mkdir -p "$(dirname "${INSTALL_DIR}")"
if [ -d "${INSTALL_DIR}/.git" ]; then
  echo "==> Updating existing clone..."
  git -C "${INSTALL_DIR}" remote set-url origin "${REPO_URL}"
  git -C "${INSTALL_DIR}" pull --ff-only
else
  echo "==> Cloning repository..."
  git clone --branch develop "${REPO_URL}" "${INSTALL_DIR}"
fi

# 3. 安装生产依赖
echo "==> Installing production dependencies..."
npm install --production --prefix "${INSTALL_DIR}"

# 4. 注册插件
echo "==> Registering plugin with OpenClaw..."
if [ -d "${EXTENSION_DIR}" ]; then
  echo "==> Existing installed plugin detected at ${EXTENSION_DIR}"
  if openclaw plugins uninstall "${PLUGIN_ID}"; then
    echo "    Existing plugin uninstall requested via OpenClaw CLI."
  else
    echo "    OpenClaw uninstall failed or is unsupported."
  fi

  if [ -e "${EXTENSION_DIR}" ]; then
    echo "    Extension directory still exists after uninstall. Removing it directly..."
    rm -rf "${EXTENSION_DIR}"
  fi
fi
openclaw plugins install "${INSTALL_DIR}"

# 5. 配置注册中心主机地址（若提供了 REGISTRY_URL）
if [ -n "${REGISTRY_URL:-}" ]; then
  echo "==> Configuring HTTP discovery registry..."
  openclaw config set plugins.entries.a2a-gateway.config.discovery.enabled true
  openclaw config set plugins.entries.a2a-gateway.config.discovery.type '"http"'
  openclaw config set plugins.entries.a2a-gateway.config.discovery.httpRegistryUrl "\"${REGISTRY_URL}\""
  echo "    Registry host/base URL configured: ${REGISTRY_URL}"
fi
