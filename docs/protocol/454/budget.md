# 预算（4.5.4 / 1234）

静态来源：`network/api/budget/a,c`、`data/model/Budget`、`filter/filters/DateFilter`、`df/a`、日统计模型 `rg/b` 与预算保存回调。

`budget/list` 和 `budget/submitv2` 均为普通请求构造器，带 uid/bookid/flts，可选非空 range。flts 是 DateFilter 的 key/value JSON：月度 `{"month":"2026,10"}`，年度 `{"year":"2026"}`。月份是 **1–12**；DateFilter 在写入 Calendar.MONTH 前才减1。预算 type 月度1、年度2；typeinfo 为相同日期文本。

保存时 `changelist` 是 `BudgetManageAct.O0 → BudgetSetNew.getBudgetList` 的**完整预算集合**，逐项使用 Budget.toAPIJson，仅移除 category 与 createtime；保留已有未知字段。新建对象沿用原生默认值（flag 总预算1/分类2、cateid 总预算-1、统计字段0），budgetid 未存在时省略。修改单项先覆盖完整集合，分类金额0按 `BudgetSetNew.addCategory` 从集合移除，不能发送一条 money=0 的修改项。

2026-10-19 实测独立年度：总预算12、分类5，完整集合中移除分类后回拉只剩原总预算12。旧实现向年度总预算直接发送0被钱迹 ec8888 拒绝；原未知操作保留，不重发。总预算清空现明确返回 `BUDGET_TOTAL_CANCEL_UNVERIFIED`，不能把分类取消语义推及总预算。原生 `Lan/h.b` 为 max，父/总预算还涉及下级额度的归一；二级分类预算写入在完整归一专项验证前应继续受限。

回执 `data.list` 为完整预算集合；`data.daystats` 可缺失，否则是数组，datetime 为**秒**，spend/totalspend 是不同的金额字段。保存使用整份官方集合，不能把提交值复制为已确认配置。未知结果通过原查询读取目标金额，金额比较采用精确十进制，不重发。

查询缓存按账号、账本、DateFilter、range、时区区分，空集合也缓存60秒。每份查询响应是有明确范围的预算来源文档，budgetid 仍单独保留为真实上游 ID。编辑版本只比较预算配置，忽略 used/count 等执行进度及金额文本格式差异。

执行进度复用共享账单扫描、历史退款/报销关联、历史币种和原生独立标记；同一笔支出可以出现在父、子分类预算中，总已用额从账单独立计算，不再累加分类行。跨期退款回归证明原支出月份从100更新为70。现有5000行扫描/关联完整性保护继续明确返回不完整，扩大计算窗口交 Task26 收尾。

支持自然月、自定义月起始日1–28与年度；BookConfig 的 q/all 不能直接宣称独立季度/全部预算写能力，当前明确返回 BUDGET_RANGE_UNVERIFIED，后续需要专用测试账本及原生日期转换证据。没有默默按自然月显示错误结果。

月总预算、一级分类预算、年度预算及分类取消已实际回拉核对；手机官方客户端数值对照仍待用户确认。正式写入启用仍待明确授权，当前公开门禁保持关闭。
