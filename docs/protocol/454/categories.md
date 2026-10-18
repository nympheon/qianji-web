# 分类管理（4.5.4 / 1234）

来源为 `com.mutangtech.qianji.ui.category.a` 与分类管理回调。全部使用普通请求构造器，UID 与长 ID 保持文本，只有 JSON ID 数组编码为无损数字。

| 动作 | 原生接口与参数 | 回执 |
| --- | --- | --- |
| 分类树 | `category/listv2`: uid, bookid, t | `data.list`，含 sublist |
| 新增/编辑 | `category/submitv2`: uid, bookid, t, **v=纯名称文本**；可选 did、parentid、非空 icon | Category |
| 升降级 | `category/changelevel`: uid, did；parentid 仅正数时加入 | Category |
| 移动子类 | `category/movesubcate`: uid, did, parentid | Category |
| 排序 | `category/reorder3`: uid, v | v 为同级数字 ID 数组的数组，一级组在前；成功后读取官方顺序 |
| 删除检查 | `category/deletecheckv2`: uid, did | count 为本人引用数，other 为其他成员引用数 |
| 删除 | `category/deletev2`: uid, did, deletebills=1/0；可选 newcateid | Integer，**仅 1 才删除分类** |

分类最多两级，收入/支出及账本范围分开；保留 editable、未知字段和原始 ID。父类有子项时不能直接删除；降级前也需先处理子项，避免未经证明的递归迁移。全局模板不会被当成某个其他账本的可写分类。

删除时原生客户端在整数检查前处理本人账单迁移/删除；因此整数 0 不能被包装为全成功。本服务分别跟踪分类回执及本人关联账单的只读同步证明，不预测改写已确认账单、不额外上传逐笔修改、不猜测其他成员数据。迁移会同时改变账单 cateid 与 bookid，跨账本必须显式指定目标账本。

创建响应丢失时不按同名认领成功；其他未知结果只读核查原操作，不重新发送。图标清空因原生会省略空字符串而暂不宣称成功。真实写入验收前所有写动作保留明确能力门禁。

`category/iconlist(uid)` 返回扁平分组标记及图标项：非空 `group` 是分组，非分组且 `icon` 非空才是可选图标，`name` 为建议名称。实际只读返回541个图标，原生地址使用 HTTP 的 res3.qianjiapp.com/res.qianjiapp.com；res3 HTTPS 证书名称不匹配。因此浏览器经现有 HTTPS 图片代理展示，代理只允许当前官方目录中精确匹配的 URL，不跳过 TLS 校验、不接受任意目标。此公共目录使用独立 catalogs 缓存域，个人分类变动不会反复刷新图标目录。

`category/submitmultiple(uid,bookid,t,v,parentid?)` 的 `v` 为所选 `{name,icon}` 数组，正父ID才附加 parentid；返回 Category 数组。每项只有匹配账本、收支类型、父级、层级、名称及图标的新官方ID才可确认。部分回执保留已确认项，未返回项保持未知；同名查回不能证明是本次创建，禁止更换请求键重发。Web提供筛选图标、改名及批量草稿恢复，MCP复用同一操作。
