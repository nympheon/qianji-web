# 本地开发

当前处于M0基础阶段，尚未接入真实钱迹账号。空页面不会展示演示账单，健康检查只表示本服务运行。

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

一个固定名`personal`的SQLite Durable Object，绑定`QIANJI_STATE`；网页通过`ASSETS`发布。业务HTTP/MCP入口交给Worker，不使用页面fallback。M0不做钱迹网络调用、Cron、D1、后台保活或应用访问鉴权。

## 执行记录

用户选择主代理顺序开发并在完成后统一独立审查。本机原生worktree工具无法读取沙箱拥有的仓库，使用干净目录中的`feat/qianji-workers`独立分支；不并行运行代码实现者，不修改全局Git信任。POSIX技能脚本因本机缺Bash运行体无法执行，以`.superpowers/sdd/2026-10-18-qianji-development-plan/`中的同等任务brief、BASE、测试日志与条件完成台账记录进度。
