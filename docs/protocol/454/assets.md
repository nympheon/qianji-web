# 资产协议与原生逻辑

依据钱迹4.5.4/1234。真实只读核对已通过正常资产列表、47项官方资产类型、空分组列表及一个资产详情；没有执行实际资产写入。写验收统一使用新建命名测试资源，见第27步。

## 响应包装

这是适配器与原生网络层之间的边界，不能把Java模型的getData()直接当成HTTP中的data：

- `arc/http/parser/a`先读取外层ec/em/data，data是对象。
- `parser/b`从**data.list**反序列化数组；适配器将它规范化为`ProtocolReply.data`数组，保留hasmore元数据。缺少list不能当成空列表。
- `parser/c`只在data恰好只有v一个字段时解包data.v；否则使用整个data对象。适配器仅对已经确认使用该解析器的操作执行解包，不改其他对象响应。
- asset/list、asset/submit及报销baoxiao的自定义解析器保留各自data对象。tag/list是同步字符串请求，保持已核对的独立解析，不套用parser/b。

真实元数据读取发现并修正了此前合成退款向量的包装遗漏：refund2也继承parser/b，**原始HTTP为data.list，领域层看到的才是Bill数组**。回执整体原子应用的领域逻辑不变。[合成形状向量](../../../fixtures/apk-454/assets-read-vectors.json)不包含个人数据。

## 固定操作

以下全部使用普通构造器、固定三条HTTPS线路与共享签名，没有调用者自定义URL。

| 路径 | 参数与响应 |
| --- | --- |
| asset/list | uid,status；原生主页status0、隐藏页status2。自定义data.list资产数组及data.groups分组数组 |
| asset/info | uid,did；parser/c，可能包在单字段data.v |
| asset/typelist | uid；parser/b的data.list，hc/d列表有name标题行及type对象行 |
| asset/submit | uid,v完整AssetAccount JSON字符串，可选diffparams/extra JSON字符串；自定义data.asset与可选data.bill |
| asset/visible | uid,did；成功码后核对实际状态，是可能翻转的操作 |
| asset/finish | uid,did,可选v日期；成功码后核对实际结清状态，不能重发未知切换 |
| asset/reorder | uid,v数字ID数组JSON字符串；只读列表核对顺序 |
| asset/deletecheck | uid,did；parser/c的installcount/repeatcount |
| asset/delete | uid,did；parser/b资产预览列表，成功后删除原资产并保存官方资产回执 |
| asset/listloan | uid,t方向51/52,status；parser/b，借贷领域使用同一真实资产对象 |
| asset_group/list | uid；parser/b，官方groupid是字符串 |
| asset_group/submit | uid,name,非空groupid；parser/c返回完整AssetGroup |
| asset_group/delete | uid,groupid；成功后只读完整分组列表核对 |
| asset_group/reorder | uid,v字符串分组ID数组 |
| asset_group/addasset | uid,groupid,assetids数字数组JSON字符串,startSort（大小写准确） |
| asset_group/removeasset | uid,assetid；先读最新归属，已离开指定分组时不清除其他分组 |
| assetline/list | uid,did,flts；DateFilter按`{"date":"开始秒,结束秒"}`编码，parser/b返回真实AssetSnapshot |

资产类型：资金1、信用卡2、储值3、投资4、借贷5、借贷汇总包装6。借入stype51、借出52，现金11、银行卡12。新增借贷本金由第17步的专用流程实现，不伪装为普通资产创建。未出现在当前官方类型目录中的新类型不映射成现金。

## 余额、分期与差额

`SubmitCommonAssetViewImpl.k0/C`在修改既有余额时，先检查账号范围内待同步账单；`dbhelper/m.q(uid,true)`匹配本人或空UID、status0/2，并排除虚拟22。服务另外检查尚未进入镜像的持久化账单意图，而非只检查当前资产。

`AssetDiffAct.a0`的yesorno=false明确不记录差额，因此不传diffparams，也不制造本地调整账单。选择记录时传cateid、billflag及非空备注/图片；billflag的统计/预算排除位独立。服务只原子保存金额、类型、分类、标记和关联资产匹配的官方data.bill与data.asset，新图片等待附件域验收。

`getInstallMoney`只累加status1且incount==1的分期；是否含费来自data.feeincount==1，不是incount位运算。`getMoneyWithInstalment=money-未还分期`。原生编辑C把正的未还分期加回输入余额后再存money；显示余额、原始确认余额与汇总选项明确区分。

汇总跳过type6包装项、尊重incount。借入只保留非正余额，借出只保留正余额；信用卡按选项扣除未还分期，其他金额按官方原币种分别累计。没有当前汇率伪造的跨币种总额。

## 结清、显隐、分组和删除

结清/显隐操作每次提交先直接读取asset/info，已达明确目标就不再调用翻转接口；未知结果只读核查，不用第二次翻转追逐目标。结清不清零余额或生成还款。浏览器草稿键包含目标状态；已确认的隐藏草稿不会覆盖下一次明确的显示请求。

`AssetDetailPresenterImpl$b`在asset/delete成功后调用`Loe/a.deleteSingleAsset`并保存官方返回的预览资产。原生`Loe/a.a`删除关联转账/信用卡还款、以本资产为本金资产的借贷记录、以本资产为fromid的利息；其他账单保留并解除资产/from/target关联。服务先展示实际影响，再调用一次asset/delete，不拼装额外bill/syncall删除。资产回执与账单源核查分别记录，关联账单在只读同步证明影响前保持待核查。

普通资产必须通过原生周期/分期删除检查，借贷沿用跳过该检查的原生路径。没有通用级联开关。分组删除使用asset_group/delete，完整分组列表证明消失后才清理规范化分组资料，不调用asset/delete。

## 缓存与验收限制

展示来源按查询范围校验，60秒内复用；同一进行中的读取合并，闲置不请求。ID/金额无损保留。上游失败保留已确认缓存并明确stale与错误。完整回执直接替换实体，不在官方余额上再加预期增量。

本地有界限制：来源最多5000资产/1000组，单次分组加入最多20资产、排序/选择最多200项、删除影响最多1000账单；趋势单次一年内/2000官方快照。这些不是APK服务器限制。超界明确不可用，不能截断后冒充完整。

余额相等不足以确认未知差额写入；未知新建不凭同名认领。取消报销的资产核查使用发送后逐个官方asset/info来源，无需假装资产域全局快照完整。新图片、真实差额/删除/结清影响及各写能力仍待第27步的限定资源验收。
`AssetGroupManagePresenterImpl.addAssetsToGroup`将本地同UID/同groupid的成员数作为内部startSort，listAssetInGroup不按隐藏状态过滤。服务沿用此原生计数；MCP/页面只收业务分组与资产ID，不暴露startSort。
