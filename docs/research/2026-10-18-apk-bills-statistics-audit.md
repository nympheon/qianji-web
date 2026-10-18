# 钱迹 Android 4.5.4 账单金额、退款报销与统计预算复核

- 日期：2026-10-18
- 样本：`qianji_454_1234_gw.apk`，`com.mutangtech.qianji`，4.5.4 / 1234。
- 方法：经用户授权的 MT MCP，只读搜索、Smali、类结构和交叉引用；复用 workspace `rxvx4qt6`。
- 边界：没有登录钱迹账号，没有调用钱迹业务接口，没有修改、构建 APK；未实现业务代码。
- 对照：[主设计](../superpowers/specs/2026-10-18-qianji-workers-design.md)、[冲突分析](2026-10-18-apk-conflict-analysis.md)。

本文中的“已静态证实”指能沿实际调用与条件确认 APK 行为，不表示服务端已实测；“推断”指本项目据此采用的实现方式；“待服务器实测”指 APK 无法单独回答的上游条件。金额举例均为构造的契约向量，不是用户真实数据。

## 1. 结论与设计优先级

可以直接复用 APK 的逐记录统计模型，无须自创“所有类型加减同一金额”“退款统一算收入”“新报销先当支出”等口径。APK 已提供完整的本地计算路径：

```text
dbhelper/m.stat(...)
  → loadStatBills(...)
  → getListByTime(...)
  → m.l(...) 补载退款与已报销关联账单
  → m.processStat(...)
  → BillStatItem.Companion.fromBill(..., forBudget=false, currency)
  → StatSet.copyFromBillStatItem(...)
  → totalIncome / totalSpend / getJieYu

dbhelper/p.listByDateRange(...)
  → 本地 BudgetDao 获取预算配置
  → processBudgetWithBills(...)
  → 按账本与业务期间读取本地 Bill
  → BillStatItem.Companion.fromBill(..., forBudget=true, currency=null)
  → 预算总额、父分类与子分类消耗、日统计
```

**已静态证实：**本轮跟到的统计和预算使用本地数据库、关联账单与保存的币种值计算；不能因为有 `/budget` API 就认为执行进度全部来自服务器报表。APK 的账单列表 `Lpe/b;->b(Bill, Comparator)`、列表组 `Lpe/f;->f(Bill)` 也复用 `BillStatItem`，表明列表合计和统计页应共用一套逐记录转换。

**推断／建议：**在网页与 MCP 共用的领域层移植此计算契约，以完整同步的数据副本和关联记录作为输入。保留原始载荷，逐类型输出统计槽位，再汇总；不要从 UI 展示金额或单个数据库 `money` 字段直接写 SQL 求和。暂缓的应是确实缺少证据的分支与真实写入验收，而非把已证实的普通退款、新报销、预算口径全部继续标成未知。

## 2. 金额主值、优惠与手续费

### 2.1 录入金额不等于持久化 money

**已静态证实：**普通记账保存链为：

```text
Ljd/n0;->x0(JDLjava/lang/String;Ljava/util/Calendar;ZZLjava/util/ArrayList;D
             Ljava/lang/String;LCurrencyExtra;IZLjava/util/ArrayList;)V
  → 计算 finalBillMoney
  → 对应页面 w0(...)
  → Bill.setMoney(finalBillMoney)
  → Bill.setCurrencyExtra(...)
  → Bill.setFlag(...)
  → status=2
  → dbhelper/m.saveOrUpdateBill(...)
  → Lch/c.startPush(...)
```

其中第一个金额参数为录入金额，另一个金额参数为手续费／优惠值 `F`；当 `F != 0` 时先计算 `finalBillMoney = 录入金额 − abs(F)`。非转账、有 CurrencyExtra，且所选资产币种等于 `targetSymbol` 时，用保存的 `targetValue` 替换此主值。不能在保存后或统计时对 `money` 再统一减一次优惠。

普通支出页面 `Lcom/mutangtech/qianji/bill/add/a;->w0(Bill,ZZDD,CurrencyExtra)` 调用 `Loe/b;->processBillAssetForCommon(...)` 后，只在 `F <= 0` 时写 `BillExtra.transfee=F`。因此普通优惠由负 `transfee` 表示；转账／还款的 `Bill.setTransferAsset(...)` 则直接保存传入的 `transfee`。

`Bill.canUseCoupont(I)` 返回 true 的类型是普通支出 `0`、待报销 `5`、转账 `2`、信用卡还款 `3`。这比“所有支出类都支持优惠”更窄：债务利息支出 `10` 不在该谓词中。

**已静态证实的最小例子：**无多币种的普通支出，录入原价 `100`，优惠 `-10`，保存 `money=90`、`transfee=-10`；统计支出 `90`，优惠单独累计 `10`。优惠不是另记普通收入，也不能把支出算成 `80`。

### 2.2 统计币种使用历史保存值

`CurrencyExtra` 持久化三组符号与值：`srcSymbol/srcValue`、`targetSymbol/targetValue`、`baseSymbol/baseValue`。它不只是一个现汇汇率。

**已静态证实：**`Bill.getMoneyForStat(String)` 调用 `getValueFromCurrency(currency, extra)`，命中顺序和规则如下：

| 条件 | 返回值 |
| --- | --- |
| 传入币种为 null | 先取 `Lse/c.getBaseCurrency()`，再依下列顺序匹配 |
| 匹配 `srcSymbol`，`transfee < 0` | `srcValue + transfee` |
| 匹配 `srcSymbol`，`transfee > 0` | `srcValue − transfee` |
| 匹配 `srcSymbol`，手续费为零 | `srcValue` |
| 匹配 `targetSymbol` | `targetValue` |
| 匹配 `baseSymbol` | `baseValue` |
| 无 CurrencyExtra 或没有匹配 | `getValueFromCurrency` 返回 null，外层回退到 `Bill.money` |

这里没有按当前汇率服务重算历史金额。也不能擅自把未命中的币种按现汇补算为“官方口径”；本项目对不支持的统计币种可明确拒绝或暴露币种覆盖不足，但不得无声给出自创结果。APK 的回退行为应作为版本契约记录，不等同于“任意币种转换都正确”。

**已静态证实：**`Bill.getTransFeeForStat(currency)` 在非零手续费、有 CurrencyExtra、传入币种非 null 且不等于源币种、`baseSymbol` 非空、`baseValue>0`、`srcValue>0` 时，返回：

```text
transfee × divide(baseValue, srcValue, scale=10, HALF_UP)
```

其他情况返回原 `transfee`。该函数不单独检查传入币种是否就是 `baseSymbol`；不能擅自替换成“根据任意目标币种使用对应汇率”的更一般算法并声称一致。

### 2.3 币种构造也须按类型复用

**已静态证实：**`CurrencyExtra.buildCurrencyIncomeSpend(...)` 与 `buildTransferCurrency(...)` 分开处理优惠和手续费：

- 普通收支：保存源值；负手续费会从参与目标／本位币转换的源金额中扣去绝对值；再计算目标值和本位值。
- 转账：保存源值；正手续费会在计算转入目标值前扣除；本位值按未扣手续费的源值计算。
- `CurrencyValues$Companion.fixSameCurrencyTransfer(...)` 对类型 `2/3` 且源目标币种相同的记录，调用 `CurrencyConvert.getPreConvertMoney(...)` 修正 `targetValue`。
- `CurrencyConvert.getPreConvertMoney(type, amount, fee)` 只有转账类的正手续费，或非转账类的负优惠，才从 amount 减去相应金额。

**建议修改主设计 8.1、8.2：**显式区分录入金额、实际关联资产金额、按币种保存的历史值、统计主金额、优惠／手续费槽位；输入 Schema 不应把它们压成一个含义不清的 `amount`。保留精确十进制是本项目的数据保护选择，不应表述为 APK 自始至终使用精确十进制：APK 模型使用 `double`，`Lza/j` 的加减乘通过 `BigDecimal.valueOf(double)`，除法固定 10 位 HALF_UP，结余 `StatSet.getJieYu → Lza/j.k` 另做两位 HALF_UP。实现应核对这些显式舍入点，不给每个中间值统一四舍五入到两位。

## 3. 可直接移植的统计槽位

证据核心：`Lcom/mutangtech/qianji/data/model/BillStatItem$Companion;->fromBill(Bill,Z,String)`。设 `M=getMoneyForStat(currency)`、`R=getTotalRefundMoneyStat(currency)`、`B=getTotalEDBaoxiaoMoneyStat(currency)`。

| 类型／条件 | 已静态证实的转换 |
| --- | --- |
| `isAllSpend`：类型 `0`、`10` | 默认 `spend=M`；`R>0` 时用 `M−R`，正数进 spend，非正数的绝对值进 refundIncome、spend 为零 |
| `isAllIncome`：类型 `1`、`11` | 默认 `income=M`；`R>0` 时用 `M−R`，正数进 income，非正数的绝对值在允许计数时进 refundSpend、income 为零 |
| 待报销 `5`，尚未报销 | `bxValue=max(M−R,0)`（R>0 才减）、`bxValueOriginal=M`、`notBxedValue=bxValue`；未报销本金不进入总支出 |
| 待报销 `5`，`hasBaoXiaoedCompat=true` | `hasBxedValue=B`；对扣退款后的值再减 B，正数且允许计数时进 bxSpend，非正数且允许计数时绝对值进 bxIncome |
| 转账 `2` | `transfer=M`，不直接加入普通收入／支出 |
| 信用卡还款 `3` | `creditHuankuan=M`，不直接加入普通收入／支出 |
| 退款 `20` | `refundValue=M`，不直接变成普通收入 |
| 已报销 `21` | `edBaoxiaoValue=M`，不直接变成普通收入 |
| 手续费 `F>0` | 允许计数时 `transferFee=F`，会进入总支出 |
| 优惠 `F<0` | 允许计数时 `coupon=abs(F)`，单独汇总，不再加入总收入／支出 |

`isAllSpend` 和 `isAllIncome` 的实例方法只转调相应静态谓词；债务本金 `6/7`、收款／还款 `4/9` 不属于这些普通收支集合。组合报销 `22` 在本轮核心 `fromBill` 中没有上述普通收支分支；第14节已补查其作为列表聚合对象的构造与展开，不能因其名字把它当成新的收入或支出。

**已静态证实：**`BillStatItem.getTotalSpend()` 是 `spend + bxSpend + transferFee + refundSpend`；`getTotalIncome()` 是 `income + bxIncome + refundIncome`。`StatSet.copyFromBillStatItem` 将槽位分别累加，优惠、退款原值、已报销入账原值、转账本金、信用卡还款本金各有独立累计字段。`StatSet.totalSpend/totalIncome` 另外保留债务利息槽位；不能把所有独立展示项再加回总收支造成重复统计。

**推断／建议：**完整移植逐记录模型，再按页面需要显示总收支、待报销、已报销、退款、转账、还款、优惠。主设计 8.2 的“退款、报销按真实关系统计”可落到这里的具体公式，避免依赖口头描述的经济含义。

### 3.1 两个排除标记不是同一个开关

**已静态证实：**`BillExtra.FLAG_NOT_COUNT=1`、`FLAG_NOT_BUDGET=2`，均为位标记。`fromBill(..., forBudget=false, ...)` 使用 `!isNotCount()`；`forBudget=true` 使用 `!isNotBudget()`。因此不计收支仍可计预算，不计预算仍可计收支。函数同时记录排除金额槽位供展示。

**需保留的版本边界：**普通支出退款超过本金时，`refundIncome` 先设置，随后不计数分支只清零 spend；这条分支没有再清零 refundIncome。收入和待报销的相应退款超额分支则有允许计数判断。不要在尚未对照该边界前写一个“排除标记统一让整条统计为零”的泛化规则；应把该差异放入 APK 对照向量。是否在本项目复现、明确展示异常或由服务端限制避免这种数据，待真实可达性验证，不臆造为业务必然。

## 4. 退款与新旧报销的关系及时间归属

### 4.1 父子关系以实际账单补载

**已静态证实：**`dbhelper/m.l(List, filter, ZZZ)` 对每条账单先执行：

1. `getRefundBillIds → m.s(ids) → findByBillId`，填入 `Bill.refundBills`。
2. 开启对应参数时，`getEDBaoXiaoBillIds → m.s(ids)`，填入 `Bill.baoxiaoEdBills`。
3. 随后应用外部筛选回调、分类与展示层次等。

`m.s` 按子账单 ID 逐条本地查询，没有添加主查询的日期区间。`Bill.getTotalRefundMoneyStat`、`getTotalEDBaoxiaoMoneyStat` 再逐条调用子记录的 `getMoneyForStat(currency)` 求和，不直接把父扩展映射中的数值当成所有币种的统计总额。

`m.processStat` 以当前主记录的 `getTimeInSec()` 分到日、月、年；分类统计 `m.D/m.g` 以主记录的分类和父子分类聚合。退款／已报销子记录自己仍保留发生时间和独立金额槽位。

**由上述完整调用链静态证实：**普通源支出在一月、退款在二月时，一月查询加载源记录后仍补载二月退款，源月支出会减少；二月的退款记录本身只增加独立退款槽位，不直接增普通收入。新报销残差同样由源待报销记录及其时间承担。不能自创“一律在退款／报销到账月冲减当月普通支出”的口径。

**推断／建议：**按需回拉跨期退款、报销或删除后，失效范围必须包括源账单的历史期间、原分类、关联预算；只失效子记录发生月会留下错误历史统计。需要保持全量关联记录完整；缺失子记录时不能把缺失误认为金额零而宣称官方一致。

### 4.2 旧字段与新字段不可压平

**已静态证实：**`BillExtra` 使用序列化名 `rfds` 保存新退款映射，旧字段为 `refundid/refundv`；新报销映射为 `bxs`，子记录有 `baoxiaoSourceBillId`；旧报销还包含 `baoxiaoed/baoxiaov/baoxiaotime` 等字段。

- `getRefundBillIds()`、`getTotalRefundMoney()` 优先使用非空 `rfds`；否则在旧退款 ID 与金额均为正时回退旧字段，二者不是无条件相加。`getRefundCount()` 的条件另有差异：`rfds != null` 就直接返回其 size；旧回退检查 `refundMoneyOld>0` 与 `refundSourceBillId>0`，并非前两个 getter 的 `refundBillIdOld`。旧数据的次数边界必须分别核对，不能写一个统一兼容助手替代三者。
- `getBaoxiaoedMoneyCompat()` 优先 V2 映射，再回退旧报销；旧金额为负时 `getBaoxiaoedMoneyOld()` 回退 `Bill.money`。
- `getRealMoney()` 先按源币种取得统计值，减父扩展的总退款值，只在 `hasBaoXiaoedV2()` 为真时再减兼容报销金额；旧报销不会自动进入此扣减分支。
- **统计使用的** `getTotalEDBaoxiaoMoneyStat()` 在没有 V2 报销时直接返回零，即使 `hasBaoXiaoedCompat()` 能识别旧标记。不能把显示／兼容 getter 偷换成统计函数。
- `m.l` 还有 `Lhb/a.isBaoxiaoCompatUser()` 专用兼容分支；它是一个硬编码账号判断，不是通用“所有旧账号”的规则，不应搬成网页版通用模型。

**待服务器实测：**旧报销升级后服务器如何改写源记录、子记录、旧字段及历史报表；升级是否可逆；非升级旧数据真实显示与上述本地统计函数的组合。当前可以确实实现新模型，同时保留旧记录识别、展示和能力状态，不能自动调用 `upgradev2` 或把所有旧报销转换成普通收入。

### 4.3 退款创建和编辑用官方 refund2 用例

**已静态证实：**

```text
Lud/m.startSave → I0(amount)
  → RefundPresenterImpl.submit(sourceBill, existingRefund?, ...)
  → network/api/bill/d.refund(sourceId, json, callback)
  → /bill/refund2（did=源账单，v=JSON）
  → RefundPresenterImpl$a.onExecuteRequest
  → isSuccess 后保存返回的整组账单
  → Loe/c.processRefundAsset(oldRefund?, returnedRefund, asset)
```

载荷有 `money/time`，编辑时带既有退款 `billid`，可带 `assetid/remark/currency/images/tags`；`currency` 在该 JSON 中是由 `CurrencyValues` 再序列化的字符串，不能仅凭名字假设直接内嵌对象。成功分支取返回账单列表索引 1 作为退款记录，保存整个列表，说明源与子关系由该专用接口维护。网页版不应自行创建普通收入账单来代替退款，也不应只改父 `rfds` 并跳过官方用例。

`Lud/m.startSave` 对未输入正金额的新退款尝试以剩余金额作为默认值；仍不为正则拒绝。已看到的此方法没有把所有显式正金额强制限制为“小于剩余”，统计也具有超额退款处理。因此不能从“部分退款”名称臆造全局 `refund <= remaining` 上限。服务端是否另有限制仍需验证。

### 4.4 退款与类型操作的边界

**已静态证实：**

- `Bill.isSupportRefundType()` 仅普通支出 `0` 和待报销 `5`；`Bill.isSupportBaoxiaoType(I)` 仅普通支出 `0`。
- 详情入口 `Ltd/u.h1` 拒绝为其他用户的账单继续退款；已有退款且 `getRefundCount() >= 25` 时拒绝继续新增。不是只有一个“最多退款 25”未使用的常量。
- `Ljd/n0.x0` 编辑原账单时，若原账单有退款且请求类型与原类型不同，直接提示并返回；之后的普通支出／待报销转换还受是否已有报销约束。
- `Ltd/u.c1` 对退款走专门退款编辑页，普通收支、待报销、转账、还款走普通记账编辑，债务本金走债务页面；不能把所有类型开放给同一个任意字段编辑器。

**待服务器实测：**25 次限制是否同时由服务器强制；其他用户账单在各种共享账本权限下的实际可写性；编辑退款时清空备注、图片、标签的专用载荷语义。当前“空值不传”的 APK 代码不证明“空数组一定表示清空”。

## 5. 批量报销、取消与删除应复用官方操作语义

### 5.1 批量报销不是任意均摊

**已静态证实：**`BxPresenterImpl.doBaoXiao(Set, AssetAccount, D, Calendar, CurrencyExtra, ...)`：

1. 将选中源账单按 `Bill$SortByTimeComparator.asc()` 排序；业务时间相同时继续用 `Bill.a(Bill)` 返回的 `billid` 比较，不能任意依赖 Set 的遍历顺序。
2. 非末笔用 `max(getRealMoney(), 0)` 与尚余报销额取较小者；末笔承接剩余报销额。
3. 无币种扩展时按源账单 ID 构造 `{ money: allocated }`；有币种扩展时按输入的源／目标／本位比例分配，构造 `{ curr: CurrencyExtra }`，末笔承接三个币种剩余值。
4. 将该映射序列化为 `v`，调用 `/baoxiao/baoxiao`；`did` 在此用例中是报销入账资产 ID，不是退款接口的源账单 ID。
5. `BxPresenterImpl$a.onFinish` 只在成功回执下应用 `network/api/bill/b.inAsset` 与 `billList`，再刷新本地展示。

**建议：**批量报销的默认分配沿用此时间升序与末笔余数规则，不自创按比例均摊；用户若提供明确逐笔分配，需要另核对上游能否接受相应映射。三币种分配的舍入与末笔余数必须进契约。末笔可能超过其剩余本金的静态算法分支不等于服务端保证接受超报销。

### 5.2 取消报销保留“待报销”类型

**已静态证实：**`BxPresenterImpl.unBaoXiao` 将源账单 ID 数组放入 `/baoxiao/cancelbaoxiao` 的 `v`；成功回调 `BxPresenterImpl$d` 才调用 `j(Set)`。后者遍历 `bxs`，回滚关联资产、标记关联入账子账单删除，调用 `Bill.undoBaoxiao()` 清空 `bxs` 并保存源记录；该方法没有把类型 `5` 改成普通支出 `0`。所以取消报销与取消“待报销”属性不是同一操作。

链尾还调用 `m.deleteBaoxiaoEdBills(Set)`；但 `j` 前面已对同一对象清空 `bxs`，不能据此函数名断言这一调用一定物理删除了全部子记录。已确认的主要效果是先遍历原映射标记子记录删除，实际拉取后状态和服务器删除集合需实测核对。

### 5.3 删除是关联操作，不能只删一行

**已静态证实的当前入口：**

```text
Loe/c.deleteSingleBill(Bill, source)
  → 逐类型分派资产回滚
  → 对退款/已报销子记录：a(Bill) 回滚资产 + b(Bill) 清理源关系
  → 对支持子记录的源记录：a(Bill) 回滚自身资产 + c(Bill) 处理关联子记录
  → k(Bill, source)：status=0，saveOrUpdateBill，发送本地删除事件
```

- `b(Bill)` 找到对应源账单，移除退款映射及／或报销映射中的子 ID；清理旧退款字段，保存源记录。
- `c(Bill)` 遍历 `rfds`、旧退款字段和 `bxs`，调用 `handleDeleteSingleSubBillByDeleteSource`；该助手按子账单实际关联资产币种选择保存金额，回滚资产并把子账单 `status=0`，最后批量保存受影响资产。
- 源记录支持子记录的谓词 `supportSubBill()` 也是普通支出／待报销，不是所有账单类型。

**建议修改主设计 2、7、8：**删除操作日志至少记录源 ID、关联子 ID、受影响资产及统计期间；正式成功用官方回执／回拉核对整组关系。迁移 APK 逻辑时不能把界面列表删除等同于物理删除 D1 一行，也不能在未知写入结果下自行重建子记录补偿。

**旧模型边界：**`b(Bill)` 在 `hasRefund()` 为真后直接访问 `refundExtras.remove`，没有在该处单独检查新映射是否为 null；只凭旧字段也可令 `hasRefund()` 为真。因此不能把该分支机械移植为“旧退款安全清理已经完全解决”的证明；应以服务器下发的真实旧数据形态补做核验，保留明确的空映射处理。

## 6. 资产本地更新：APK 有实际算法，但本项目不能冒充云端结果

**已静态证实：**APK 的资产不是每次都等待全量回拉后才变化。

- 普通新增／编辑：`bill/add/a.w0 → Loe/b.processBillAssetForCommon` 比较旧资产、旧金额与新资产、新金额，回滚旧额再应用新额，写本地资产；普通支出和待报销扣余额，收入加余额。保存账单与启动 push 在之后发生。
- 退款成功：`RefundPresenterImpl$a` 保存接口返回的账单组，然后调用 `Loe/c.processRefundAsset`。新增给所选资产增加退款入账金额；编辑同资产应用差额，换资产回滚旧资产再加新资产。金额助手 `Loe/c.h` 优先保存的目标币种值。
- 报销成功：`BxPresenterImpl$a` 直接保存服务端返回的 `inAsset`，并保存 `billList`。应优先应用该完整资产回执，不再额外加一次报销金额。
- 删除：按前节逐类型回滚；取消报销在服务器成功后再本地回滚。

**推断／建议：**本项目保持“上游为权威”和“待提交记录不冒充已确认账务”合理，但不要归因成“APK 也没有本地资产变化”。可以移植 APK 算法形成可测试的预期结果；正式副本优先采用专用接口的资产回执和针对性回拉。若提供待同步预览，应清楚带状态并避免和已确认余额混算。不能把同一资产既应用官方 `inAsset` 又应用本地金额增量。

## 7. 预算与日期期间

**已静态证实：**`dbhelper/p.processBudgetWithBills` 使用 `fromBill(..., true, null)`，因此预算排除看 `FLAG_NOT_BUDGET`；币种默认采用本位币。普通收支统计的 `FLAG_NOT_COUNT` 不能顺手代替预算开关。

- 转账／信用卡还款仅其 `getTotalSpend()` 进入总预算，即通常只有正手续费；本金不进入预算。
- 普通支出、债务利息支出、待报销使用同一逐记录模型计算预算消耗；未报销待报销本金不因此自行计入。
- 子分类消耗同时累加子分类及父分类的 `BudgetUsed`；总预算独立累加一次，不能再把父子分类消耗相加当总额。
- 正消耗才加入 used；排除预算金额另保存 `totalNotBudget`；`count` 与 used 不完全相同，不能从 used 是否大于零自行重建记录数。

`dbhelper/m.getTimeRangeInSec(DateFilter, BookConfig)` 对月筛选取 `BookConfig.getStartOfMonth()`，缺配置时为 1；构造所选年／月的该日零时，结束为下个月同日起点减 1 秒。非月筛选使用 DateFilter 自带范围。实现用 `Calendar.getInstance()`，没有硬编码 `Asia/Shanghai`；主设计的上海时区是本项目已选默认值，应与 APK 设备时区区分陈述。

**建议：**8.2 补充“预算复用同一逐记录模型但使用独立 flag”，以及父子分类只聚合一次的规则。保留服务器预算配置；不能仅从预算配置 API 返回体推断客户端全部执行进度。29/30/31 日的跨月、闰年、月起日配置有效范围与 Calendar 宽松日期处理仍需用已观察的合法配置和官方 UI 对照，不自创日历截断规则。

## 8. 应加入后续契约的向量

这些是基于本轮可见方法的预期，不是已经运行的业务测试；以下表不提供测试代码。

| 向量 | 预期或需观察边界 |
| --- | --- |
| 普通支出原价100、优惠-10、无币种扩展 | 保存 money=90；统计支出90、coupon10；不重复扣优惠、不算普通收入10 |
| 转账录入103、手续费3、无币种扩展 | x0 保存主值100、transfee3；转账本金独立100，总支出只含手续费3；已补查转出-103、转入+100，见第12节 |
| 支出保存 src USD100、fee=-10、base CNY630、target CNY630 | USD统计90，CNY统计630；非源币种费用函数输出-63，不能自行改为-70 |
| 同一符号同时命中 src/target/base | 取 src 分支优先；依次验证 fee<0、=0、>0 |
| 请求币种不在三组值中 | getMoneyForStat 回退 Bill.money；产品不能假装做了目标币种精确换算 |
| 一月支出100、二月退款30 | 一月支出70；二月退款独立30，普通收入0；后续删退款使一月恢复100 |
| 一月支出100、二月退款130 | 一月 spend0、refundIncome30；二月 refundValue130；服务器是否允许另实测 |
| 上述超额退款再设置 NOT_COUNT 或 NOT_BUDGET | 逐路径验证普通支出分支 refundIncome 保留差异，不套统一排除公式 |
| 待报销100、无已报销 | notBxed100、总支出0；分别切换两个独立 flag |
| 待报销100、退款20、已报销入账70 | bxValue80、hasBxed70、bxSpend10；残差归源记录期间 |
| 待报销100、已报销120 | bxIncome20；到账记录自身 edBaoxiaoValue120，不重复普通收入120 |
| 旧 baoxiaoed=1、baoxiaov=-1，无bxs | 兼容金额回退money，但 getTotalEDBaoxiaoMoneyStat=0；升级与官方显示要独立验收 |
| rfds与旧refundid/refundv同时存在 | 非空rfds优先，不能相加；空映射再走旧字段回退 |
| 两笔待报销时间不同、剩余额各50，批量报销120 | 按时间升序，首笔50、末笔70；是否允许超额由服务器验证 |
| 多币种批量报销三笔含小数 | 三组值按比例分配、末笔承接各自余数；核对10位除法舍入与最终值 |
| 24、25条既有退款，再新增 | 24可进入；25被入口拒绝；旧字段与空rfds的计数条件分别核对 |
| 带退款的源账单改type | x0在保存前拒绝；不自动删关系或转普通收入 |
| 单删退款、单删已报销、删除带二者的源记录 | 回滚对应资产、清关系、子记录status0；核对源和子上送／回拉，不只检查目标ID消失 |
| 取消报销 | 源类型5保留、bxs清空、入账资产回滚、关联子记录删除状态；不转换为普通支出 |
| NOT_COUNT=1、NOT_BUDGET=0，及反向组合 | 普通统计与预算可分别排除，不互相代替 |
| 子分类支出100，父子都设置预算 | 父分类used100、子分类used100、总预算100；不变成200 |
| 月起日25，选择十月 | 起点十月25日零时，终点十一月25日零时前一秒；与官方合法配置对照 |
| 退款／报销返回失败或结果未知 | 不因 UI onFinish 布尔值或 HTTP 完成而宣称已写入；按业务isSuccess及回拉核验 |

## 9. 对主设计的具体改写建议

| 条款 | 建议 |
| --- | --- |
| 2 功能范围：普通账单、退款报销、预算、统计 | 加入已证实的类型前提、退款25次入口限制、已有退款禁止切类型；专用退款/报销用例，逐项验收服务器约束 |
| 3.2 静态证据 | 增加 BillStatItem/StatSet/dbhelper m 与 p 的本地计算链，以及金额保存 x0 的证据；不要停留在API存在 |
| 6.1 写后缓存失效 | 退款/报销/删除影响源记录历史期间、分类、预算和相关资产；不能只刷新当前月 |
| 7 写入与核查 | 普通同步整笔上送与退款/报销专用接口分开；利用返回的完整账单组和inAsset；记住取消/删除的关联集合 |
| 8.1 金额 | 明确money不是统一“原价”；保留三币种历史值、transfee符号、显式舍入点；现有精确数字策略保留 |
| 8.2 统计 | 以本文件槽位和公式替换可确定部分的临时未知口径；旧模型、异常分支与未知类型保留证据边界 |
| 8.2 预算 | 独立NOT_BUDGET，转账本金不计、手续费可计；父子分类消耗防重复；与同一BillStatItem复用 |
| 11 验收 | 加入本文件向量，尤其跨期、超额、双flag、批量分配、历史币种与关联删除；不要只验普通收支整数样例 |
| 12 研究问题 | 细分为旧报销升级、服务器金额/次数限制、空值清除载荷、专用接口响应丢失；新模型本地统计已不全是未知 |

## 10. 仍缺少的证据

1. **待服务器实测：**退款/报销创建与编辑的真实完整响应，是否保证返回列表顺序、整组记录和资产回执；部分失败和响应丢失后的可查询性。
2. **待服务器实测：**超额退款／超额报销、次数限制、共享账本角色的服务端约束，不能把客户端入口限制冒充服务端合同。
3. **待服务器实测：**旧报销升级、旧新混存、取消后同步回执与物理删除的完整表现；本轮没有自动迁移账号。
4. **已补查静态链，待服务器实测：**转账／信用卡还款保存页面的资产侧金额、借贷本金、偿还与利息分派和上送载荷见第12、13节；剩余为服务端余额与回执、图片等分支的真实核对，不再把可读 APK 公式列为未知。
5. **组合报销22的静态展示链已补查，见第14节。待历史数据与服务器实测：**旧版本异常字段、缺失子记录、已删除子记录仍被父映射引用时的完整收敛；不把“找不到子记录跳过”包装成正确零金额。
6. **待官方 UI 对照：**自定义月起日29/30/31、闰年、非上海设备时区与显示期间；本轮只确认 Calendar 与配置调用链。

所有本轮结论均不改变已完成的冲突研究：`conf_ids` 的客户端分支是重新分配账单 ID，不能从中推导退款/报销仲裁或多端编辑“版本过旧”。

## 11. 关键证据定位索引

下列引用可直接作为 MT `dex_method:` locator 的主体复查；父子关系字段引用可在 `BillExtra` 的类结构中取得。研究缓存使用临时目录 `qianji-requirements-20261018` 下的 `audit-` 前缀，不是项目运行依赖。

```text
Lcom/mutangtech/qianji/data/model/Bill;->getMoneyForStat(Ljava/lang/String;)D
Lcom/mutangtech/qianji/data/model/Bill;->getValueFromCurrency(Ljava/lang/String;Lcom/mutangtech/qianji/data/model/BillExtra;)Ljava/lang/Double;
Lcom/mutangtech/qianji/data/model/Bill;->getTransFeeForStat(Ljava/lang/String;)D
Lcom/mutangtech/qianji/data/model/Bill;->getTotalRefundMoneyStat(Ljava/lang/String;)D
Lcom/mutangtech/qianji/data/model/Bill;->getTotalEDBaoxiaoMoneyStat(Ljava/lang/String;)D
Lcom/mutangtech/qianji/data/model/Bill;->getRealMoney()D
Lcom/mutangtech/qianji/data/model/Bill;->canUseCoupont(I)Z
Lcom/mutangtech/qianji/data/model/BillExtra;->getRefundCount()I
Lcom/mutangtech/qianji/data/model/BillStatItem$Companion;->fromBill(Lcom/mutangtech/qianji/data/model/Bill;ZLjava/lang/String;)Lcom/mutangtech/qianji/data/model/BillStatItem;
Lcom/mutangtech/qianji/data/StatSet;->copyFromBillStatItem(Lcom/mutangtech/qianji/data/model/BillStatItem;)V
Lcom/mutangtech/qianji/data/StatSet;->totalIncome()D
Lcom/mutangtech/qianji/data/StatSet;->totalSpend()D
Lcom/mutangtech/qianji/data/db/dbhelper/m;->l(Ljava/util/List;Lcom/mutangtech/qianji/data/db/dbhelper/m$h;ZZZ)Ljava/util/List;
Lcom/mutangtech/qianji/data/db/dbhelper/m;->processStat(Landroid/content/Context;Lcom/mutangtech/qianji/filter/filters/DateFilter;Ljava/util/List;JJLjava/lang/String;)Lrg/g;
Lcom/mutangtech/qianji/data/db/dbhelper/p;->processBudgetWithBills(Ljava/lang/String;JLjava/util/List;Lcom/mutangtech/qianji/filter/filters/DateFilter;ZLcom/mutangtech/qianji/data/model/BookConfig;)Lcom/mutangtech/qianji/network/api/budget/b;
Lcom/mutangtech/qianji/data/db/dbhelper/m;->getTimeRangeInSec(Lcom/mutangtech/qianji/filter/filters/DateFilter;Lcom/mutangtech/qianji/data/model/BookConfig;)[J
Ljd/n0;->x0(JDLjava/lang/String;Ljava/util/Calendar;ZZLjava/util/ArrayList;DLjava/lang/String;Lcom/mutangtech/qianji/data/model/CurrencyExtra;IZLjava/util/ArrayList;)V
Ltd/u;->h1(Ltd/u;Landroid/view/View;)V
Lud/m;->startSave()V
Lcom/mutangtech/qianji/bill/baoxiao/BxPresenterImpl;->doBaoXiao(Ljava/util/Set;Lcom/mutangtech/qianji/data/model/AssetAccount;DLjava/util/Calendar;Lcom/mutangtech/qianji/data/model/CurrencyExtra;Ljava/lang/String;Ljava/util/List;Ljava/util/List;)V
Lcom/mutangtech/qianji/bill/baoxiao/BxPresenterImpl;->j(Ljava/util/Set;)Z
Loe/c;->deleteSingleBill(Lcom/mutangtech/qianji/data/model/Bill;Ljava/lang/String;)Z
Loe/c;->b(Lcom/mutangtech/qianji/data/model/Bill;)V
Loe/c;->c(Lcom/mutangtech/qianji/data/model/Bill;)V
Loe/c;->handleDeleteSingleSubBillByDeleteSource(Ljava/util/HashMap;JD)V
Loe/c;->processRefundAsset(Lcom/mutangtech/qianji/data/model/Bill;Lcom/mutangtech/qianji/data/model/Bill;Lcom/mutangtech/qianji/data/model/AssetAccount;)V
```

## 12. 补查：转账与信用卡还款保存的完整资产链

本节关闭原第10.4项中的静态缺口。以下均已沿实际保存入口、资产助手、账单同步载荷核对。

### 12.1 两种类型共用保存页面与校验

```text
bill/transfer/f.H0(CompoundButton, checked)
  → checked=true 设 type=3；false 设 type=2
  → f.x0(...)
  → 公共 Ljd/n0.x0(...)
  → f.w0(...)
  → Loe/b.processBillAssetForTransfer(...)
  → Bill.setTransferAsset(...)
  → 公共 x0 保存money/curr/flag/status=2
  → dbhelper/m.saveOrUpdateBill
  → Lch/c.startPush → Lgh/a → /bill/syncall
```

**已静态证实：**`transfer/f.x0` 要求转出与转入资产都存在、ID不同，且两者都不能是 `AssetAccount.isDebtLoan()`。失败时提示并直接返回，不进入公共保存。`isDebtLoan()` 的判定是资产 `type=5`；债务资产不能借用普通转账用例。`f.w0` 在无需分类时清理分类，并将公共 `x0` 算出的最终主值、手续费、CurrencyExtra、是否编辑传入同一个资产助手；信用卡还款不是另造两笔普通收支。

### 12.2 资产公式

令 `M` 为传给资产助手的最终主值（普通无币种情形即录入额减手续费／优惠绝对值），`F` 为带符号手续费。`Loe/b` 的方法逐层确认如下：

| 方法 | 返回值／作用 |
| --- | --- |
| `__get_transfer_asset_money_from_inner(M,F)` | `M + F`（F>0），否则 M；表示转出所需金额 |
| `b(M,F)` | 前项取负，即新转出资产增量 |
| `__get_transfer_asset_money_target_inner(curr,M,F)` | 有curr直接取 `targetValue`；无curr且F<0取 `M+abs(F)`；否则M |
| `c(M,curr,F)` | 前项，即新转入资产增量 |
| `__get_transfer_asset_money_from_old(Bill)` | 按旧money与旧fee取转出金额，正值用于回滚旧转出 |
| `__get_transfer_asset_money_target_old(Bill)` | 按旧curr/旧money/旧fee取转入金额的负值，用于回滚旧转入 |

`processBillAssetForTransfer` 在编辑时先将旧转出与旧转入回滚值放进一个以资产 ID 为键的 HashMap，再加入新转出与转入增量；`d(HashMap, id, delta)` 对相同资产累计。最后每个资产只加一次合并后的增量并保存。这能处理编辑前后资产重叠、交换方向等情形，不能照着界面先后修改两个对象而重复计算。

`Bill.setTransferAsset(from,target,F)` 保存 `fromid`、`targetid`、显示名称、`descinfo` 与 `extra.transfee`。资产保存后，公共 `x0` 再设账单money和currency等字段。新增信用卡还款时（`isEdit=false` 且 type3），仅在本次账单时间大于目标资产 `lastPayTime` 时更新该时间；编辑不执行这一分支。

**已静态证实的向量：**

| 录入／场景 | 账单保存与资产变化 |
| --- | --- |
| 同币种无费用，输入100 | money100；转出-100、转入+100 |
| 正手续费3，输入103 | money100、fee3；转出-103、转入+100；普通总支出只含费用3 |
| 优惠-10，输入100，无curr | money90、fee-10；转出-90、转入+100；优惠槽位10 |
| 有curr，最终主额100、fee3、targetValue720 | 转出-103，转入+720；转入不再自行按现汇算一次 |
| 原A→B本金100，改A→C本金120，无费用 | A净增量-20，B-100，C+120 |
| 原A→B100，改B→A100，无费用 | A+200、B-200；按ID合并后各写一次 |
| 新type3时间比目标lastPayTime早 | 更新余额但不把lastPayTime向后改旧 |

### 12.3 删除与载荷

**已静态证实：**`Loe/c.deleteSingleBill` 对 `Bill.isAllTransfer(type)`（2、3）调用 `f(Bill)`：旧转出资产加回 `__get_transfer_asset_money_from_old`，旧转入资产加 `__get_transfer_asset_money_target_old`（负数）；然后通用 `k` 标记账单status0。删除方法没有回退信用卡 `lastPayTime` 的分支，不能自行承诺它会自动恢复“上一笔还款时间”。

同步使用 `Bill.toSyncJson()` 的整笔记录：包括 `id/bookid/time/type/money/status/createtime/updatetime/assetid/fromid/targetid/extra` 等原始字段；`extra` 内含 `transfee/curr/flag`。`toSyncJson` 移除 `category/fromact/targetact/paytype/bookname` 展示字段；transient 的关联展示列表不序列化。

`Lgh/a.e` 将删除状态ID放入 `dellist`，需同步记录调用 `toSyncJson` 放入 `changelist`；`Lbh/a.getKey()` 为 `bills`；`Lgh/a.a` 构造：

```json
{"bills":{"changelist":["整笔账单对象"],"dellist":["删除账单ID"]}}
```

此处仅示意容器结构；APK 的账单对象和 ID 实际是 JSON 对象／数字，网页版须按已定无损规则保持整数，不把示意中的字符串当成实际 wire schema。外层 `network/api/bill/d.syncAllV2` 使用 `/bill/syncall`，参数为 `uid` 和 JSON字符串 `v`，并不是转出与转入两笔独立写入。

**建议更新主设计：**转账／还款的完整静态规则已可成为共享领域契约；加上资产存在、ID不同、债务资产禁用、编辑按ID合并、lastPayTime单调更新及删除不自动回退的边界。云端实际余额、费用限额、账本权限及异常回执仍做真实验收，不能因此继续把上述本地算法列成未知。

## 13. 补查：借贷本金、偿还与利息的分派及载荷

### 13.1 专用页面决定类型

**已静态证实：**`LoanPayAct` 使用当前债务资产 `N0`、关联实际收付款资产 `Q0`、本金 `S0`、利息 `T0`、追加标记 `O0`、可选既有本金账单 `P0`。资产模型 `isDebt()` 检查 stype51，`isLoan()` 检查 stype52，`isDebtLoan()` 检查type5。新操作只允许债务资产的追加或偿还入口；既有本金账单编辑入口 `start(Context,Bill)` 只接收type6/7。

`LoanPayAct.E0` 的类型决策和保存链：

| 操作条件 | 本金记录 | 另生利息记录 |
| --- | --- | --- |
| 借入债务资产，追加本金 `q0=true` | type6，money=P | 此入口不录利息 |
| 借出债权资产，追加本金 `q0=true` | type7，money=P | 此入口不录利息 |
| 借入债务资产，偿还 `t0=true` | type9，money=P（P>0才生成） | type10，money=I（I>0才生成） |
| 借出债权资产，收回 `t0=true` | type4，money=P（P>0才生成） | type11，money=I（I>0才生成） |
| 编辑既有type6/7本金 | 保持原ID和类型，更新金额、备注、时间、图片、关联资产与status2 | 编辑入口隐藏利息，不自动另生利息 |

`q0()` 是 O0=true 且当前为债务资产；`t0()` 是 O0=false 且当前为债务资产；`s0()` 是存在P0。`E0` 对新增追加要求P>0；偿还／收款允许P和I之一为正，因此可只录利息。它检查两笔金额的绝对值不得大于 `9,999,999,999`（`Lpk/d.isMoneyTooLarge`），并要求已选择账本、图片准备完成。

**已静态证实的溢出处理：**`LoanPayAct.G0(amount, ...)` 先取绝对值；偿还入口当输入本金超过当前债务余额绝对值时，将本金钳制为当前余额绝对值，把超出值交给 `F0` 作为利息。`F0` 在追加或既有本金编辑时隐藏利息，不更新利息额。这是可直接复用的“偿还总输入超过本金时拆利息”规则，不能简单拒绝超额或把超过本金部分继续减少债务余额。

选关联收付款资产的 `LoanPayAct.y0(dialog, asset)` 拒绝非本位币资产，保留原选择；该债务页面没有沿用普通跨币种转账的 CurrencyExtra 处理。不能把普通转账支持多币种直接扩展为借贷页面也支持。

### 13.2 资产 ID 的含义随类型改变

以下由 `Bill.setZhaiwuCurrentAsset`、`setZhaiwuAboutAsset` 及对应 `get...AssetId` 双向核对，D为债务对象，A为实际出入账资产；未选关联资产时使用-1：

| type | 业务 | 债务对象D所在字段 | 实际收付款资产A所在字段 |
| --- | --- | --- | --- |
| 6 | 借入本金 | assetid | targetid |
| 7 | 借出本金 | assetid | fromid |
| 9 | 归还借入本金 | assetid | fromid |
| 4 | 收回借出本金 | assetid | targetid |
| 10 | 借入的利息支出 | fromid | assetid |
| 11 | 借出的利息收入 | fromid | assetid |

因此通用账单处理器绝不能把每条债务相关记录的 `assetid` 都理解为债务对象，也不能把 `fromid` 永远当实际出款账户。利息使用 `assetid=A`，这也解释了其普通收支统计与普通删除资产回滚可以共用现有路径。

`processZhaiwuBillDescInfo` 按此业务方向构造名称与descinfo；这些显示文本不能替代ID关系，且fromact/targetact会在上送时去掉。

### 13.3 本金、余额与 LoanInfo 的实际更新

设D当前余额为C、LoanInfo累计本金为T、累计已偿还本金为A，当前操作本金为P，编辑旧本金为Pold。`Loe/c.processZhaiwuCurrentAssetData(type,P,D,Pold)`：

| type | 已静态证实的债务对象更新 |
| --- | --- |
| 6 | delta=P−Pold；T'=T−delta；余额 `min(T'+A,0)` |
| 7 | delta=P−Pold；T'=T+delta；余额 `max(T'−A,0)` |
| 9 | 余额 `min(C+P,0)`；已还本金 `A+abs(P)` |
| 4 | 余额 `max(abs(C)−P,0)`；已还本金 `A+abs(P)` |

type6/7在缺LoanInfo时使用可见代码的零默认值，不能据此推定缺元数据的历史资产都能安全编辑；正常对象应保存与读取完整LoanInfo。本金偿还不将利息加入LoanInfo.totalpay。

`Loe/c.processZhaiwuAboutAssetData(type,P,I,newAsset,Pold,oldAsset)` 对实际资金资产更新：

- type6：新资产 +P；编辑旧关联资产 −Pold。
- type7：新资产 −P；编辑旧关联资产 +Pold。
- type9：所选资金资产 −(P+I)。
- type4：所选资金资产 +(P+I)。

`E0` 在本金编辑分支传入旧债务资产V0、旧关联资金资产W0与旧本金，按差额修正债务对象，并撤销旧资金侧再应用新资金侧；新增偿还则债务侧只处理本金，资金侧一次处理本金加利息。不能随后为另生利息账单再次扣／加同一资金余额。

### 13.4 不是一笔“含利息的普通还款”载荷

**已静态证实：**`E0` 更新本地资产后调用 `J0(principalBill, remark)`。`J0` 在偿还且非追加时调用 `o0(remark)`，其仅在I>0时生成type10或11的独立账单；缺备注时使用默认利息备注。再分别保存利息记录、本金记录，最后 `startPush`。两者都由 `Bill.newInstance` 生成自己的billid、用户ID、业务时间、money、status2、创建与更新时间，并设置所选账本；本金可带图片，`o0` 对利息新建传入空图片列表。没有本金时也可只保存利息。

两笔没有在本轮构造链中附加一个互相指向的 `sourceBillId`：关联来自各自的债务对象ID与资金资产ID。不能自创一个上游并不存在的本金／利息父子引用字段，或仅凭发生时间相同就永久合并账单。

借入本金100、归还本金30和利息5，其上送业务结构分别是：

```text
追加借入：一条 type6、money100、assetid=D、targetid=A。
归还：一条 type9、money30、assetid=D、fromid=A；
      另条 type10、money5、fromid=D、assetid=A。
借出／收回：type7 与 type4/11，按前表设置字段。
```

这些记录进入与转账相同的 `bills.changelist`、`/bill/syncall`；删除进入 `bills.dellist`。`J0` 没有另调用一个“借贷归还HTTP接口”，本地资产余额亦未在这条账单同步构造链中额外装入载荷；不能因本地LoanInfo变化就自己另发资产余额修改请求。服务端如何依据账单回算与下发资产，仍需要响应／回拉实测。

### 13.5 删除与编辑边界

**已静态证实：**

- 删除type6/7：`Loe/c.deleteSingleBill → d(Bill)`，先将相应本金反向计入债务余额并按isDebt/isLoan夹在非正／非负范围，同时修正LoanInfo.totalMoney；再反向恢复关联资金资产。
- 删除type9/4：分派到 `g(Bill)`，恢复债务余额方向，LoanInfo.totalpay为正时扣掉该本金，再反向恢复对应资金资产的本金；未见这一分支顺便删除另生利息记录。
- 删除type10/11：属于isAllSpend/isAllIncome，走普通 `a(Bill)`，其assetid是实际资金资产，单独回滚利息资金变化；不修改债务已偿还本金。
- 本轮详情普通编辑入口只对type6/7提供LoanPayAct编辑，不能据此开放type4/9/10/11任意编辑并沿用本金编辑分支。

**推断／建议：**MCP与网页用“本金P＋利息I＋债务对象＋实际资金资产”的业务参数，但适配器按APK拆成明确的上游记录集合；操作日志同时追踪这些ID和逐项结果，不能承诺两笔一定原子成功。统计只把利息10/11算作普通支出／收入，本金6/7/9/4独立展示；资产余额变化和收支统计使用不同的逐类型规则。

### 13.6 补充契约向量与仍需实测

| 向量 | APK静态预期 |
| --- | --- |
| 借入本金100，T=-100、A=0、C=-100，追加50 | 一条type6/50；T=-150、C=-150；关联现金+50 |
| 借出本金100，T=100、A=0、C=100，追加50 | 一条type7/50；T=150、C=150；关联现金-50 |
| 借入C=-100，偿还本金30、利息5 | type9/30及type10/5；C=-70、totalpay+30；现金一次-35；统计支出5 |
| 借出C=100，收回本金30、利息5 | type4/30及type11/5；C=70、totalpay+30；现金一次+35；统计收入5 |
| 偿还输入120，债务余额绝对值100 | G0将本金100、利息20；债务余额0，资金侧120；不是本金120 |
| 本金0、利息5 | 只生成10或11；债务本金余额不变，资金侧±5 |
| 编辑type6本金100→120，换关联现金资产 | 债务累计本金差额-20；旧现金-100，新现金+120；原billid保留 |
| 删除偿还本金记录，保留独立利息记录 | 债务与totalpay恢复本金，现金只恢复本金；利息统计与资金变动仍在 |
| 选择非本位币资金资产 | 债务页面拒绝新选择；不能偷偷走普通转账汇率模型 |
| 本金或利息9,999,999,999与再大一档 | 前者不触发tooLarge，后者客户端拒绝；协议数值精度和服务器限制另验 |

**待服务器实测仅限上游事实：**本金与利息同批的逐项回执和部分成功、响应丢失后核查；服务器对本地余额与LoanInfo的重算／纠偏；超过本金的输入拆分后是否全部接受；已结清对象的新追加、图片、权限与并发修改结果。以上不影响本节已经证实的客户端分派与载荷规则。

第12、13节补查完整定位（可直接复制到MT工具）：

```text
dex_method:Lcom/mutangtech/qianji/bill/transfer/f;->x0(JDLjava/lang/String;Ljava/util/Calendar;ZZLjava/util/ArrayList;DLjava/lang/String;Lcom/mutangtech/qianji/data/model/CurrencyExtra;IZLjava/util/ArrayList;)V
dex_method:Lcom/mutangtech/qianji/bill/transfer/f;->w0(Lcom/mutangtech/qianji/data/model/Bill;ZZDDLcom/mutangtech/qianji/data/model/CurrencyExtra;)V
dex_method:Lcom/mutangtech/qianji/bill/transfer/f;->H0(Landroid/widget/CompoundButton;Z)V
dex_method:Loe/b;->processBillAssetForTransfer(Lcom/mutangtech/qianji/data/model/Bill;Lcom/mutangtech/qianji/data/model/AssetAccount;Lcom/mutangtech/qianji/data/model/AssetAccount;DDLcom/mutangtech/qianji/data/model/CurrencyExtra;Z)V
dex_method:Loe/b;->__get_transfer_asset_money_from_inner(DD)D
dex_method:Loe/b;->__get_transfer_asset_money_from_old(Lcom/mutangtech/qianji/data/model/Bill;)D
dex_method:Loe/b;->__get_transfer_asset_money_target_inner(Lcom/mutangtech/qianji/data/model/CurrencyExtra;DD)D
dex_method:Loe/b;->__get_transfer_asset_money_target_old(Lcom/mutangtech/qianji/data/model/Bill;)D
dex_method:Lcom/mutangtech/qianji/asset/loanpay/LoanPayAct;->E0()V
dex_method:Lcom/mutangtech/qianji/asset/loanpay/LoanPayAct;->J0(Lcom/mutangtech/qianji/data/model/Bill;Ljava/lang/String;)V
dex_method:Lcom/mutangtech/qianji/asset/loanpay/LoanPayAct;->G0(DZ)V
dex_method:Lcom/mutangtech/qianji/asset/loanpay/LoanPayAct;->F0(DZ)V
dex_method:Lcom/mutangtech/qianji/asset/loanpay/LoanPayAct;->o0(Ljava/lang/String;)Lcom/mutangtech/qianji/data/model/Bill;
dex_method:Loe/c;->processZhaiwuCurrentAssetData(IDLcom/mutangtech/qianji/data/model/AssetAccount;D)V
dex_method:Loe/c;->processZhaiwuAboutAssetData(IDDLcom/mutangtech/qianji/data/model/AssetAccount;DLcom/mutangtech/qianji/data/model/AssetAccount;)V
dex_method:Loe/c;->d(Lcom/mutangtech/qianji/data/model/Bill;)V
dex_method:Loe/c;->g(Lcom/mutangtech/qianji/data/model/Bill;)V
dex_method:Loe/c;->f(Lcom/mutangtech/qianji/data/model/Bill;)V
dex_method:Lcom/mutangtech/qianji/data/model/Bill;->setZhaiwuCurrentAsset(Lcom/mutangtech/qianji/data/model/Bill;Lcom/mutangtech/qianji/data/model/AssetAccount;)V
dex_method:Lcom/mutangtech/qianji/data/model/Bill;->setZhaiwuAboutAsset(Lcom/mutangtech/qianji/data/model/Bill;Lcom/mutangtech/qianji/data/model/AssetAccount;)V
dex_method:Lgh/a;->e(ZLjava/lang/String;Lbh/c;)Lgh/c;
dex_method:Lgh/a;->a(Lgh/c;Lbh/c;)Lcom/google/gson/JsonObject;
dex_method:Lgh/a;->d(Lgh/c;Lbh/c;)Z
dex_method:Lbh/a;->getKey()Ljava/lang/String;
```

## 14. 有界补查：组合报销22是已定位列表链中的虚拟聚合对象

**已静态证实：**`Bill.newPackBill(Bill)` 的唯一已找到调用者是 `Lpe/b;->b(Bill,Comparator)`，`addPackBill(Bill)` 也仅在同一列表组装方法被调用。该路径将原始账单集合保存在 `Lpe/b.a`，用于显示的 `Lpe/i` 集合放在 `Lpe/b.b`；组合对象仅加入后者。

聚合条件是列表 `enablePackBill` 对应字段l开启、当前原始账单type21、并非前述专用兼容账号。它取原记录 `importPackId`（序列化名 `packid`）；没有当前聚合对象，或当前聚合对象packid与新记录不同，就调用 `newPackBill` 新建显示对象，再调用 `addPackBill` 把原始type21记录放进去。同packid的相邻条目继续进入已有组；不能自行改成按备注相同、金额相同或同一天自动合并。

`newPackBill` 创建一个普通Bill对象后设 `type=22/status=1`，复制首条的userid、packid、业务时间、备注、图片、fromact/targetact/descinfo/platform；没有生成billid，没有调用数据库保存，也没有构造上送请求。默认billid仍是构造器的0。`packBills` 字段明确为transient。

`addPackBill` 累加子记录的 `getMoneyForStat(null)` 为显示money，并维护transient子列表；有币种扩展时首次复制币种信息，后续累加源值。**列表统计仍在原始记录循环中对原type21调用 `BillStatItem.fromBill`**，并非对显示type22再记一次收支，因此聚合不会增加一笔账务或重复计入金额。

### 14.1 展示与操作会展开真实成员

- `Bill.getTypeString(Context,Bill,ZZZ)` 的type22分支读取 `packBills.size()` 组织显示文字。
- `Lai/d.m(holder,Bill)` 对只含一个成员的type22，取 `packBills[0]` 交给普通显示／选择逻辑；不会用billid0冒充真实成员ID。
- `Lci/i0.S()` 处理删除选中项时，将type22展开为其非空 `packBills` 后交给 `onDeleteClicked(List)`，普通记录直接加入操作列表。
- `BillBatchModifyActivity$c$a.invokeSuspend` 处理type22且packid>0时，调用 `dbhelper/m.listByPackId(uid,packid)` 加载数据库中的真实成员再加入修改列表；该查询要求status非删除、userid和packid匹配、billid为正。它不是把显示对象直接保存回数据库。

**结论边界：**在这条已定位构造、显示、批量删除／编辑链中，22是客户端虚拟组合行。没有证据支持新增一个向钱迹提交type22的“组合报销创建工具”，也不应为它生成云端账单ID、单独统计或当普通收入。如果未来云端实际下发type22，保留原始记录并另做证据核对；本次静态链不证明服务器永远不可能出现该数值。

**建议修改主设计／契约：**多笔报销的界面聚合以 `packid` 与真实type21成员为依据；MCP可以返回分组及成员ID，写操作展开为真实成员集合。测试单成员、多成员、packid不同、关闭聚合、批量修改重新按packid取成员、删除组展开成员，以及列表聚合前后统计不变。异常历史映射缺失仍按第10节边界处理，不再把type22的核心用途留空。

完整定位：

```text
dex_method:Lcom/mutangtech/qianji/data/model/Bill;->newPackBill(Lcom/mutangtech/qianji/data/model/Bill;)Lcom/mutangtech/qianji/data/model/Bill;
dex_method:Lcom/mutangtech/qianji/data/model/Bill;->addPackBill(Lcom/mutangtech/qianji/data/model/Bill;)V
dex_method:Lpe/b;->b(Lcom/mutangtech/qianji/data/model/Bill;Ljava/util/Comparator;)I
dex_method:Lai/d;->m(Lbi/o;Lcom/mutangtech/qianji/data/model/Bill;)V
dex_method:Lci/i0;->S()V
dex_method:Lcom/mutangtech/qianji/ui/bill/batch/BillBatchModifyActivity$c$a;->invokeSuspend(Ljava/lang/Object;)Ljava/lang/Object;
dex_method:Lcom/mutangtech/qianji/data/db/dbhelper/m;->listByPackId(Ljava/lang/String;J)Ljava/util/List;
dex_method:Lcom/mutangtech/qianji/data/model/Bill;->getTypeString(Landroid/content/Context;Lcom/mutangtech/qianji/data/model/Bill;ZZZ)Ljava/lang/String;
```
