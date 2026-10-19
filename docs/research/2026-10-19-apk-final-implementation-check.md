# APK 与最终实现核对

2026-10-19，钱迹 `com.mutangtech.qianji`，版本 **4.5.4 / 1234**。对最终业务实现 `sanitized-history` 再做原生逻辑核对。主实现者直接读取 APK；另一位未参与实现的审查者只读比较已取得的 Smali 与领域代码，没有读取凭证、私有数据库或调用真实写接口。本轮未确认新的业务 P0/P1/P2。此前最终整支审查的八项问题及修复见[审查记录](../acceptance/final-review.md)。

## 本轮核对结果

| 逻辑 | APK 证据与实现结论 | 代码和回归 |
| --- | --- | --- |
| 同步顺序与请求身份 | `Lch/c$c$a.invokeSuspend` 先标签、后账单；`Ldh/c.b` 固定本轮标签 lasttime、按页推进、成功才保存水位；`Lbl/c.d/e` 区分普通请求 utoken 与同步的 htoken=1/utoken。服务持久保存前置任务和分页状态，失败不提前推进游标 | `src/features/sync/{freshness,service,rebuild}.ts`；`sync-lifecycle`、`incremental-sync`、`cache-policy` 测试 |
| 统计、预算与历史币种 | `BillStatItem$Companion.fromBill` 按类型、标志及历史金额构造统计；父子预算按 `BudgetSetNew.__setup` 分组，父预算至少覆盖子额，总额避免重复累计。历史账单不用当前汇率重算；跨期退款/报销按原生关系及时间处理 | `src/features/ledger/statistics.ts`、`src/features/budget`；`statistics-read`、`budget`、`refund`、`reimbursement` 测试 |
| 借贷与关联账单 | `SubmitLoanViewImpl.z` 构造初始本金与资产；核对本金增减、利息、方向与删除影响。只按原生回执/只读关系证明成功，未知写不再次发送 | `src/features/debt`、`src/features/ledger/deletion.ts`；`debt`、`operations` 测试 |
| 资产与分期占额 | `AssetAccount.getInstallMoney/getMoneyWithInstalment`、`Lhc/c.f` 与普通资产差额提交一致；分期占额和手续费按配置计算，汇总包装不作为普通写入资产 | `src/features/assets/{summary,balance,deletion}.ts`；`assets` 测试 |
| 分期舍入 | `Installment.calculateAverageValue/calculateLeftValue`：中间除法保留10位；rnd/rndf 两位 HALF_UP，intf/intl 整数向下，其余两位向下；尾差为总额减平均额乘剩余期数。实现用十进制定点计算 | `src/features/installments/preview.ts`；`installments` 测试 |
| 提前还款 | `Lwf/n.j1` 的源币扣款含本金与费用；`W0` 的 money 是本金，fee 另传。此 APK 的 images 分支把 remark 放入 images，是已观察到的客户端缺陷；服务采用已真实回读成功的图片数组，不复制错误。支出/还款两角色均核对含费历史金额 | `src/features/installments/use-cases.ts`；`installments` 测试及真实 `installment-prepay-array` 用例 |
| 周期日期 | `Lzf/b.getNextRepeatTime` 分派日/周/月/年/工作日规则。月末、短月、闰年及间隔按原生规则；Worker 不后台补造未来账单，任务执行交由钱迹 | `src/features/repeat/preview.ts`；`repeat` 测试 |
| 分类及标签删除 | `dbhelper/m.changeBillCategory/deleteCategoryBills` 与 `Loi/i$c.onExecuteRequest` 表明账单迁移和分类删除可有不同结果；服务保留分项成功。标签完整分组来源与增量行来源独立，删除后的关系由官方同步核查 | `src/features/categories`、`src/features/tags`；`categories`、`tags`、`sync-lifecycle` 测试 |
| 图片移除 | `AddBillImagePresenter.removeImage` 取消本地上传任务并移除选择项，方法没有远端对象删除调用。不能以移除账单引用承诺永久删除钱迹图片服务器对象 | `src/features/attachments`；`attachments`、`attachment-associations` 测试 |

方法定位是 APK 4.5.4 的混淆名称，升级版本后需要重新定位；测试名指 `tests/workers/*.test.ts`。服务采用更严格的历史回执和未知写保护，并非逐字复制 Android 的线程/本地数据库实现。

## 关闭分析服务后的维护证据

新增[方法证据索引](../protocol/454/final-method-evidence.json)，记录本轮10个直接完整读取的方法/类定位及返回文本 SHA-256，全部未截断。哈希用于比对重新反编译的同一段文本，不是 APK 文件哈希。仓库保存逻辑结论、协议契约和脱敏回归样本，不包含 APK 文件、整份反编译代码、账号数据或 MT 工作区。

此前详细证据仍保留于本目录的同步认证、冲突、缓存、资产目录、账单统计和计划审计文档。`tools/protocol/mt-read.mts` 是可选只读维护工具；生产 Worker、页面、MCP、构建及测试不依赖 APK 分析服务，可以关闭。

最终本地严格类型、491项后端/契约测试（50文件）、118项桌面/手机测试、生产构建和 Wrangler dry-run 通过；生产 Worker 1485.00 KiB / gzip 353.97 KiB。Cloudflare 生产出口、ChatGPT 实接、生产 CPU/费用和远端 PITR 仍属于部署阶段，未假称已经验证。
