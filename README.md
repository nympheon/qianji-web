# 钱迹 Web / MCP on Cloudflare

单用户钱迹网页版及 Streamable HTTP MCP。手机号或邮箱密码登录；Worker Static Assets + 一个 SQLite Durable Object，无 D1、Cron、队列、R2 或应用账号系统。页面使用 React 19、Tailwind CSS 4、shadcn/Radix。

已实现账单查询/统计/日历、资产/借贷、账本/分类/标签/预算、图片、周期、分期、存钱、原操作跟踪及本地草稿。业务逻辑参考钱迹 APK 4.5.4/1234；支持范围及真实证据见 [验收矩阵](docs/acceptance/live-matrix.md) 与 [协议边界](docs/acceptance/protocol-gaps.md)。

**已完成提供范围内的原生业务补验，正式 Web/MCP 写入已统一启用。** 真实写测试只使用新建测试资源；接口已确认不支持或仍不明确的输入分支会在发送前拒绝，详见协议边界。本位币修改、全局排序和账本成员操作不提供。本次按用户要求仅交付代码、审查和部署文档，暂不部署；ChatGPT 尚未实际连接。

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm test:e2e
pnpm dev
```

使用 Node 24 和 pnpm 11。本地先复制 `.dev.vars.example` 为 `.dev.vars`，配置32字节随机值的 Base64 `QIANJI_CREDENTIAL_KEY`，再在 `/connection` 登录。不要把密码、token 或实际 Secret 提交到仓库。

- [部署与 ChatGPT 接入](docs/deployment.md)
- [升级、暂停、数据库恢复](docs/maintenance.md)
- [版本状态与验收](docs/release.md) / [独立审查及修复](docs/acceptance/final-review.md)
- [设计](docs/superpowers/specs/2026-10-18-qianji-workers-design.md) / [计划](docs/superpowers/plans/2026-10-18-qianji-development-plan.md)

普通使用超过来源校验窗口才按需增量更新，显式同步绕过60秒窗口但保留原游标和5秒冷却。闲置不轮询；未来计划由钱迹处理，网页预览不补造账单。未知写入保留原请求键，只读核查，禁止换键重试。
