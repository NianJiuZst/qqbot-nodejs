# Webhook 传输模式示例

演示如何使用 HTTP 回调（Webhook）替代 WebSocket 接收 QQ 机器人消息。

## 与 WebSocket 模式的区别

| 特性 | WebSocket | Webhook |
|------|-----------|---------|
| 连接方式 | SDK 主动连接 QQ 网关 | QQ 平台 POST 到你的 HTTP 端口 |
| 适用场景 | 长驻进程、开发调试 | Serverless、水平扩展、已有 HTTP 服务 |
| 需要公网 IP | 否（出站连接） | 是（入站 HTTP POST） |
| 签名验证 | 平台内置 | SDK 自动 Ed25519 验证 |
| 会话恢复 | 支持 RESUME | 无状态，无需恢复 |

## 代码差异

只需将 `transport` 设为 `"webhook"` 并配置端口/路径，其余 API（中间件、事件监听、消息发送）完全一致：

```diff
 const bot = new QQBot({
   appId,
   appSecret,
+  transport: "webhook",
+  webhook: { port: 8080, path: "/callback" },
 });
```

## 快速开始

```bash
export QQBOT_APP_ID="你的 AppID"
export QQBOT_APP_SECRET="你的 AppSecret"
pnpm example:webhook
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `QQBOT_APP_ID` | - | **必填** AppID |
| `QQBOT_APP_SECRET` | - | **必填** AppSecret |
| `QQBOT_WEBHOOK_PORT` | `8080` | 监听端口 |
| `QQBOT_WEBHOOK_PATH` | `/callback` | 监听路径 |
| `QQBOT_MARKDOWN` | `1` | 设为 `0` 关闭 markdown |
| `QQBOT_DEBUG` | - | 设为 `1` 启用 debug 日志 |

## 平台配置

1. 登录 [QQ 开放平台](https://q.qq.com) → 开发设置 → 消息接收方式
2. 选择 **HTTP 回调**
3. 填写回调 URL：`https://your-domain.com/callback`
4. 平台发送验证请求（op:13），SDK 自动处理签名验证

> **提示**：本地开发时可通过 ngrok / frp 等工具暴露本地端口。

## 自定义 HTTP 服务适配

SDK 默认使用内置 `node:http` 服务。如果你已有 Express/Fastify/Koa 服务，可以实现 `WebhookServerAdapter` 接口：

```ts
import { QQBot, type WebhookServerAdapter } from "@tencent-connect/qqbot-nodejs";

class MyExpressAdapter implements WebhookServerAdapter {
  async listen(port, path, handler) { /* ... */ }
  close() { /* ... */ }
}

const bot = new QQBot({
  appId, appSecret,
  transport: "webhook",
  webhook: {
    port: 8080,
    path: "/callback",
    server: new MyExpressAdapter(),
  },
});
```
