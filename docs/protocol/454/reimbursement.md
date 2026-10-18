# 报销与关联写入契约

证据版本：钱迹4.5.4/1234。以下是 APK 静态逻辑与脱敏合成向量，尚不代表真实账户写入验收。公开写能力继续返回 `WRITE_LIVE_UNVERIFIED`，按第16/18/27步在专用测试资产、账本中核验。

## 报销入账

`network/api/bill/a.doBaoXiao` 使用普通构造器 POST `/baoxiao/baoxiao`，继承签名、utoken及表单fr，不加同步字符串构造器的htoken。业务参数：

| 参数 | 编码/省略语义 |
| --- | --- |
| uid | 当前用户 |
| v | 源长ID为key的无损JSON字符串；每项为`{"money":50}`或`{"curr":{"ss":"USD","sv":50,"ts":"CNY","tv":350,"bs":"CNY","bv":350}}` |
| did | 选择的到账资产ID，大于0时发送；没有资产省略 |
| bxtime | 报销秒时间；原生大于0时发送 |
| remark | 非空时发送 |
| images / tags | 非空列表编码为独立JSON表单字符串，空列表省略；新图片等待附件域验收 |

`network/api/bill/c`解析 `data.asset`（可空）与`data.bills`（数组）；模型b中的字段名为inAsset/billList。成功回调保存官方资产与整组账单。资产余额只替换一次，不能在官方余额上再累加预期入账。

`BxPresenterImpl.doBaoXiao`先按源时间升序、长ID升序排序，非末笔取`min(max(getRealMoney(),0),剩余总额)`，最后一笔接全部余数。两个剩余各50、报销120，分配50/70；不按比例均分，不自行限制总额必须小于本金。历史三币种分配先对target/src、base/src执行10位HALF_UP除法，再乘非末笔源金额，末笔承接三种币值的各自余数。

`Bill.getRealMoney`使用源币种统计金额减退款，仅当非空bxs存在时再减V2兼容报销金额；旧baoxiaoed单独存在不在这一分支扣除。`BaoxiaoManageAct.q1/v0/u0`校验当前用户及唯一源币种；null与显式CNY也是两个原生集合成员，不能擅自合并。非本位币源或到账资产需明确历史币种资料，不获取当前汇率代替历史值。

合成回执向量与断言在[reimbursement.test.ts](../../../tests/workers/reimbursement.test.ts)：真实源5的bxs指向真实21，子extra.bxsid指回源；回执金额、历史币种、到账资产、时间、明确备注/标签均需与意图匹配。缺源、缺子、重复/陌生ID、关系或金额不符时整个回执不应用，操作保持待核查。未知结果只读同步比对新增关系组，不重发baoxiao。

## 取消与待报销属性

`unBaoXiao`普通构造器 POST `/baoxiao/cancelbaoxiao`，参数uid及v：**源账单数字ID数组的JSON字符串**。成功解析器仅通用成功，可没有data；该成功码不足以证明资产、源与子关系已核对。

`BxPresenterImpl.j`本地回滚子资产并标记真实子记录删除，`Bill.undoBaoxiao`仅清空bxs，保留type5及旧字段。原生后续deleteBaoxiaoEdBills读取已清空的bxs，不能仅凭方法名推断云端还要再发子删除。服务保存原操作，等待成功的发送后只读同步证明源关系清理、原子记录消失及相关资产刷新；真实验证如发现必需后续步骤，再补有检查点的原生流程，不能猜测补偿写入。

`jd/n0.x0`先检查主类型/退款限制，再处理待报销checkbox。因此独立`ledger.setReimbursable`允许0↔5保留退款；存在V2或旧兼容报销时不能取消待报销属性。普通源5的编辑保留报销扩展字段并锁定主类型。`BillDetailFrag.c1`没有提供21/虚拟22的直接财务编辑入口，服务也不将它们伪装为普通收入。

旧报销upgradeV2不自动执行；旧字段单独存在的新增/取消写入需额外真实证据，明确返回不可用。读取与删除保留原始字段及原生兼容金额。

## 关联删除与组合

`Loe/c.c`展开rfds、旧refundid/refundv及bxs；对同一个真实子ID只处理一次。`a/i`对20/21按资产币种与历史tv规则回滚；旧报销另回滚baoxiaoasset的旧金额（baoxiaov小于0回退源money）。预期资产变化不覆盖官方余额。

`Loe/c.b`只在本地清理源关系并UPDATE，没有把源标成待上传。因此单独删除子记录只上送其dellist；另保留源关系只读核查项，不编造源changelist。部分删除逐ID保存，不重发已确认项目。

虚拟type22只是相邻真实21的组合显示，不生成云端ID、额外账单或统计。按packId读取真实成员和版本，完整性不足时禁止将当前页当整组。服务单次选取最多200条是本地有界工作限制，不宣称APK服务器限制。

## 已有普通账单与退款构造

`bill/syncall`使用同步字符串构造器，v为`{"bills":{"changelist":[完整Bill],"dellist":[数字长ID]}}`的字符串。整笔上传去除category/fromact/targetact/paytype/bookname，其余未知extra保留。解析`data.sync_result.bill`的userid/new_ids/update_ids/del_ids/conf_ids/has_failed，逐项确定结果；只有明确新建ID冲突才换ID并保存映射，单轮至多5批、每批200。

`bill/refund2`使用普通构造器，uid、did源ID、v退款对象JSON字符串；v.currency又是包含ss/sv/ts/tv/bs/bv/srcFee的JSON字符串，编辑带数字billid。非空备注、图片、标签才发送，既有值清空语义未验证时明确拒绝。data为完整Bill数组，先源后真实20子；整组验证后原子应用。详细静态证据见[账单审计](../../research/2026-10-18-apk-bills-statistics-audit.md)；合成载荷/回执断言见[ledger-write.test.ts](../../../tests/workers/ledger-write.test.ts)、[refund.test.ts](../../../tests/workers/refund.test.ts)。
