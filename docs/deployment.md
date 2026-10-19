# 部署与 ChatGPT 接入

本仓库提供单用户部署模板，不发布个人域名、Cloudflare 账号/资源标识、密钥或具体部署实例状态。正式业务写入已在代码中统一启用；能否在某个环境实际调用，应按该环境独立验收。以下域名和 Worker 名称均为示例。

## 资源与套餐

一个 Worker 提供静态页面、`/api/*` 和 `/mcp`；`QIANJI_STATE` 是 `QianjiState` SQLite Durable Object，固定使用对象名 `personal`。数据库内存储来源副本、游标、草稿、操作与加密凭证。无需另建D1数据库或配置定时任务。

当前先使用 Workers Free 和 SQLite DO 免费额度，保留完整 SDK、统计与恢复逻辑；实际额度不足时再评估升级。同一 Worker 和 SQLite 命名空间可以继续使用，无需为升级套餐迁移数据库。Paid 当前为每月5美元基础订阅，超额另计；SQLite DO另有计算/行读写/存储计量。使用量以账号账单为准。[Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/)、[Durable Objects 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)。

Paid 下 DO默认每次调用30秒CPU、单对象最高10GB；网络等待不能当作CPU测量。本项目已测的是本地 wall time/SQL行数，真实Cloudflare CPU与费用待部署观察。[DO限制](https://developers.cloudflare.com/durable-objects/platform/limits/)。不会自动开通或购买套餐。

## 首次部署

1. 明确目标 Cloudflare 账号、Worker 名称与自定义域名，并按用户选择配置外部保护。复制 `wrangler.jsonc` 为被 Git 忽略的 `wrangler.local.jsonc`，仅在私有副本中填写真实名称、路由和目标配置。
2. `pnpm install --frozen-lockfile`，再设置 `QIANJI_WRANGLER_CONFIG=wrangler.local.jsonc` 后运行 `pnpm verify`。设置方式见[私有配置](public-repository.md)；Vite 会使用该文件生成实际部署配置。
3. `pnpm exec wrangler login`、`pnpm exec wrangler whoami`，确认显示的账号就是目标账号。
4. 已获得部署授权后执行 `pnpm exec wrangler deploy --config dist/worker/wrangler.json`。SQLite命名空间由首个 `new_sqlite_classes` 迁移创建，不手工绑定其他实例。
5. 配置 `QIANJI_CREDENTIAL_KEY` Secret：`pnpm exec wrangler secret put QIANJI_CREDENTIAL_KEY --name qianji-personal`。值必须为新生成32字节随机值的Base64；在本机或Dashboard输入，不发到聊天。预览使用独立Secret。
6. 打开实际HTTPS入口的 `/connection`，输入手机号/邮箱及密码，检查登录状态和所选线路，执行首次同步。密码和可重放摘要不会入库。

已有生产实例更新时保留原加密 Secret，不要重新生成覆盖。公开模板的 `routes` 为空，`workers_dev` 和 `preview_urls` 均关闭；实际路由仅填写在私有配置。预览环境显式使用空 `routes`，防止继承生产域名。部署到其他账号时，在自己的私有配置中调整 `name` 和 `routes`，并确认新域名已有所需的外部保护。

不要从本地复制 `.dev.vars`、`.wrangler` 或验收SQLite文件到生产。预览环境 `qianji-personal-preview` 的 DO绑定没有 `script_name` 指向生产，命名空间及Secret均独立。使用 Cloudflare Vite 的 `CLOUDFLARE_ENV=preview` 构建预览，并检查生成的 `dist/worker/wrangler.json` 中名称确为预览后再部署；随后重新构建默认生产版本。正式部署始终以实际生成配置为准。

不要构建或部署 `tools/acceptance`；该入口已限制为本机 dev。`tools/ops` 是临时受控运维代理，不属于正式服务。

## 连接 ChatGPT

服务地址为 `https://实际域名/mcp`，支持无会话 Streamable HTTP及JSON/SSE响应。ChatGPT无法访问本机127.0.0.1地址。

推荐用 Cloudflare MCP 门户作为客户端入口，例如 `https://mcp.example.com/mcp`。源站 `/mcp` 单独建立只允许专用服务令牌的 Service Auth 应用；在 Cloudflare MCP 服务器配置中使用 `CF-Access-Client-Id` 与 `CF-Access-Client-Secret` 自定义标头，值只保存在 Cloudflare。MCP 服务器和门户分别关联允许本人访问的策略，门户启用托管 OAuth；需要 Gateway 路由时，在门户开启“通过 Cloudflare Gateway 路由流量”。这些控制台资源不随 Wrangler 配置自动创建。[Cloudflare 门户与 Gateway](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/)

客户端只登录门户，不接收上游服务令牌。ChatGPT 回调应核对其管理页给出的 URI；官方说明包含稳定回调 `https://chatgpt.com/connector_platform_oauth_redirect` 和带连接 ID 的 `https://chatgpt.com/connector/oauth/{callback_id}`。仅允许实际所需回调，不放行任意 HTTPS 地址。[OpenAI 认证说明](https://developers.openai.com/plugins/build/auth#redirect-url)

先检查标准 MCP 初始化是否返回带发现地址的 OAuth 401、资源/授权元数据是否可访问，再完成客户端授权、列工具及只读调用；匿名源站应拒绝访问。发现文档、控制台“就绪”及 Gateway 开关并不能替代端到端业务验收。[Cloudflare Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)

先用MCP Inspector的Streamable HTTP模式检查初始化和工具目录，再在ChatGPT验证连接状态、测试账本查询与统计；写入只使用已授权测试资源，并保留返回的原 `operationId`。超过响应窗口时跟踪同一任务/原操作，不换requestId重建。官方也要求对实际工具、无效输入和边界场景逐一评估。[MCP构建与测试](https://developers.openai.com/plugins/build/mcp-server)。

本服务不需要 OpenAI API Key。草稿内部工具不暴露给MCP；图片上传结果中的网页链接会转成当前入口的绝对地址。

## 发布后验证

记录实际URL、提交版本、Secret配置完成状态及生产DO名称。检查网页、三线路、首次和增量同步、MCP初始化/调用、未知原操作跟踪。最后等在途任务结束，实际观察至少10分钟的钱迹请求计数不增长；本地观测不能替代生产观测。查看Workers/DO用量、CPU与错误，再据实际数据调整CPU上限。M4只有在生产及ChatGPT实际通过后才算交付。
