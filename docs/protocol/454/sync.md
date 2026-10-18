# 4.5.4 增量同步

本地契约来自MT工作区`rxvx4qt6`的只读APK方法；`fixtures/apk-454/sync-pages.json`是按这些字段人工重建的脱敏协议向量，尚未取得真实服务器回执。

## 账单

`Lgf/b.pull`使用同步字符串构造POST `syncv2/pull`：`uid/bookid/lasttimes/pageoffset/pagesign`。首请求bookid=-1、offset=0、sign为空；lasttimes为空时省略。每一页继续使用本轮开始时的lasttimes，书本、偏移和签名取上一页回执。

`api/bill/g.j`把响应`data`交给`Leh/c`，再用`Leh/b$a.fromJson`解析**同一个data对象**的bookid/pageoffset/hasmore/count/pagesign/lasttimes；不是猜测的嵌套pageParams结构。hasmore是0/1整数。changes、deletes、categories随本页原子落库，deletes按业务billid，关系从已核对的BillExtra字段索引，原始JSON保留未知字段和长整数。

各页lasttimes合并到本轮结果，正常hasmore=false时才保存成功游标及整域校验时间。失败保留已应用页及上次成功游标。已有副本的普通增量逐页可见，完整性在同步期间为false；首次没有可发布副本时暂存至首次完整结束，查询以未载入/任务进行中表达，不冒充完整空集合。首次失败的暂存集合不与下一轮完整快照混合。

`Leh/a.start`的200次保护跨任务续跑保留；触顶仍有更多页时停止并标为truncated。首次/全量语义的页间节奏为150–220ms，普通增量不强加等待。当前每次处理两页，再由同一持久job继续；页计数和固定起始游标均落库。重复且不前进的分页参数或异常结构停止任务，不清库或自动重试。

## 标签与分组

`api/tag/a.syncAll`与`Ldh/c.b`使用`tag/syncall`，参数uid、固定的lasttime和从0开始的page。`Lfh/a`只有update、delete和boolean hasmore；**没有分组集合**。标签正常结束后按APK记录本地完成毫秒时间为协议游标，另存服务校验时间。40页保护跨续跑保留；触顶不记录新的成功时间。标签失败与账单成功分别保存。

标签分组的真实来源是`TagRefreshPresenterImpl$c$a`→`tag/list`→`api/tag/b`的数组解析器。参数为uid、status=-1、lasttime，响应数组每项为TagGroup并带tags；id为空的项是未分组容器，不伪造为正式分组ID。`dbhelper/d0.saveAllTags`清理分组表及扁平标签后保存此完整集合。该源须由资源缓存/标签业务独立获取并记录范围，不能因tag/syncall成功就宣称分组资料完整。只有明确完整覆盖契约才能据缺席删除实体，过滤列表为空不清其他范围。

`tags_sync_time`与分组列表的`tags_refresh_time`是不同本地时间记录。标签同步期间跨设备新增与本地时钟偏差的窗口仍待真实验证；实现没有自行改成账单游标或宣称不存在漏窗。

## 上传边界

本同步器只拉取。不会扫描Bill.status并上传记录；上传须由已持久化且明确可发送的操作进入协调器。公开进度中的receivedRecords是收到的记录数量，重复无变化页不会推进SQLite业务数据修订，不能把收到数量说成真实变化数量。
