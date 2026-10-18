# 存钱计划（钱迹4.5.4 /1234）

## 原生协议

| 接口 | 参数 | 回执 |
| --- | --- | --- |
| saving/list | uid | data.list，包含实际transactions |
| saving/submit | uid、可选did、mode/name/currency/rule/remark/icon/color | data直接为SavingPlan |
| saving/reorder | uid/v，v为字符串planId数组 | 可选业务确认 |
| saving/deposit | uid/did=planId/amount/remark/time，及可选billInfo | data.transaction及可选data.bill |
| saving/canceldeposit | uid/did=transId | 可选业务确认 |
| saving/delete | uid/did=planId/deleteBills=0或1 | 可选业务确认 |

来源为saving/c、saving/d/e/b解析器、kg/c.parseInitData、SavingPlanDepositAct.startSave/l0/I0，以及规则模型。planid/transid保留原样String，billid才按已确认数字ID处理。time/start/end为秒；浏览器日期转换显式采用Asia/Shanghai，不把毫秒上送。状态1进行中、2完成，不提供未经证明的启停或强制完成。

## 七种规则与预览

- fixedAmount：amount/start/period/frequency，frequency为day/week/month/quarter/year。
- fixedAmount12/36：继承FixedAmountDepositRule，固定12或36期，frequency=month。
- daily365、weekly52：initialAmount/increment/start/period，分别365天和52周，每期为initialAmount+序号×increment。
- reverseWeekly52：52期，每期max(initialAmount−序号×increment,0)，不将递减输入猜成负数增量。
- custom：total/start/end，end=0表示不设截止日，calculateAllTransactions为空。

日期使用逐次Calendar.add：月/季/年先夹到目标月份有效日，并从夹过后的日期继续，例如1月31日→2月28日→3月28日。与分期Calendar.set的宽松溢出行为不同。金额投影使用十进制精确求和，避免原生double累加误差；上传的是原始规则金额，历史实际交易从不按投影重写。

预览最多120行，包含complete与总期数，定额规则仍允许原生正int期数范围，不为了预览把期数限制为120。行没有transId/billId，不进入实际交易集合，不设置定时器自动deposit。

random仅在枚举和模型适配中发现，kg/c创建七分支没有它；未注册随机新建或伪造分配算法。旧未知模式仍显示官方实际交易与进度，规则编辑保留具体不可用原因。

## 存入与币种

无billInfo仅记录存入进度。有billInfo时原生嵌套对象字段为bookId/outAssetId/inAssetId、可选currency对象、images数组、tags字符串数组。它一次请求生成官方转账，不另调用bill/syncall补转账。

I0将用户输入H0放入CurrencyValues.targetValue，源/目标符号分别取转出/转入资产。因此amount为计划及转入资产币种金额，关联Bill.money为历史srcValue。服务要求转入资产币种匹配计划，保存src/target/base各自金额与srcFee，外币不使用当前汇率重算。图片必须已有确认上传证明。

transaction核对账号、原planId、新transId、amount/time/remark及是否要求关联账单。Bill另外核对transaction.billid、账号、账本、类型2、时间、资产与历史币种金额。交易已证明而Bill缺失/不符，保存交易ID及部分成功；Bill不入库，原操作保持待核查。完全丢失存入回执时不按相同金额、备注或时间认领一个新transaction，也不再次deposit。

编辑提交保留原模式，元数据/规则修改不会重写transactions；有历史存入的计划币种变更尚未证明影响，明确返回SAVINGS_CURRENCY_WITH_HISTORY，待专用资源核实。已有规则未知字段随同模式编辑保留。

## 撤销、删除与一致性

撤销目标是transId，并校验该交易版本；交易移除与关联Bill删除分项确认。删除计划必须明确deleteBills；false保留账单，true按原计划内明确billId集合核对删除。业务ACK后只更新已确认的管理对象/交易，账单删除需要只读同步证明，不额外发送一批账单删除。

未知操作仅执行只读恢复。排序完整检查当前全部ID且无重复，ACK后通过官方顺序核对。完整目录来源缓存60秒、并发读合并，空集合也缓存；旧结果不能跨连接代次/数据集/来源代次覆盖。

## 验证边界

实际只读目录已返回ready/complete（空目录），未保存个人原始数据。业务、HTTP和桌面/手机测试包含目标币种金额、部分成功、未知存入不重发、规则编辑保留历史、撤销及deleteBills两种策略。真实写入、撤销已有/已删Bill、图片与多币种服务端语义，均等待任务27专用测试资源验收，正式写能力仍为WRITE_LIVE_UNVERIFIED。

官方[存钱计划说明](https://docs.qianjiapp.com/saving/saving_plan.html)补充365天模式的用户语义；私有接口与其余规则以本次APK证据为准。
