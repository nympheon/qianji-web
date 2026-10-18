# 借贷协议及记账规则（4.5.4/1234）

证据为 SubmitLoanViewImpl.z、BaseSubmitAssetPresenterImpl$b、LoanPayAct E0/G0/F0/J0/o0、Bill 的 set/getZhaiwuCurrent/AboutAsset，以及 Loe/c 的本金/偿还/删除分派。此文是 APK 静态契约；真实写入需在专用测试账本、测试资产中验收。

创建经正常构造器 `asset/submit(uid,v,extra)`，`v` 为 type5、stype51借入/52借出、id=-1 的资产。借入余额和 LoanInfo.money 为负，借出为正；LoanInfo 保留 startdate/enddate/totalpay。extra 是 JSON字符串，含 bookid，可选 accountId、非空 remark 和图片；客户端不把新选 accountId 另外写入 LoanInfo。回调保存 data.asset 和 data.bill；本服务必须完整核对官方初始本金账单，不能补造一笔或再次调用 syncall。

后续追加、编辑及偿还仅经 `bill/syncall` 的 bills.changelist。借贷和实际资金资产映射：

| 类型 | 含义 | 借贷对象D | 实际资金A |
| --- | --- | --- | --- |
| 6 | 借入本金 | assetid | targetid |
| 7 | 借出本金 | assetid | fromid |
| 9 | 归还借入本金 | assetid | fromid |
| 4 | 收回借出本金 | assetid | targetid |
| 10 | 利息支出 | fromid | assetid |
| 11 | 利息收入 | fromid | assetid |

未关联资金时对应字段=-1。本金与利息使用各自的长整数ID，没有新增 sourceBillId 或父子链接。纯利息不生成本金。Web/MCP 必须保留逐条成功/失败/未知状态，不承诺一批全部原子成功。明确新增ID冲突才沿用公共管线更换ID；未知结果从不重发。

设余额C、累计本金T、已还本金A、金额P、旧本金Pold：追加/编辑借入使 T'=T-(P-Pold)，C'=min(T'+A,0)；借出使 T'=T+(P-Pold)，C'=max(T'-A,0)。归还借入 C'=min(C+P,0)，收回借出 C'=max(abs(C)-P,0)，A增加P，利息不进入A。现金侧只合计一次本金与利息，逐条预期效果可相加，不能把官方回执余额再叠加一次。

API确定顺序对应 G0 在已有利息字段之后执行：本金输入取绝对值，偿还时超过 abs(C) 则本金=abs(C)、利息=超出值，替换原利息。预览会显示拆分结果；需要之后手改利息时传已经钳制的本金和所需利息。本金和利息各自最多9,999,999,999。仅本位币借贷与普通资金资产/信用卡；没有LoanInfo的资产可见但不按零推算写入。

编辑只开放6/7，保留原ID及未知字段；先反向撤销旧资金资产、再应用新资金资产，并合并同ID的差额。不同借贷对象必须保持借入/借出方向。图片扩展留待附件模块。

删除使用同一 syncall dellist。6/7反向修改本金并将余额夹在借入非正/借出非负范围；9/4反向恢复本金现金及已还本金，原生g在T为0时将C置0。删除本金不会推断或删除独立利息；10/11只通过其assetid回滚实际资金。关联退款/报销沿用各自真实ID核查规则。

Canonical 资产及 LoanInfo 只由完整官方回执或官方只读来源替换，预期效果不写回确认余额。新建回执若丢失，不能凭名称相同认定为本次创建；保持未知、只读核查。借贷列表使用 `asset/listloan(uid,t=51|52,status=0|1)`、原生parser/b的 data.list；与资产列表共享真实ID、查询成员集合和60秒按需缓存，不能再作为额外余额加一次。闲置无请求。
