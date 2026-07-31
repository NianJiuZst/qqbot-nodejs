# QQ Bot Playground

一个最小可用的 QQ 机器人示例，演示 `@tencent-connect/qqbot-nodejs` 的核心能力。

## 准备

1. 在 [QQ 开放平台](https://q.qq.com/) 创建一个机器人，记下 `AppID` 和 `AppSecret`。
2. 把机器人添加到测试群或者用 QQ 客户端「添加好友」加为私聊机器人。

## 运行

```bash
export QQBOT_APP_ID="你的 AppID"
export QQBOT_APP_SECRET="你的 AppSecret"

# 在仓库根目录
pnpm playground
```

## 演示能力

- **文本消息收发**：私聊或群里 @ 机器人发任意文本。
- **流式输出（mock 2 字/秒）**：默认开启，私聊里发任何文本，机器人会以
  「2 字/秒」的速率把文字逐字回放给你。这是 QQ 开放平台 C2C
  `stream_messages` API 的真实流式效果，演示用 mock 节流模拟「LLM 生成
  速度」。
- **文件 / 图片 / 语音 收发**：发送文件类附件，机器人会下载并回传。
- **命令切换**：在私聊里发送 `/help` 查看所有命令。

## 内置命令

| 命令         | 说明                                                |
| ------------ | --------------------------------------------------- |
| `/help`      | 显示帮助                                            |
| `/mode`      | 查看当前模式                                        |
| `/echo`      | 切到「简单回声」                                    |
| `/stream`    | 切到「流式回放（2 字/秒）」（默认）                 |
| `/slow N`    | 切到「流式 N 字/秒」                                |
| `/md`        | 发一条 Markdown 测试                                |
| `/file <url>` | 主动给当前会话发一张图片（来自 URL，需平台白名单） |
| `/info`      | 显示机器人状态                                      |

## 注意事项

- **QQ 流式仅 C2C**：群聊发消息走普通文本通道，无法流式。
- **Markdown 权限**：默认关闭。如果你的 bot 已开通模板 markdown 权限，可以
  设置 `QQBOT_MARKDOWN=1` 启用。
- **QQ upload-by-url 白名单**：通过 URL 上传图片/视频时 QQ 会校验 host
  白名单。如果回传失败，可以下载 buffer 再上传（生产代码里推荐这么做）。
