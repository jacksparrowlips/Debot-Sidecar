#!/bin/bash
# 双击启动 DeBot Sidecar（Ctrl+C 或关闭本窗口即停止）
cd "$(dirname "$0")" || exit 1
echo "── DeBot Sidecar 启动中…服务地址 http://127.0.0.1:8787 ──"
exec pnpm dev:server
