# 公开仓库与私有部署配置

公开内容只保存通用代码、协议研究结论、脱敏回归样本和演示图。不提交个人域名、邮箱/手机号、本机用户名、真实私网地址、Cloudflare 账号/资源标识、真实密码/令牌、数据库或原始验收回执。测试中的虚构账号与官方钱迹/图片服务主机属于协议与回归输入，不能误删为部署资料。

## 私有配置

默认 `wrangler.jsonc` 不包含公共路由，且关闭 `workers.dev` 与版本预览入口。复制为 `wrangler.local.jsonc` 后，再在副本中填写自己的 Worker 名称和真实域名路由；该文件被 Git 忽略。

```sh
cp wrangler.jsonc wrangler.local.jsonc
```

构建时用 `QIANJI_WRANGLER_CONFIG` 选择私有文件。PowerShell：

```powershell
$env:QIANJI_WRANGLER_CONFIG = 'wrangler.local.jsonc'
pnpm verify
pnpm exec wrangler deploy --config dist/worker/wrangler.json
Remove-Item Env:QIANJI_WRANGLER_CONFIG
```

POSIX Shell：

```sh
QIANJI_WRANGLER_CONFIG=wrangler.local.jsonc pnpm verify
pnpm exec wrangler deploy --config dist/worker/wrangler.json
```

`verify` 只执行测试、构建和 dry-run；最后一条 `deploy` 才会发布。部署前确认生成文件对应期望的账号、Worker、路由及环境。已有实例必须沿用原 DO 绑定、类名、对象名和加密 Secret；本地配置不包含 Secret 的实际值。另一个电脑需自行取得私有配置或重新从自己的 Cloudflare 控制台填写，Git 克隆不会恢复它。

`.dev.vars`、`.wrangler/`、`.artifacts/`、`.superpowers/` 及私人验收资料均不进入仓库。生成的部署配置和日志也可能包含真实地址，不要解除这些目录的忽略规则或使用 `git add -f` 上传它们。

## 历史与协作

历史脱敏会更换提交 ID。协作者应重新克隆清理后的仓库，不要把旧分支、标签、reflog、bundle、备份或克隆直接合并推回，以免重新引入旧数据。历史文档中不再保留指向已移除提交的原始 ID；请按源码路径、方法定位和回归用例查证。

Git 历史重写只能清理可控分支和本地对象，不能收回其他人已取得的克隆、外部缓存或截图。GitHub 的旧 SHA 缓存/服务端对象需要平台按其规则处理，不能仅凭强制推送保证永久擦除。若实际凭据曾公开，应另行轮换；不要把假定缓存已删除作为凭据仍安全的依据。

APK 逻辑结论与脱敏样本位于 `docs/protocol/454/`、`docs/research/` 和 `fixtures/apk-454/`。原始 APK、完整反编译工作区、工具会话与聊天全文不随 Git 迁移；需要深入检查原生实现时，应重新取得对应版本及分析环境。
