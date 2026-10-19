# 部署与 ChatGPT 接入

当前状态（2026-10-19）：已部署到 [qianji.example.com](https://qianji.example.com)，Worker 名称 `qianji-personal`，使用 Workers Free。正式业务写入已在代码中统一启用。网页、API 和 MCP 沿用账号现有 `*.example.com` Cloudflare Access 保护；匿名请求已验证会进入登录流程。MCP 的 OAuth 配置及 ChatGPT 实接测试按用户要求稍后进行。

## 资源与套餐

一个 Worker 提供静态页面、`/api/*` 和 `/mcp`；`QIANJI_STATE` 是 `QianjiState` SQLite Durable Object，固定使用对象名 `personal`。数据库内存储来源副本、游标、草稿、操作与加密凭证。无需另建D1数据库或配置定时任务。

当前先使用 Workers Free 和 SQLite DO 免费额度，保留完整 SDK、统计与恢复逻辑；实际额度不足时再评估升级。同一 Worker 和 SQLite 命名空间可以继续使用，无需为升级套餐迁移数据库。Paid 当前为每月5美元基础订阅，超额另计；SQLite DO另有计算/行读写/存储计量。使用量以账号账单为准。[Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/)、[Durable Objects 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)。

Paid 下 DO默认每次调用30秒CPU、单对象最高10GB；网络等待不能当作CPU测量。本项目已测的是本地 wall time/SQL行数，真实Cloudflare CPU与费用待部署观察。[DO限制](https://developers.cloudflare.com/durable-objects/platform/limits/)。不会自动开通或购买套餐。

## 首次部署

1. 明确目标 Cloudflare 账号、Worker 名称与 workers.dev/自定义域名，并按用户选择配置外部保护。
2. `pnpm install --frozen-lockfile`，然后 `pnpm verify`。
3. `pnpm exec wrangler login`、`pnpm exec wrangler whoami`，确认显示的账号就是目标账号。
4. 已获得部署授权后执行 `pnpm exec wrangler deploy --config dist/worker/wrangler.json`。SQLite命名空间由首个 `new_sqlite_classes` 迁移创建，不手工绑定其他实例。
5. 配置 `QIANJI_CREDENTIAL_KEY` Secret：`pnpm exec wrangler secret put QIANJI_CREDENTIAL_KEY --name qianji-personal`。值必须为新生成32字节随机值的Base64；在本机或Dashboard输入，不发到聊天。预览使用独立Secret。
6. 打开实际HTTPS入口的 `/connection`，输入手机号/邮箱及密码，检查登录状态和所选线路，执行首次同步。密码和可重放摘要不会入库。

本次生产密钥已独立生成并配置，更新时应保留，不要重新生成覆盖。当前配置关闭 `workers_dev` 和 `preview_urls`，仅绑定选定自定义域名；预览环境显式使用空 `routes`，防止继承生产域名。复用仓库部署到其他账号时，先调整 `name` 和 `routes`，并确认新域名已有所需的外部保护。

不要从本地复制 `.dev.vars`、`.wrangler` 或验收SQLite文件到生产。预览环境 `qianji-personal-preview` 的 DO绑定没有 `script_name` 指向生产，命名空间及Secret均独立。使用 Cloudflare Vite 的 `CLOUDFLARE_ENV=preview` 构建预览，并检查生成的 `dist/worker/wrangler.json` 中名称确为预览后再部署；随后重新构建默认生产版本。正式部署始终以实际生成配置为准。

不要构建或部署 `tools/acceptance`；该入口已限制为本机 dev。`tools/ops` 是临时受控运维代理，不属于正式服务。

## 连接 ChatGPT

服务地址为 `https://实际域名/mcp`，支持无会话 Streamable HTTP及JSON/SSE响应。ChatGPT无法访问本机127.0.0.1地址。

当前 `/mcp` 仍受原有浏览器 Access 登录保护，尚未配置 MCP 客户端的 OAuth，因此不能把该地址作为无认证服务直接接入 ChatGPT。后续可由 Cloudflare 托管 OAuth 并复用现有访问策略；该配置和真实客户端测试本次按用户要求暂缓。MCP请求需要直接取得协议响应，不能被转换为网页登录或验证码。[Cloudflare Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)、[ChatGPT 连接说明](https://developers.openai.com/plugins/deploy/connect-chatgpt)。账号入口可用性以实际界面为准。

先用MCP Inspector的Streamable HTTP模式检查初始化和工具目录，再在ChatGPT验证连接状态、测试账本查询与统计；写入只使用已授权测试资源，并保留返回的原 `operationId`。超过响应窗口时跟踪同一任务/原操作，不换requestId重建。官方也要求对实际工具、无效输入和边界场景逐一评估。[MCP构建与测试](https://developers.openai.com/plugins/build/mcp-server)。

本服务不需要 OpenAI API Key。草稿内部工具不暴露给MCP；图片上传结果中的网页链接会转成当前入口的绝对地址。

## 发布后验证

记录实际URL、提交版本、Secret配置完成状态及生产DO名称。检查网页、三线路、首次和增量同步、MCP初始化/调用、未知原操作跟踪。最后等在途任务结束，实际观察至少10分钟的钱迹请求计数不增长；本地观测不能替代生产观测。查看Workers/DO用量、CPU与错误，再据实际数据调整CPU上限。M4只有在生产及ChatGPT实际通过后才算交付。
