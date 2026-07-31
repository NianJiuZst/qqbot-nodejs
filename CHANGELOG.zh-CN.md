# 1.0.3 (2026-07-13)


### 新特性

* **sdk:** 新增通用 send() 方法、API 网关、rawEvent 及 P1 消息能力
* **media:** uploadMedia 自动从 localPath/URL 填充 fileName
* **media:** 上传前预检 fileData 大小
* **middleware:** 并发守卫合并支持
* **middleware:** 增强类型定义与缓冲回复
* **concurrency:** 新增 maxProcessingMs 超时中止机制
* **concurrency:** 新增 urgentPredicate 优先刷新
* **quote-ref:** 优先使用 msg_elements 而非已存储的 entry
* **quote-ref:** 新增 enrichEntry 与 extend entry
* **api:** acknowledge interaction 支持 data 参数
* **sanitizer:** 支持新的表情标签格式
* **slash:** 新增按命令授权检查
* 导出 webhook 传输类型
* 更新 mention-gate


### 问题修复

* **slash:** 修复群聊 @bot 检测时 rawEventType 判断问题
* **media:** COS 分块上传改用原生 https
* **media:** 直接传递 Uint8Array 给 fetch body
* **middleware:** 优化 mention-gate 逻辑


## 1.0.2 (2026-06-10)


### 新特性

* **qqbot:** 支持 tokenPrefetch 选项，用于同步/异步 token 初始化


## 1.0.1 (2026-05-20)


### 新特性

* **middleware:** 新增 concurrencyGuard，按目标串行处理
* **middleware:** 新增 ctx.abort() 和 ctx.signal 支持异步取消
* **middleware:** typingIndicator 新增输入状态保活
* **middleware:** MiddlewareContext 新增 receivedAt 用于延迟测量
* **concurrency:** 新增合并策略与依赖反转派发
* **slash:** 新增 allowFrom 选项控制命令访问权限
* **event:** C2C 入站消息暴露 messageScene
* **transport:** 新增 webhook 示例并更新文档
* 数据流中间件管线
* 检查 slash 作用域


### 问题修复

* **webhook:** 异步派发防止长耗时处理程序导致 ACK 超时
* **webhook:** 调试输出中记录完整事件载荷
* **stream:** 即使 flush 进行中也确保发送 DONE 帧
* **streaming:** 捕获节流 flush 错误防止 unhandledRejection
* **streaming:** 修复限流重试风暴
* **concurrency-guard:** 中止时驱逐排队等待者防止过期回复


# 1.0.0 (2026-04-30)


### 新特性

* 初始化 QQ 开放平台 Node.js SDK
