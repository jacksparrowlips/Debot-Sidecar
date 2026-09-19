#!/bin/bash
# 双击启动 DeBot Sidecar（重启语义：旧实例在跑则先停止再启动；Ctrl+C 或关闭本窗口即停止）
cd "$(dirname "$0")" || exit 1
# 重启：8787 被旧服务占用则先结束（端口取默认值，改配置端口后需同步改这里）
OLD_PID="$(lsof -ti :8787 || true)"
if [ -n "$OLD_PID" ]; then
  echo "── 检测到旧服务进程（PID $OLD_PID），正在停止… ──"
  kill $OLD_PID 2>/dev/null || true
  sleep 1
  kill -9 $OLD_PID 2>/dev/null || true
fi
echo "── DeBot Sidecar 启动中…服务地址 http://127.0.0.1:8787 ──"
exec pnpm dev:server
