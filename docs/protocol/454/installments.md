# 分期（钱迹 4.5.4 / 1234）

## 接口与对象

| 接口 | 参数 | 回执 |
| --- | --- | --- |
| `installment/list` | uid/page/flts，页从0开始，sort=`类型,升序标志` | data.list/hasmore |
| `installment/submit` | uid/v，完整新对象 | data.install、可选data.bills |
| `installment/config` | uid/did/v，v仅incount/feeincount | 可选业务确认，无完整对象 |
| `installment/prepay` | uid/v，提前还款独立参数 | data.install、可选data.bills |
| `installment/bindbill` | uid/installmentId/billId | 可选业务确认 |
| `installment/delete` | uid/did | 可选业务确认 |

排序类型为时间0、状态1、总金额2、剩余金额3。完整目录最多20页/2000项，资产与状态筛选复用同一排序目录，空完整目录也从来源校验时间缓存60秒。

`Installment.initNew` 固定type=1、incount=1；money/fee/count/status/packid/创建更新时间均为0。UI只改本金总额、费用总额、总期数、首期日期及data规则，money/fee的setter交叉引用仅DAO；因此不上传本地计算的平均金额或预览账单。所选资产须isCredit，category对象及cateid决定账本，原生对象没有独立bookid。data.assetString未被该选择流程设置。

原生还声明TYPE_LOAN=2，但没有证明新建入口会设置它。产品采用通用分期及明确统计选项，不把“消费/账单分期”名称猜成两个wire.type。后续只有确切入口与真实证据才能开放新变体。现有对象只允许incount/feeincount配置；ACK后只应用这两个已确认字段，保留其余原始数据，目录仍需按需复核。

## 独立预览向量

`fixtures/apk-454/installment-vectors.json`由独立Java25 BigDecimal/Calendar复现器生成，依据Smali核对；不是直接执行APK。包含60个金额拆分、6个初始次数和月末日期向量。

先按10位HALF_UP求平均。若平均值四舍五入到2位后乘期数恰等于总额，返回原10位平均；否则first/last截断2位，rnd/rndf四舍五入2位，intf/intl向下取整。尾差为总额减平均值×(期数−1)，first/rndf/intf放首期，其余放末期。费用ave复用该算法，first/last将全部费用放相应一期。原生极端输入可能产生负数尾差，预览明确提示，创建要求调整，避免生成负期款。

初始执行次数按`xf/f0.X0`：日期归零，从今天向前执行Calendar.set(MONTH,current−1)，直至不晚于首期，正总期数上限截断。它具有宽松溢出语义，例如3月31日至5月31日结果为3，而不是普通月份差2。首期今天或未来为0。

日期预览同样保留原生日历宽松溢出：1月31日、3月3日、3月31日、5月1日……，不擅自改成每月末。预览仅展示最多120期，超过时complete=false；不创建Bill ID，不上传到bill/syncall。

## 提前还款

独立v含dataid/bookid/time（秒）/money/fromid，正fee及非空remark才上送。spendCurrency、transferCurrency分别是嵌套在v中的JSON字符串，保留六个历史币种金额和CurrencyValues.srcFee，不使用当前汇率推算。

`wf/n.W0`读取照片列表到v4，但images实际写入v0备注，确认为疑似原生赋值错误。生产默认拒绝提前还款图片，返回PREPAY_IMAGES_UNVERIFIED；仅私有验收依赖允许测试array或json-string候选，不提供公开raw参数或开关。

`wf/n.K0`临时预览的支出默认使用分期money（平均期款），还款使用输入本金；不能把这组预览当正式回执或按它推算实际支出。只接受本次官方返回的账单，核对账号、账本、秒时间、资产、费用及已提供的历史币种金额。任务结清、支出、还款各有独立操作项目，多个账单ID可属于同一角色。

部分成功保存明确回执及原ID。未知结果只读查询目录并同步账单，已知回执ID可复核；完全丢失账单ID时不会按相同金额/日期认领不确定记录，该角色保持待核查。不会重发prepay或另补转账。删除仅移除管理对象；绑定只更改已有支出的packid，先核对任务真实packid，移出T时已属U直接成功。

## 验证状态

单元、Workers、HTTP与桌面/手机交互测试覆盖数值、配置丢失ACK、部分回执及原操作恢复。专用新资源已补验真实创建、六种分配、配置、绑定、提前还款状态/两类账单/资产及图片数组，提供范围写入已启用。APK图片参数缺陷不照搬，使用真实回读成功的数组与含费金额；细节及早期失败样本见[真实矩阵](../../acceptance/live-matrix.md)。
