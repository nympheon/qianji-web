# 升级、暂停与恢复

运维不是产品页面功能。公开HTTP及MCP没有SQL、恢复、暂停或代码执行入口。`operate` 仅经Cloudflare服务绑定RPC调用；临时运维代理由 `pnpm ops` 启动，要求明确账号/Worker，使用本次随机凭证，退出即停止。不把代理部署成公开Worker。

远端运维与真实PITR尚未执行，需先在已授权预览目标演练；当前仅本地维护/恢复约束测试和构建通过。Wrangler的DO绑定目前不支持 `remote:true` 本地代理模式，因此工具使用 `wrangler dev --remote`，绑定明确 `script_name`。[Cloudflare本地/远端开发](https://developers.cloudflare.com/workers/local-development/)。

## 正常升级

保持 Worker名称、`QianjiState` 类名、`personal` 对象名及原凭证加密Secret。正常重启不会换deviceId、UID或连接代次，不会主动全量同步；中断的发送只读核查。SQLite迁移0001–0007不可改写，后续结构只追加迁移。先检查旧代码能否读取新结构，不能仅凭代码回滚便假定数据库也兼容。

备份加密Secret的管理权限独立于数据库；PITR不会替你恢复Worker Secret。丢失或轮换Secret后，旧凭证可能无法解密，应恢复原Secret或通过网页重新登录，不能伪造有效连接。

配置 `keep_vars:true`，升级保留Dashboard环境中的维护闸门。**恢复批次 `QIANJI_RESTORE_ID` 应长期保留，下一次恢复再换新值，不在恢复后删除。** 数据库回滚到旧快照时，新批次与库内旧批次不同，必须先隔离旧排队记录。只恢复数据库内的暂停标记是不够的。

## 运维命令

先完成 `wrangler login`，每次明确同一账号ID和目标Worker：

```sh
pnpm ops status --account-id ACCOUNT_32_HEX --script qianji-personal-preview
pnpm ops pause --account-id ACCOUNT_32_HEX --script qianji-personal-preview
pnpm ops verify --account-id ACCOUNT_32_HEX --script qianji-personal-preview
pnpm ops resume --account-id ACCOUNT_32_HEX --script qianji-personal-preview --review-digest REVIEWED_SHA256
```

`pause` 等待本实例在途业务写入结束，再暂停新提交/排队执行及自动alarm。`verify` 先实际检查登录，再只读核查原未知操作，重建账单/标签，刷新账本、正常/隐藏资产、借贷四种列表、标签及各计划来源。历史回执验证使用回滚事务提取操作证明，不用历史记录覆盖新副本。

只有来源完整且晚于暂停、最近五分钟的核查摘要未变化，才能 `resume`。状态列出的未知操作仍保留；人工核对该清单后把本次摘要传入。摘要不能证明未知操作“从未发送”，重新开放不会把它们重新排队。未准备好的核查或Cloudflare外部暂停仍有效时，解除会明确拒绝。

工具回执保存于忽略的 `.artifacts/ops/`。不打印云端凭证或钱迹原始记录。恢复/重启请求响应丢失时，保持暂停并调用 `status` 核对，不能以重复业务写入试探结果。

## SQLite PITR

Cloudflare SQLite DO的PITR支持过去30天；`onNextSessionRestoreBookmark` 在下次实例重启时恢复，并返回恢复前的撤销书签。恢复会回滚SQL与KV状态，钱迹云端账单不会随之回滚。[SQLite/PITR官方API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)。

1. 在目标Worker的Cloudflare环境中设置 `QIANJI_MAINTENANCE=paused` 和新的唯一 `QIANJI_RESTORE_ID`（8–100位字母/数字/下划线/连字符）。确认生效后保持它们跨越整个恢复过程。
2. 取当前保护书签及目标时间书签，保存工具回执：

```sh
pnpm ops bookmark --account-id ACCOUNT_32_HEX --script qianji-personal-preview
pnpm ops bookmark --account-id ACCOUNT_32_HEX --script qianji-personal-preview --at 2026-10-19T00:00:00Z
pnpm ops restore --account-id ACCOUNT_32_HEX --script qianji-personal-preview --restore-id NEW_RESTORE_RUN --bookmark TARGET_BOOKMARK
pnpm ops restart --account-id ACCOUNT_32_HEX --script qianji-personal-preview --restore-id NEW_RESTORE_RUN
```

3. 保存 `restore` 的 `undoBookmark`。`restart` 可能因实例中止而没有正常HTTP响应；再次 `status` 确认实际阶段，不把请求发出当恢复成功。
4. 新实例在任何排队恢复之前把回滚出来的 queued/sending/verifying 操作改为未知，取消旧同步作业/闸门，使来源过期；不改原requestId，不重发。即便外部暂停之后误撤，库内恢复核查闸门仍阻止业务写入。
5. 执行 `verify`，检查实际钱迹状态及全部未知清单。需要重新登录时在网页完成。
6. 仅解除Cloudflare环境的 `QIANJI_MAINTENANCE` 暂停，保留本次 `QIANJI_RESTORE_ID`。再次核对状态及未变化的核查摘要，执行 `resume`；超过五分钟则重新verify。

恢复后长期未知、无原ID的旧排队意图无法靠金额或同名认领。服务不提供“忘掉并重发”或任意SQL改状态工具。若要撤销PITR，用新的恢复批次对已保存的 `undoBookmark` 走完整流程。
