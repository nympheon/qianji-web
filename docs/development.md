# 本地开发

当前已完成协议、SQLite副本、持久操作队列、连接、增量同步与缓存/重建基础，尚未接入真实钱迹账号。空页面不会展示演示账单，健康检查只表示本服务运行。当前缓存与任务恢复规则见[数据新鲜度与恢复](cache-policy.md)。

## 工具链

使用Node 24及pnpm 11.25.0，所有直接依赖锁定确切版本并提交`pnpm-lock.yaml`。本机已有pnpm位于`C:/Users/USERNAME/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm.cmd`；可直接调用，无需修改全局PATH。

2026-10-18核对并锁定：React 19.3.1、Vite 8.3.4、TypeScript 7.0.2、Tailwind CSS 4.3.3、Wrangler 4.151.1、Cloudflare Vite plugin 1.64.0、Cloudflare Vitest plugin 1.4.4、Vitest 5.0.5。pnpm只允许esbuild与workerd所需安装脚本，不放开所有依赖脚本。shadcn在任务11加入。

## 命令

- `pnpm install --frozen-lockfile`：恢复锁定依赖。
- `pnpm dev`：本地Vite与workerd；没有云端部署副作用。
- `pnpm test -- tests/workers/smoke.test.ts`：实际workerd/SQLite边界测试。
- `pnpm typecheck`：先从Wrangler配置生成绑定/运行时类型，再严格检查。
- `pnpm build`：构建网页静态资源和Worker；Tailwind由Vite编译，不依赖CDN。
- `pnpm check:deploy`：检查构建生成的Worker配置，只dry-run。
- `pnpm verify`：类型、全部本地单元/Worker测试、构建与dry-run。

生成文件、`.dev.vars`、本地数据库、依赖仓库、执行台账和真实验收数据已忽略。不要将密码、密码摘要、token或个人账单原文提交。`.dev.vars.example`仅说明后续凭证加密Secret，当前没有真实值。

## 运行结构

一个固定名`personal`的SQLite Durable Object，绑定`QIANJI_STATE`；网页通过`ASSETS`发布。业务HTTP/MCP入口交给Worker，不使用页面fallback。不使用Cron、D1、后台保活或应用访问鉴权。

## 持久操作与恢复

连接前将32字节随机值的Base64编码保存到本地忽略文件`.dev.vars`的`QIANJI_CREDENTIAL_KEY`；生产环境使用Cloudflare Worker Secret。保留该Secret用于已有凭证解密，丢失或更换后需要重新登录。不要把钱迹密码或token填入环境文件。连接协议证据与未验证边界见[连接契约](protocol/454/connection.md)。

写键唯一范围为`(uid,requestId)`，摘要包含动作与规范化参数；确认结果保留逐项状态与ID映射。准备阶段可读取，实际发送前先提交发送标记。恢复时已发送或发送事实不确定的操作只核查，不根据账单状态生成待发送队列。原生账单ID冲突的有限重分配由后续领域任务单独实现，通用队列不自动重试。

所有在途任务共用`Jobs`与唯一alarm。新增任务先持久安排唤醒，再在同步事务中写入意图和job；初始化仅修复持久检查点与唤醒，不访问钱迹。中断的发送标记转为待核查，单次有限核查仍未知时移除job并保留操作，等待使用者主动核查。排队操作与连接变更共用进程内顺序器；SQLite中的操作状态负责跨重启的发送判断。本地读取和草稿不等待网络队列。

核查上下文的协议客户端只允许注册表明确标记为只读的操作，禁止登录、退出、上传等请求；新增协议路径默认不可用于核查。批次中已确认项目不会被后续未知回执降级或重发。

SQLite事务只含同步存储操作。[Cloudflare事务文档](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)明确`transactionSync`不能跨Promise；[输出门机制](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)会在存储写入确认前阻挡传出的fetch，代码没有使用`allowUnconfirmed`。

## 执行记录

用户选择主代理顺序开发并在完成后统一独立审查。本机原生worktree工具无法读取沙箱拥有的仓库，使用干净目录中的`feat/qianji-workers`独立分支；不并行运行代码实现者，不修改全局Git信任。POSIX技能脚本因本机缺Bash运行体无法执行，以`.superpowers/sdd/2026-10-18-qianji-development-plan/`中的同等任务brief、BASE、测试日志与条件完成台账记录进度。
