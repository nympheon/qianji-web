# 账本与业务配置（4.5.4/1234）

证据：network/api/book/a及b–f、Book/BookConfig、BookSubmitAct.A0/F0/G0、BookManageAct.d0、BookDetailAct/BookDeleteAct及回调，CurrencyManageAct.l0、network/api/user/a.updateConfig、MainActivity$d、se/c。静态协议与真实写入验收分开；实际写入仅在新建专用测试账本和明确测试资源内验证，涉及其他成员的真实变更须有具体用户命令。

| 动作 | 原生请求 | 解析/确认 |
| --- | --- | --- |
| 列表 | book/list uid,t=-1（全部类型） | parser/b：data.list，包含visible/owner/member资料 |
| 模板 | book/typelist uid | data.list：type/name/cover/desc/range |
| 新建/编辑 | book/submit uid,v(JSON字符串) | parser/c模型Book；单键data.v会解包 |
| 账期 | book/config uid,did,v={range} | 同上，应用完整官方Book |
| 显隐 | book/visible uid,bookid | 整型parser/e；回调只判断业务成功并翻转本地值，本服务再读实际目标 |
| 删除检查 | book/deletecheck uid,bookid | parser/c：owner_has_unresolved、member_has_unresolved兼容旧字段 |
| 删除 | book/delete uid,bookid | 整型parser/e；回调不读取数值，成功后删除本地Book及该bookid账单 |
| 退出/移除 | book/quit uid,bookid,v=目标用户ID | generic ack；与delete分开 |
| 排序 | book/reorder uid,v=数字ID数组 | generic ack后以完整列表核对相对顺序 |
| 成员 | book/members uid,bookid | data.list User对象，限定账本来源 |

Book wire字段：bookid、userid（所有者）、memberid（当前参与身份）、name、type、visible(0/1)、sort、expired、membercount、cover、config.range、createtime/updatetime。默认账本ID=-1；普通账单业务契约允许该bookId，但资产/账单ID保持正整数，且只有已载入的真实账本可用于写入，不注入可写的合成默认账本。

isOwner仅比较userid与当前UID；isMember要求非owner且memberid匹配。expired==1只对应成员过期；所有者过期要求非默认账本、当前用户非VIP且vipend>0。状态展示保留两者；不会因此建立本服务RBAC，也不将所有操作套用自造权限矩阵。

删除仅所有者且非默认账本。检查结果在owner/member新字段均不存在时，才用旧has_unresolved==1将二者都设为真。任一未结事项会阻止删除。提交前强制刷新账本和检查，避免只依赖打开页面时的旧检查。成功后只清理目标本地账本、该账本账单及其关系，其他账本保留；未知结果仅通过完整官方列表核查。删除不会发额外逐笔账单删除，也没有通用cascade开关。

参与者只能退出自己，所有者可移除当前官方成员名单中其他成员；不能用退出替代删除自己的账本。本人退出才移除本地账本副本，移除他人保留账本。未构造邀请流程。类型、成员与账本查询各有成员集合和来源校验时间，共用canonical实体；60秒按需更新，失败保留旧来源并明确stale/problem。

提交表单新建含name、type、非null的cover及非空range；编辑含bookid、名称/封面及非空range。JSONObject.put在值为null时删除键，因此新建null封面应省略并采用官方默认封面，不能伪造null清空语义；清空已有封面明确保持未验证，图片扩展由附件模块处理。新建以服务器ID为准；丢失响应时不能凭同名创建认定成功。BookConfig只包含range：自然月为空，all/y/q，或m1–m28；自定义月起始日控件构造参数0x1c证实最大28。恢复自然月使用book/config的显式空range；编辑submit在有旧自定义周期时不接受空range，避免APK表单省略字段使意图被静默丢弃。网页将名称编辑与业务周期操作分开。周期变化通过官方回执修订使统计、分页与预算依赖失效。

本位币是账号级业务配置，来自client/init.userconfigs.basecur。se/c保存在apiconfu_basecur、兼容旧basecur，缺值默认CNY。本服务独立SQLite accounting_config保存值、业务修订和来源时间；登入/检查账号的同UID同凭证代际事务内采用官方配置。账本没有虚构currency字段。

设置经user/updateconfig(uid,v={basecur})，仅暴露本位币字段。明确设置始终提交一次，即使旧缓存看似相同，防止忽略手机近期变更；同requestId仍由持久操作日志去重。业务成功后才采用目标，未知时保留旧值并只读client/init核查，绝不再次写入。共享回调供统计、资产、转账、退款、报销与借贷使用，不按当前汇率改写历史金额。原生CurrencyManageAct$c在onFinish更新本地值，即使失败也可能更新；本服务沿用既定更严格的未知结果规则。
