# 标签与标签组（4.5.4 / 1234）

原生 API：`com/mutangtech/qianji/network/api/tag/a`。`tag/list` 使用 sync-string 请求构造器，再由 `tag/b`（继承原生列表解析器）解析整个响应，业务列表实际为 **data.list**。真实只读调用已确认包装；个人目录为空，没有提交实际写入。

| 动作 | 参数 / 回执 |
| --- | --- |
| 完整目录 `tag/list` | uid, status=-1, lasttime=0；data.list 为 TagGroup[]，空组 ID `""` 表示未分组，组内 tags 展平为独立实体 |
| 标签 `tag/submittag` | uid；编辑 did；v 为 name/groupid/color 的 Gson JSON，null 字段被省略；返回 Tag |
| 标签组 `tag/submitgroup` | uid；编辑 did；v 为纯名称文本；返回 TagGroup |
| 归档/恢复 `tag/archivetag` | uid,did；这是切换动作，返回 Tag |
| 排序 `tag/reordertag` / `tag/reordergroup` | uid,v；v 是**字符串 ID 数组**，不是数字数组 |
| 删除 `tag/deletetag` / `tag/deletegroup` | uid,did；通用业务成功回执 |

Tag/TagGroup 的 ID 是不透明字符串。Tag.status=1 正常，2 归档；标签色为六位或八位无井号十六进制（Tag.getTagColor 为六位补 FF alpha，默认 FF3792FA）。原生 Tag.MAX_GROUP_NAME_LENGTH=10；服务的标签名 100 字及单次排序 2000 项属于请求边界，不是伪造账号权益。实际权限和数量上限交由当前账号官方回执判断，没有照搬旧项目免费数量常量。

`dbhelper/d0.deleteGroup` 使用 STATUS_ALL 查询，清除所有组内标签 groupId，包括归档标签；保留标签及账单。服务完整目录与已有同步/重建共用 catalog:all 资源来源、60 秒校验策略；空目录也是完整结果。全量来源确认后移除已不存在的标签实体，不修改同步游标。

设置归档目标前强制读最新完整目录，已达到目标则不调用切换；否则只发送一次并用官方 Tag 回执替换，未知结果只读证明目标。删组未知结果必须同时证明组不存在、全部标签已脱离该组。新建响应丢失不按同名认领成功。

删除标签的元数据回执与账单引用核查分开：不额外上传逐笔账单，不在本地预测清空引用。官方同步后仍保留引用时继续显示未确认。历史筛选明确显示归档标签；新增账单选择只展示正常标签，编辑时保留已有归档引用。

提供范围的真实写入已用专用新资源补验并启用；移组、归档、颜色清空、批量排序、删组及账单引用结果见[真实验收矩阵](../../acceptance/live-matrix.md)。回执仍必须与归一目标匹配，不把输入当作上游已保存值；全局标签组排序依用户决定不提供。
