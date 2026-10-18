# 本地能力覆盖与验收边界

本表按设计 §2 列出共享能力。Web 和 MCP 调用同一 Action/协调器；本地测试通过不等于真实钱迹写入通过。当前真实只读连接及目录读取已验证，正式业务写入仍返回 `WRITE_LIVE_UNVERIFIED`，等待逐场景验收。

| 领域 | Web | MCP / 共享契约 | 本地证据 | 真实验收状态 |
| --- | --- | --- | --- | --- |
| 账单查询 | 账单、详情、日历；月/年/日/自选范围、多账本/标签/成员/资产/分类/来源/金额筛选 | ledger.list/detail/calendar/options | ledger-query、read-only、full-app | 已真实只读同步；跨端改动向量待验收 |
| 普通账单 | 收入/支出/待报销表单、选择资产、编辑、删除、草稿恢复 | ledger.create/edit/delete；数组批量输入 | ledger-write、draft-currency、draft-recovery | 批量由 MCP 提供；Web 逐笔维护；所有真实写入待验收 |
| 转账/还款 | 转账、信用卡还款、手续费、优惠、历史币种三个金额 | ledger.transfer/repayCard/transfer.preview（mode 控制创建/编辑/删除） | transfer、currency 向量及 UI | 跨币种/优惠分别验收，不能以同币种样例代替 |
| 退款/报销 | 原账详情退款及维护、报销页多笔选择、到账/撤销/关系 | ledger.refund/reimburse/cancelReimbursement/setReimbursable/reimbursement.members | refund、reimbursement、关系统计测试 | 新旧报销、清空图片/标签等边界待真实验证 |
| 资产/债务 | 资产类型与分组、排序隐藏、余额差额、信用卡资料、趋势；借入借出、偿还、结清/撤销 | assets.*、debt.* | assets、debt、差额/本金利息回执测试 | 专用命名资产验收；现用资产只读 |
| 账本 | 创建编辑、排序隐藏、配置、成员、退出/删除检查 | books.* | books、draft-currency | 全局本位币真实修改影响现用账本，不能借测试授权执行 |
| 分类 | 收支/账本范围、一二级、迁移/删除/升降级/排序、官方图标和批量新增 | categories.*，图标目录独立缓存 | categories、category-catalog、category-batch | 官方541图标只读通过；写入及部分回执待验收 |
| 标签 | 标签与分组、归档、排序、删除；历史筛选含归档 | tags.* | tags、标签 UI/历史筛选 | 标签窗口、分组解绑与权益限制待验收 |
| 预算 | 月/年度、总/分类额度、执行/日均可用、账本自定义月起始 | budget.* | budget、共享账单计算与 UI | q/all 账本周期独立预算语义未证明，明确 BUDGET_RANGE_UNVERIFIED |
| 统计 | 总额、趋势、同期、分类层级/标签/成员/资产/账本；显示币种 | ledger.statistics；assets.summary/trend | statistics、performance、full-app | 历史金额，不用当前汇率回写；5000扫描上限明确 partial |
| 周期记账 | 日/步长/周/月/年/工作日、结束条件、预览、暂停恢复、关联/解绑 | repeat.* | repeat、假日/日期边界与 UI | random/resetCount/手动结束无已确认入口，不开放猜测写入 |
| 分期 | 新建/预览、相关账单、计入收支/手续费配置、提前还款、删除 | installments.* | installments、独立 Java 金额/日历向量、UI | 创建 type1 映射已证明；type2 与提前还款图片异常待验收 |
| 存钱计划 | 七种新建模式、编辑排序、存入/撤销、保留/删除账单选择 | savings.* | savings、日历/历史币种/部分回执、UI | random 新建入口未证明；存入交易及可选账单分别核验 |
| 附件 | 表单和独立上传页、预处理、展示/移除、恢复未知上传 | attachments.options/resolve/upload/result | attachments、media、上传 UI | HTTP 官方图片经受限代理；真实上传/每类关联待验收 |
| 业务配置 | 本位币、账本统计周期、计入收支/预算/资产 | books.setBaseCurrency/configure 及各域字段 | books、budget、draft-currency | 未核清金融操作阻止改本位币，旧本位币草稿必须重审 |
| 服务管理 | 登录、连接/刷新/退出、三线路、增量/重建、任务操作状态 | connection.*、sync.*、operations.* | connection、sync、rebuild、MCP transport | 登录和只读已通过；部署/ChatGPT 入口待外部环境 |

准确工具名与字段以运行时 `/mcp` 的 `tools/list` 和 `src/contracts/actions.ts` 为准；`.draft.` 仅供 Web 本地草稿，不向 ChatGPT 暴露。MCP 内上传页与代理图片链接基于当前请求入口转为绝对 URL。

## 缓存与性能

每次使用按来源更新时间检查，60秒内复用已校验集合；原生增量5秒冷却仍保留，闲置不定时请求。实体内容和查询成员集合分开；未知写入不会因普通读取而被清除，缺失的创建ID不会靠同名/同金额认领。全量重建先构造新数据集，再原子切换，失败继续使用旧副本。

本地2000笔年度统计实测：冷读144ms、14027 SQL行读取、0写入、10次账单扫描；热读1ms、19行、0写入、0账单扫描。20秒真实延迟的模拟上游尚未释放时，本地连接状态已返回。以上为本地 wall time，运行时没有提供 CPU 指标，实际 Cloudflare CPU/计费用量需部署后采集。不得将其宣称为生产性能或编造提升倍数。

草稿初始读取失败时禁止自动保存/提交，用户重读成功才恢复原请求编号。所有写视图保留 queued/sending/uncertain/partial/succeeded/failed 区别；partial 仅在每项均有确定结果时允许建立新草稿。

## 后续验收

任务27必须补充逐操作真实结果、范围及上游限制；任务28必须记录真实 Cloudflare URL、ChatGPT 联调和十分钟闲置请求观察。模拟通过、打包通过、dry-run 均不能替代这些结果。
