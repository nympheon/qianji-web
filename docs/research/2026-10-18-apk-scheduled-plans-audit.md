# Android 4.5.4 周期、分期与储蓄计划审查

- 日期：2026-10-18。
- APK：`qianji_454_1234_gw.apk`，`com.mutangtech.qianji`，4.5.4 / 1234，5 个 DEX。
- 方法：只读 MT MCP 工作区 `rxvx4qt6`；读取 Smali、模型、调用者及回调；补读官方产品指南。没有修改 APK、调用真实钱迹接口、实现产品、修改主设计或暂存/提交 Git。
- 对照：[主设计](../superpowers/specs/2026-10-18-qianji-workers-design.md)。本文只提出修订建议。
- 证据等级：**静态确认**表示 APK 中能看到实际参数、分支或存储操作；**推断**表示调用链支持但不能代替服务端验证；**待实测**表示本轮没有真实响应或服务端实现证据。接口名存在不等于能力已验收。
- 下文 locator 是 MT MCP 可直接读取的完整定位符。只读缓存位于系统临时目录 `qianji-requirements-20261018`，本子任务新增缓存均以 `plans-` 开头。

## 1. 最重要的结论

1. **不应增加 Worker 周期出账或历史补账器。**实际提交路径发送任务/分期业务数据，回执解析并保存官方返回的 `bills`。本地确有 Bill 构造代码，但追踪到的是提交预览，不能据此增加第二个执行主体。静态证据支持“实际账单由官方接口返回、未来出账交给官方任务体系”的设计；服务端定时器运行方式、离线设备条件及服务端去重算法仍未证明。[E1–E4]
2. **`bindbill` 是绑定与解绑共用的翻转操作。**它不是“生成账单”接口；调用者传入用户选中的已有 Bill。成功后客户端按 `Bill.importPackId == task.packId` 决定写 `-1` 或 `packId`。这类操作不能在超时后直接重试。[E5–E6]
3. **分期不能开放任意编辑。**新增走完整 `submit`；已存在分期的 `config` 调用只发送 `incount`、`feeincount`。提前还款是独立业务，存在支出和还款两笔预览，实际记录来自 `prepay` 回执。不要把“配置”扩大成总金额、期数、首期日可任意修改。[E8–E11]
4. **储蓄进度和账单是两层对象。**存入可只产生 transaction，也可通过 `billInfo` 同时要求生成账单；撤销以 `transid` 为目标，若关联 `billid > 0`，成功后 APK 同时移除该账单。删除计划另有 `deleteBills` 选择，不能与撤销存入混为一谈。[E13–E16]
5. **ID 需要区分。**周期 `id` / 分期 `id` 是管理对象 ID，`packid` 是账单分组关系；储蓄 `planid`、`transid` 在 APK 是 String，不足以证明纯十进制格式。主设计“所有业务 ID 都为十进制字符串”应限定到已确认的数值 ID，其余原样保存。[E7、E12、E17]

## 2. 周期记账

### 2.1 操作与状态

| 能力 | 静态确认的调用和条件 | 设计含义 |
| --- | --- | --- |
| 新建/编辑 | `RepeatTaskSubmitAct.parseInitData()`：有 `extra_task` 则用原对象，否则构造 `RepeatTask + RepeatTaskData`；`e1()` 以 `taskId != null` 区分已有对象；`h1()` 把整个任务 Gson 序列化为 `v`，提交 `repeat_task/submit`。[E1、E7] | 保留对象原字段，按 APK 业务表单改动；不能把新增与编辑都变成普通账单上传。 |
| 必填与类型 | `A0()` 要求重复配置、开始日期、金额大于 0；需要分类的账单类型要求 `cateid > 0`；转账类要求转出、转入资产 ID 都大于 0；有图片须已准备好。[E18] | 网页/MCP 共用校验。手续费与显示金额不是一律原值上送，须复现该分支。 |
| 启停 | 已有任务 `onCreate()` 仅在状态 0 或 1 设置启停按钮；`E1(task)` 调 `toggle(uid, taskId)`；API 没有目标状态参数。[E19] | 对外可表达“暂停/恢复”，适配器先读当前状态，已达目标则不调用；结果不明只核查。不能以重复 toggle 达成幂等。 |
| 结束 | 模型有 `status = -1 finished`、`-2 expired`、`-3 error`，并有 `RepeatEnd.count/date`；没有在已读 API 类中发现独立 `finish` 方法。[E7、E20] | 结束条件与删除区分。不要凭状态常量开放“直接写 finished”的工具；显式手动结束是否通过修改 end 仍需核对。 |
| 删除 | `delete(uid, did=taskId)`；成功回调只删除本地任务对象，没有在该回调删除关联账单。[E21] | 不增加默认级联删账；服务端删任务后的历史账单关系须实测。 |
| 重置次数 | API 类有 `resetCount(uid, did)`，但 dispatch xref 本轮为 0。[E22] | 发现接口，未证明 4.5.4 活跃产品操作；不据此单独开放“重置执行次数”。 |
| 查询和排序 | `list(uid,page,SortFilter)` 可携带 `flts`；模型排序常量有创建时间、状态、次数、账单类型。[E7、E23] | 复用官方列表语义；本服务 60 秒缓存为用户要求，不照抄 APK 列表缓存时长。 |

[官方周期指南](https://docs.qianjiapp.com/vip/vip_repeat_task.html)说明：修改只影响以后生成的账单；改变周期类型会重新累计次数；历史账单可编辑或删除；引用的账户、账本或分类被删会导致任务失效。指南还说明免费 2 条、会员最多 80 条执行中任务，暂停/已完成不计上限。上述是产品规则背景，**不是本轮服务端实测，也不证明定时执行主体**。`FREE_MAX_COUNT = 2` 的 APK 常量与免费限制一致；会员上限仍应以当前账号权益和真实拒绝为准。[E7]

### 2.2 时间、结束和预览

- `RepeatConfig` 为 `type + value:ArrayList<String>`；类型含 `day/week/month/year/workday/bystep`。`bystep` 的首个值被解析为天数，使用 Calendar day-of-year 增加。不要擅自把所有规则转换成简单 Cron。[E24]
- 月规则存在特殊值 `32`（月末）、`291`（29 或月末）、`301`（30 或月末），不是普通的日号。`k(...)` 显式处理这些值和本月最大日数；`i(...)` 将 291、301 显示为 `29+`、`30+`。[E24–E25]
- `workday` 调 `Lzf/a;->getNextLegalWorkday`。`isLegalWorkday()` 先取该年的官方节假日映射；映射存在时优先使用 `holiday` 标志，未列出的日期按周末判断；**该年映射为空时直接返回 false**。因此网页预览不能在缺官方年数据时静默用“周一至周五”代替法定工作日。[E26]
- `RepeatEnd` 支持 `byDate()`、`byCount()`；`getRepeatEndStr()` 对 null、日期和次数分支分别展示。日期边界是否包含当天、修改规则后次数从何处重新起算，仍需服务端验证。[E20]
- `Lzf/b;->b(...)` 会构造 Bill，但其调用链是 `b -> c/d -> a -> buildPreviewBills -> RepeatTaskSubmitAct.T0()`，最后打开标记为 `repeat_task_preview` 的界面，没有沿这条链保存或上传生成的账单。[E3]
- APK 预览用 `Calendar.getInstance()`，反映设备时区；主设计的 `Asia/Shanghai` 是本项目默认值。服务器任务时区、夏令时和跨时区修改不能仅由这段代码确认。[E3、E24]

### 2.3 管理 ID、账单关系和翻转风险

`RepeatTask` 的管理 ID 为 JSON `id`（Long），分组 ID 为 `packid`（long），另有 `userid/count/status/type/createtime/updatetime/data`。`RepeatTaskData` 含 `bookid/cateid/category/fromid/targetid/money/fee/start/time/repeat/end/billflag/curr/images/tags/remark`。[E7]

选择已有账单的 `Lrf/c;->Z0(Bill)` 调 `bindBill(uid,taskId,billId)`。绑定/解绑确认入口最终都调用这个方法；成功回调 `Lrf/c$a;` 根据既有 `importPackId` 翻转为当前任务的 `packId` 或 `-1`。这里既不产生新的 Bill ID，也不等同账单去重。[E5]

对网页/MCP，应以“保证该账单关联到/移出此任务”的目标表达操作，提交前后分别核查实际关系。这个本服务层目标检查是适配翻转接口所必需的保护；不能声称官方支持条件写入，跨设备同时翻转仍待实测。[E5]

## 3. 消费分期与账单分期

### 3.1 新建、金额和已存在对象的边界

- 新建页面 `Lxf/f0;->startSave()` 将整个 Installment 转 JSON 上送 `installment/submit`。提交前把 `count` 设置为 `X0()` 的结果：首期日在未来则为 0；按规范化到日的今天和首期日计算已经过去的月数；同一日不增加；`totalCount > 0` 时限制不超过总期数。**不要强制 count=0，不要由 Web 再补写这些历史期数的账单。**服务端对已有 count 的跳过、补记或即时返账行为仍须实测。[E8]
- 模型有 `totalCount/count/totalMoney/totalFee/money/fee/starttime/assetid/incount/packid/status/data` 等信息；数据里有 `feetype/lefttype/feeincount/prepayTimeInSec/category/cateid/billflag/asset/images/tags/remark`。[E12]
- 手续费分配常量是 `ave/first/last`；尾差方式包含 `first/last/rndf/rnd/intf/intl`，相应计算由 `calculateAverageValue`、`calculateLeftValue` 处理。不要自行固定为“本金和利息均分到分”。分期预览由 `Lxf/g0;->buildPreviewBills` 单独实现。[E12、E27]
- 消费分期与账单分期的区别不能只靠模型常量 `TYPE_CREDIT=1/TYPE_LOAN=2` 直译；本轮 `getType()` xref 只见 DAO 读写。官方指南区分两种产品行为，APK 还以 `incount/feeincount` 影响统计，但数字类型与产品名称的完整映射没有在本轮闭合。[E12、E28]

[官方分期指南](https://docs.qianjiapp.com/vip/vip_installment.html)说明消费分期自动记录支出、账单可单独编辑/删除、资产删除会使计划失效，以及“已经添加的分期任务不支持修改”。该规则与本轮 `config` 只改统计选项的代码一致，不能解释为完全没有配置能力。

已存在分期的 `Ltf/f;->K0()` 只构建 `{"incount":0或1,"feeincount":0或1}`，调用 `config(uid,did=dataId,v)`。这证明的是配置这两个选项，**没有证明总金额、期数、首期日、目标资产可修改**。分期 API 类也没有周期任务那样的 toggle。[E9]

删除走 `delete(uid,did=dataId)`，成功回调 `Ltf/f$c;` 只移除分期对象。本轮不能推出服务端是否清空历史 Bill 的 pack 关系，不能默认级联删历史账单。[E29]

### 3.2 提前还款

`Lwf/n;->W0()` 的前置条件：已选支付资产、还款金额存在且大于 0、手续费若输入则不得为负、汇率校验通过、图片准备完成。载荷是 `dataid/bookid/time/money/fromid`，可附加正手续费 `fee`、非空 `remark`、附件、`spendCurrency`、`transferCurrency`。`time` 是秒；两种 CurrencyValues 被序列化成 JSON 字符串后放进 `v` 内，不应未经核对改成另一种嵌套结构。[E10]

`K0(remark)` 创建两笔**预览**：type=0 的支出、type=3 的还款，分别附币种数据，第二笔包含转出与分期账户。`g1(params,previewBills)` 仅绑定界面，再把原业务参数交给确认按钮。实际 `J0(params)` 请求 `prepay`；解析器读取 `install` 和可选 `bills`。不要先上传两笔预览账单再调用 prepay，否则会产生第二套记录。[E10–E11]

已提前还款由 `Installment.hasPrePayed()` 和 `InstallmentData.prepayTimeInSec` 表达；详情状态 -1 下区分提前还款完成与自然完成。可执行提前还款的完整状态范围、是否允许多次/部分提前还款、手续费和剩余本金约束仍需真实业务响应确认；不能仅因 API 存在就开放全部组合。[E12、E30]

**疑似 APK 缺陷：**`W0()` 取出图片列表到 `v4`，但非空分支向 `images` 放的是 `v0`（此前是备注文本）。这属于明确可复查的寄存器证据，不应当作正确协议照抄；需使用服务端契约或受控请求验证附件字段。[E10]

### 3.3 关联与执行主体

分期管理 ID 是 `dataId`（JSON `id`），账单分组是 `packId`（JSON `packid`）。`bindBill(uid,installmentId,billId)` 的唯一直接调用者为 `Lrf/b;->Z0(Bill)`；与周期一样来自已有账单选择，不能据接口名解释为出账器。完整解绑后关系的核验应覆盖两个 ID 与 `Bill.importPackId`。[E6、E12]

`submit` 与 `prepay` 共用解析器 `installment/c`，读取 `install + bills`。提交成功回调把返回 bills 保存本地；本地 `Lxf/g0` 负责预览/下一期显示。本轮未发现该域独立的客户端定时写 Bill 路径，但静态负证据并不能证明所有运行时行为或服务端定时、补偿和去重实现。[E2、E4、E27]

## 4. 储蓄计划

### 4.1 模式与修改

枚举 `Lfg/a;` 含 8 个协议字符串：`fixedAmount/fixedAmount12/fixedAmount36/daily365/weekly52/reverseWeekly52/random/custom`。但已追的创建基类 `Lkg/c;->parseInitData()` 只有 **7 个创建分支**，没有 RANDOM 分支；既有对象分支直接使用传入计划。故本轮只确认 random 可被模型识别，不能宣称该入口支持新建随机计划。[E31]

- 固定金额规则字段：`amount/frequency/period/start`，频率常量 `day/week/month/quarter/year`。
- 递增规则：`initialAmount/increment/start/period`；自定义规则：`total/start/end`。
- 规则 `calculateAllTransactions()` 返回计算的计划列表，用于计划展示，不能把它当已实际存入交易，更不能按其结果定时调用 deposit。[E32]

`saving/submit` 传 `uid/did=planId/mode/name/currency/rule/remark/icon/color`。基类 `startSave()` 会先检查名称及子类规则，把名称和备注写回计划；已有计划经相同提交路径保存。**修改对已有交易、总进度及币种的服务端影响尚未确认**，不能自动重算/重写历史 transaction。[E13、E33]

已读表单校验：固定金额需 amount>0、period>=0、频率非空、币种非空、start>0；递增需初始金额>0、increment>=0、币种和 start 有效；自定义需 total>0、币种和 start 有效。代码没有在这些 `checkParams()` 中证明 period=0 的产品含义或 end>start 的约束，不能自行当作官方无限期/合法日期组合。[E34]

### 4.2 存入、可选转账账单与撤销

`SavingPlanDepositAct.startSave()` 要求金额>0，收集备注和时间；若关联账单区域未显示则 billInfo 保持空 Map，不要求出入资产。如果启用关联账单区域，则必须选择转出、转入资产，并通过币种校验，billInfo 含：`bookId/outAssetId/inAssetId`，可加 `currency/images/tags`。[E14]

API 发送 `saving/deposit(uid,did=planId,amount,remark,time,billInfo?)`；time 从毫秒除 1000 变成秒。解析器取必需的 `transaction`，有 `bill` 时另解析 Bill。成功回调保存 transaction，存在 bill 时保存官方返回的 bill、刷新账单及资产。因此网页/MCP 应提供“只记录存入”和“同时记转账账单”相应选项；不能无条件新增普通收入/支出，也不能独立写转账后再 deposit。[E14–E15]

`SavingTransaction` 主键为 `transid:String`，有 `planid/userid/amount/time/remark/billid`；默认 `billid=-1` 表达没有账单。撤销入口把 `getTransId()` 传给 `cancelDeposit(uid,did)`。成功回调先删 transaction，再在 `billid>0` 时移除关联 Bill 并刷新资产。**撤销存入的影响提示应明确包含关联账单删除。**结果不明须核验 transaction 和 bill 两边，不能只看进度减少。[E16–E17]

`saving/delete(uid,did=planId,deleteBills=0或1)` 是另一个操作；成功回调按该布尔值清理关联记录。应要求明确保留还是删除关联账单，并展示影响；不能把取消一笔存入和删除全部计划复用同一载荷。[E16]

### 4.3 查询、排序和状态

`list(uid)` 使用专用 saving 列表解析器，`reorder(uid,v=JSON数组(planId))` 提交顺序；SavingPlan 状态是 1=进行中、2=完成，保存 `transactions` 与 `savedAmount`。API 类中没有启停或强制完成方法，不能照搬周期任务的状态机到储蓄计划。[E13、E17]

目前实际存入路径来自用户操作界面，规则的计算列表与实际 transactions 分开。没有证据支持“到期自动向资产扣款/自动存入”这一新功能；本项目闲置不请求的约束与保留官方管理、用户显式 deposit 相容。[E14、E32]

## 5. 主设计应修正或补充的条款

| 位置 | 建议 | 依据/边界 |
| --- | --- | --- |
| §2 周期 | 将“结束”细分为条件到期/完成、暂停恢复、删除；手动结束保持待核验，不提供直接写 status 的万能更新。 | E19–E22；状态常量不等于已证实操作。 |
| §2 分期 | 明示已有分期仅开放已核验的统计配置；任意编辑不在成熟 APK 已确认能力内。保留独立提前还款、预览、关联/解除关联。 | E9–E11，官方产品规则。 |
| §6、§12 执行主体 | 保留“不新增 Worker 定时生成账单”；将静态研究结果提升为：官方回执返回实际 bills，本地预览不提交。未来任务定时及去重实现仍待实测。 | E1–E4、E27。不能编造“手机与服务各生成后去重”。 |
| §7 幂等/结果核查 | 对 toggle、bindbill 单列翻转性质；读取当前状态以达成目标，不重试结果不明的翻转；对计划创建、deposit、prepay 同时核验业务对象及回执 bills。 | E5–E6、E10、E14–E16、E19。服务层持久操作记录有必要，但不应把它说成 APK 机制。 |
| §7 ID | 不把普通账单 conf_ids 换 ID 规则推广到服务端创建的周期/分期/储蓄对象；不把本地预览 Bill ID 持久化成将要发送的正式账单。 | E1–E4、E10–E11、E13–E15。 |
| §8 数据模型 | 区分 task.id/installment.id、packid、billid、planid、transid；String 类型 ID 不先强制十进制格式。保留不同时间单位、嵌套编码与原始字段。 | E7、E10、E12、E17。 |
| §8/§9 储蓄 | 将计划计算行与实际 transaction 分离；存入可选账单；撤销可连带删关联账单；删计划独立提供 deleteBills。 | E14–E17、E32。 |
| §11 验收 | 添加下面契约矩阵；先复刻已确认产品行为，疑似 APK 缺陷单独验证，不复制错误。 | 全文。 |

不建议为了“模仿 APK”额外增加：客户端定时器、后台补历史期数、双执行主体去重、通用计划 CRUD、通用状态 setter、自动把储蓄计划计算行写成交易。单 DO 的写入排序、请求键、操作核验是 Web/MCP 网络环境所需的适配保护；不需要仿造 Android 线程、广播、数据库实现。60 秒缓存、单人免鉴权、无闲置请求等已确认约束不因本审查改变。

## 6. 仍需真实服务端实测的最小矩阵

本轮没有执行以下写入；未来只能在明确测试对象中验证，不能将模拟测试标为已支持。

1. **执行主体和恢复：**创建未来周期和分期后，退出/强停全部官方客户端，Web 服务闲置且不发请求；跨过执行时刻后只读查询，检查官方账单、task count/status 和 pack 关联。再测试未登录设备、长期未打开、失效引用及到期日边界。一次成功只能验证该实验条件，不能证明全部去重算法。
2. **提交和初始次数：**首期今天/昨天/未来、已有过去期数、总期数结束；记录 submit 即时 bills；不得由 Web 补写。周期修改类型/重复配置前后核对 count、packid 与旧 Bill 保留情况。
3. **翻转：**重复 toggle、绑定、解绑、跨端同时操作、响应丢失；验证同一用户目标不会被重试反转。核查目标账单原先归属另一个任务/分期时是移动、拒绝还是允许重绑定。
4. **分期金额：**首末期手续费、所有尾差模式、小额除不尽、已有 count、统计配置对旧账和新账的范围；确认消费与账单分期在金额/资产/统计上的完整映射。
5. **提前还款：**进行中/完成/异常/过期状态、部分/全额/再次提前还款、不同支付资产和币种、手续费、附件；核对 install 状态、prepayTime、返回两笔账单的类型及金额。重点验证 W0 的疑似 images 载荷问题。
6. **储蓄：**七种创建分支及 random 的真实入口；修改规则/币种后的历史交易；只存入与关联转账两种请求；deposit 响应丢失后 transaction/bill 查回；cancel 对已有/已删除 Bill 的处理；deleteBills=0/1 后计划、交易、账单和资产变化。
7. **时间和权益：**上海时区、其他设备时区、跨日、月末 29/30/31/32、闰年、法定调休及缺年映射；当前账号正在执行任务数/VIP 过期/共享账本写权限。对照实际错误码，避免用硬编码产品限制伪造上游拒绝。

## 7. 精确证据定位索引

### 周期与执行

- **E1**：`dex_method:Lcom/mutangtech/qianji/repeat/repeattask/submit/RepeatTaskSubmitAct;->parseInitData()Z`；`dex_method:Lcom/mutangtech/qianji/repeat/repeattask/submit/RepeatTaskSubmitAct;->e1()Z`；`dex_method:Lcom/mutangtech/qianji/repeat/repeattask/submit/RepeatTaskSubmitAct;->h1()V`；`dex_method:Lcom/mutangtech/qianji/network/api/repeattask/a;->submit(Ljava/lang/String;Ljava/lang/String;Lql/d;)Lcom/android/volley/Request;`。
- **E2**：`dex_method:Lcom/mutangtech/qianji/network/api/repeattask/c;->f(Lcom/mutangtech/qianji/network/api/repeattask/d;Lcom/google/gson/JsonObject;)V`；`dex_method:Lcom/mutangtech/qianji/network/api/installment/c;->f(Lcom/mutangtech/qianji/network/api/installment/d;Lcom/google/gson/JsonObject;)V`。
- **E3**：`dex_method:Lzf/b;->b(Ljava/util/Calendar;Lcom/mutangtech/qianji/data/model/RepeatTask;)Lcom/mutangtech/qianji/data/model/Bill;`；`dex_method:Lzf/b;->a(Ljava/util/Calendar;Lcom/mutangtech/qianji/data/model/RepeatTask;Lcom/mutangtech/qianji/data/model/AssetAccount;Lcom/mutangtech/qianji/data/model/AssetAccount;)Lcom/mutangtech/qianji/data/model/Bill;`；`dex_method:Lzf/b;->buildPreviewBills(Lcom/mutangtech/qianji/data/model/RepeatTask;Lcom/mutangtech/qianji/data/model/AssetAccount;Lcom/mutangtech/qianji/data/model/AssetAccount;)Ljava/util/List;`；`dex_method:Lcom/mutangtech/qianji/repeat/repeattask/submit/RepeatTaskSubmitAct;->T0(Lcom/mutangtech/qianji/repeat/repeattask/submit/RepeatTaskSubmitAct;)V`。后两者 dispatch xref 闭合到唯一页面预览调用者。
- **E4**：`dex_method:Lcom/mutangtech/qianji/repeat/repeattask/submit/RepeatTaskSubmitAct$k;->onExecuteRequest(Lcom/mutangtech/qianji/network/api/repeattask/d;)V`；`dex_method:Lxf/f0$k;->onExecuteRequest(Lcom/mutangtech/qianji/network/api/installment/d;)V`。成功后保存回执对象/账单。
- **E5**：`dex_method:Lrf/c;->Z0(Lcom/mutangtech/qianji/data/model/Bill;)V`；`dex_method:Lrf/c;->a1(Lcom/mutangtech/qianji/data/model/Bill;)V`；`dex_method:Lrf/c$c;->onClick(Landroid/content/DialogInterface;I)V`；`dex_method:Lrf/c$d;->onClick(Landroid/content/DialogInterface;I)V`；`dex_method:Lrf/c$a;->onExecuteRequest(Lta/b;)V`；`dex_method:Lcom/mutangtech/qianji/network/api/repeattask/a;->bindBill(Ljava/lang/String;JJLql/d;)Lcom/android/volley/Request;`。
- **E6**：`dex_method:Lrf/b;->Z0(Lcom/mutangtech/qianji/data/model/Bill;)V`（API dispatch xref 的唯一直接调用者）；`dex_method:Lrf/b$a;->onExecuteRequest(Lta/b;)V`（成功后按 importPackId 与分期 packId 比较，写 -1 或 packId）；`dex_method:Lcom/mutangtech/qianji/network/api/installment/a;->bindBill(Ljava/lang/String;JJLql/d;)Lcom/android/volley/Request;`。
- **E7**：`dex_class:Lcom/mutangtech/qianji/data/model/RepeatTask;`；`dex_class:Lcom/mutangtech/qianji/data/model/RepeatTaskData;`。
- **E18**：`dex_method:Lcom/mutangtech/qianji/repeat/repeattask/submit/RepeatTaskSubmitAct;->A0()Z`。
- **E19**：`dex_method:Lcom/mutangtech/qianji/repeat/repeattask/submit/RepeatTaskSubmitAct;->onCreate(Landroid/os/Bundle;)V`；`dex_method:Lcom/mutangtech/qianji/repeat/repeattask/submit/RepeatTaskSubmitAct;->u1()V`；`dex_method:Lcom/mutangtech/qianji/repeat/repeattask/submit/RepeatTaskSubmitAct;->E1(Lcom/mutangtech/qianji/data/model/RepeatTask;)V`；`dex_method:Lcom/mutangtech/qianji/network/api/repeattask/a;->toggle(Ljava/lang/String;JLql/d;)Lcom/android/volley/Request;`。
- **E20**：`dex_class:Lcom/mutangtech/qianji/data/model/RepeatEnd;`；`dex_method:Lzf/b;->getRepeatEndStr(Landroid/content/Context;Lcom/mutangtech/qianji/data/model/RepeatEnd;)Ljava/lang/String;`。
- **E21**：`dex_method:Lcom/mutangtech/qianji/repeat/repeattask/submit/RepeatTaskSubmitAct;->D0(Lcom/mutangtech/qianji/data/model/RepeatTask;)V`；`dex_method:Lcom/mutangtech/qianji/repeat/repeattask/submit/RepeatTaskSubmitAct$c;->onExecuteRequest(Lta/b;)V`。
- **E22**：`dex_method:Lcom/mutangtech/qianji/network/api/repeattask/a;->resetCount(Ljava/lang/String;JLql/d;)Lcom/android/volley/Request;`，本轮 dispatch xref：0，`hasMore=false`。
- **E23**：`dex_method:Lcom/mutangtech/qianji/network/api/repeattask/a;->list(Ljava/lang/String;ILcom/mutangtech/qianji/filter/filters/SortFilter;Lql/d;)Lcom/android/volley/Request;`。
- **E24**：`dex_class:Lcom/mutangtech/qianji/data/model/RepeatConfig;`；`dex_method:Lzf/b;->getNextRepeatTime(Ljava/util/Calendar;Lcom/mutangtech/qianji/data/model/RepeatConfig;Z)Ljava/util/Calendar;`；`dex_method:Lzf/b;->j(Ljava/util/Calendar;Lcom/mutangtech/qianji/data/model/RepeatConfig;)Ljava/util/Calendar;`。
- **E25**：`dex_method:Lzf/b;->k(Ljava/util/Calendar;Lcom/mutangtech/qianji/data/model/RepeatConfig;Z)Ljava/util/Calendar;`；`dex_method:Lzf/b;->i(Landroid/content/Context;Ljava/lang/String;)Ljava/lang/String;`。
- **E26**：`dex_method:Lzf/a;->getNextLegalWorkday(Ljava/util/Calendar;)Ljava/util/Calendar;`；`dex_method:Lzf/a;->isLegalWorkday(Ljava/util/Calendar;)Z`；`dex_method:Lcom/mutangtech/qianji/network/api/repeattask/a;->holidays(Ljava/util/List;Lql/d;)Lcom/android/volley/Request;`。

### 分期

- **E8**：`dex_method:Lxf/f0;->startSave()V`；`dex_method:Lxf/f0;->X0()I`；`dex_method:Lcom/mutangtech/qianji/network/api/installment/a;->submit(Ljava/lang/String;Ljava/lang/String;Lql/d;)Lcom/android/volley/Request;`。
- **E9**：`dex_method:Ltf/f;->K0()V`；`dex_method:Lcom/mutangtech/qianji/network/api/installment/a;->config(Ljava/lang/String;JLjava/lang/String;Lql/d;)Lcom/android/volley/Request;`。
- **E10**：`dex_method:Lwf/n;->W0()V`；`dex_method:Lwf/n;->K0(Ljava/lang/String;)Ljava/util/List;`；`dex_method:Lwf/n;->g1(Ljava/util/HashMap;Ljava/util/List;)V`；`dex_method:Lwf/n;->J0(Ljava/util/HashMap;)V`。
- **E11**：`dex_method:Lcom/mutangtech/qianji/network/api/installment/a;->prepay(Ljava/lang/String;Ljava/util/HashMap;Lql/d;)Lcom/android/volley/Request;`；E2 的 installment 解析器。
- **E12**：`dex_class:Lcom/mutangtech/qianji/data/model/Installment;`；`dex_class:Lcom/mutangtech/qianji/data/model/InstallmentData;`；`dex_method:Lcom/mutangtech/qianji/data/model/Installment;->calculateAverageValue(Lcom/mutangtech/qianji/data/model/Installment;DLjava/lang/String;)D`；`dex_method:Lcom/mutangtech/qianji/data/model/Installment;->calculateLeftValue(Lcom/mutangtech/qianji/data/model/Installment;DLjava/lang/String;)D`。
- **E27**：`dex_method:Lxf/g0;->buildPreviewBills(Lcom/mutangtech/qianji/data/model/Installment;)Ljava/util/List;`；`dex_method:Lxf/g0;->getNextRepeatTime(Lcom/mutangtech/qianji/data/model/Installment;)Ljava/util/Calendar;`。
- **E28**：`dex_method:Lcom/mutangtech/qianji/data/model/Installment;->getType()I` 的 dispatch xref：只返回 InstallmentDao 两种 bindValues，`hasMore=false`。这是本轮负证据，不是删除类型字段的依据。
- **E29**：`dex_method:Ltf/f;->I0(Lcom/mutangtech/qianji/data/model/Installment;)V`；`dex_method:Ltf/f$c;->onExecuteRequest(Lta/b;)V`。
- **E30**：`dex_method:Lcom/mutangtech/qianji/data/model/Installment;->hasPrePayed()Z`；`dex_method:Ltf/f$a;->d(Lcom/mutangtech/qianji/data/model/Installment;)V`。

### 储蓄

- **E13**：`dex_class:Lcom/mutangtech/qianji/network/api/saving/c;`，含 submit/list/reorder/deposit/cancelDeposit/delete 的完整构造；`dex_method:Lkg/c;->startSave()V`。
- **E14**：`dex_method:Lcom/mutangtech/qianji/savingplan/ui/deposit/SavingPlanDepositAct;->startSave()V`；`dex_method:Lcom/mutangtech/qianji/savingplan/ui/deposit/SavingPlanDepositAct;->l0()Z`。
- **E15**：`dex_method:Lcom/mutangtech/qianji/network/api/saving/b;->f(Lcom/mutangtech/qianji/network/api/saving/a;Lcom/google/gson/JsonObject;)V`；`dex_method:Lcom/mutangtech/qianji/savingplan/ui/deposit/SavingPlanDepositAct$g;->onExecuteRequest(Lcom/mutangtech/qianji/network/api/saving/a;)V`。
- **E16**：`dex_method:Lcom/mutangtech/qianji/savingplan/ui/detail/SavingPlanDetailAct;->h0(Lcom/mutangtech/qianji/savingplan/data/SavingTransaction;)V`；`dex_method:Lcom/mutangtech/qianji/savingplan/ui/detail/SavingPlanDetailAct$c;->onExecuteRequest(Lta/b;)V`；`dex_method:Lcom/mutangtech/qianji/savingplan/ui/detail/SavingPlanDetailAct;->i0(Z)V`；`dex_method:Lcom/mutangtech/qianji/savingplan/ui/detail/SavingPlanDetailAct$d;->onExecuteRequest(Lta/b;)V`。
- **E17**：`dex_class:Lcom/mutangtech/qianji/savingplan/data/SavingPlan;`；`dex_class:Lcom/mutangtech/qianji/savingplan/data/SavingTransaction;`。
- **E31**：`dex_class:Lfg/a;`；`dex_method:Lkg/c;->parseInitData()Z`。
- **E32**：`dex_class:Lcom/mutangtech/qianji/savingplan/deposit/rules/FixedAmountDepositRule;`；`dex_class:Lcom/mutangtech/qianji/savingplan/deposit/rules/AbstractIncreasingDepositRule;`；`dex_class:Lcom/mutangtech/qianji/savingplan/deposit/rules/CustomDepositRule;`，含字段及 calculateAllTransactions/calculateAmount/calculateTotalAmount。
- **E33**：`dex_method:Lkg/c;->a0()Z`；`dex_method:Lkg/c;->startSave()V`；`dex_method:Lcom/mutangtech/qianji/network/api/saving/c;->submit(Ljava/lang/String;Lcom/mutangtech/qianji/savingplan/data/SavingPlan;Lql/d;)Lcom/android/volley/Request;`。
- **E34**：`dex_method:Lcom/mutangtech/qianji/savingplan/ui/submit/SubmitFixedAmountSavingPlanAct;->checkParams()Z`；`dex_method:Lcom/mutangtech/qianji/savingplan/ui/submit/SubmitIncreaseSavingPlanAct;->checkParams()Z`；`dex_method:Lcom/mutangtech/qianji/savingplan/ui/submit/SubmitCustomSavingPlanAct;->checkParams()Z`。
