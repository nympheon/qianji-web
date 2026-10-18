# 钱迹 Android 4.5.4 账单冲突与同步收敛分析

- 日期：2026-10-18
- 样本：用户提供的 `qianji_454_1234_gw.apk`，`com.mutangtech.qianji`，4.5.4 / 1234
- 方法：只读检查 APK 的 Smali、模型、数据库表结构和调用链；未登录钱迹账号，未发送真实账单变更
- 结论适用范围：已定位的账单同步路径；其他资料接口不据此类推

后续各域复核与最新设计决策见[业务逻辑复核汇总](2026-10-18-apk-logic-audit.md)。本文中的“发布副本”只表示与草稿/操作分开的查询副本，不要求普通增量维护每条记录的历史代次；最新同步实现采用逐页事务与完整性状态。

## 1. 已确认的结论

APK 的普通账单同步采用自动应用钱迹回执和下发记录的方式。在本轮定位的路径内，没有通用的三版本选择、字段级合并或本地与云端更新时间比较流程。

需要区分三件事：

1. `conf_ids`：客户端按账单 ID 冲突处理，生成新 `billid`，保留待上传状态，在后续上传批次中继续处理。
2. 下发记录与本地记录不一致：客户端按 `billid` 唯一约束替换本地记录，并应用删除列表。
3. 两个设备都修改同一账单后，服务端最终接受哪一个写入：目前没有真实双客户端实验，不能从前两条推导为“最后提交一定获胜”或“客户端时间戳更大一定获胜”。

将 `conf_ids` 直接解释为“编辑版本过旧”，再据此让用户手动选择版本，不符合本次观察到的 APK 处理分支。

## 2. 上传回执调用链

```text
Lgh/a;->d(Lgh/c;Lbh/c;)Z
  -> network/api/bill/d.syncAllV2(...)
  -> /bill/syncall
  -> 解析 BillSyncResult
  -> dbhelper/m.saveSyncedResult(BillSyncResult)
```

`BillSyncResult` 包含 `userid`、`new_ids`、`update_ids`、`conf_ids`、`del_ids`、`has_failed`。

`dbhelper/m.saveSyncedResult(...)` 的分支如下：

| 回执字段 | 本地处理 |
| --- | --- |
| `new_ids` | 查找本地账单，设 `status=1`；如回执带用户 ID，还更新 `userid` |
| `update_ids` | 查找本地账单，设 `status=1` |
| `conf_ids` | 查找本地账单，调用 `Lza/h;->f()J` 生成 ID，仅改 `billid` 后保存，没有在该分支设为已同步 |
| `del_ids` | 查找并从本地数据库删除对应账单 |

冲突分支的日志文字为 `BillID conflict: oldID=... newID=...`，与其更换 ID 的行为相互印证。该回执的服务端全部触发条件仍需真实实验确认，不能扩大解释为一种通用的编辑冲突协议。

### 2.1 为什么换 ID 后还会上传

- `Bill.STATUS_NOT_SYNC=2`，`STATUS_DELETE=0`，`STATUS_OK=1`。
- `dbhelper/m.q(String, boolean)` 的待同步查询包含状态 0 或 2。
- `Lbh/a;->getAllUnSync(...)` 每次最多取 200 条。
- `Lgh/a;->start(Context, boolean)` 每次上送后重新查询待同步列表，一轮最多处理 5 个批次。
- `conf_ids` 分支没有把该账单改为状态 1，因此仍符合后续待同步查询条件。

“每轮最多 5 批”是整个上传循环的边界，不是每笔冲突固定重试 5 次。网络异常和 ID 明确拒绝也不是同一种重试条件。

### 2.2 新 ID 的生成

`Lza/h;->f()J` 将当前毫秒时间戳与六位随机数拼接；随机数为 100000 至 199999，等价于：

```text
billId = epochMilliseconds × 1,000,000 + randomInteger(100000, 199999)
```

实现时必须使用无损整数并向外返回字符串，不能用 JavaScript `Number` 保存结果。

## 3. 下发数据的应用调用链

```text
Leh/a;->pullNewDataInner(...)
  -> Lgf/b;->pull(...)
  -> /syncv2/pull
  -> network/api/bill/g 解析为 Leh/c
  -> dbhelper/m.savePullResult(Leh/c)
```

`savePullResult` 对 `changes` 调用 `m.saveList(collection, false)`。该方法清理账单分类展示缓存、保存分类后调用基类 `g.saveList`；基类在 `clear=false` 分支使用 `insertOrReplaceInTx`。

`BillDao.createTable(...)` 为 `billid` 建立 `IDX_user_bill_billid` 唯一索引。因此，相同业务 ID 的下发记录会替换本地相应记录。在这条调用链内未观察到按本地 `updatetime` 或未上传状态跳过下发记录的条件，也未观察到逐字段合并。

对 `deletes`，`savePullResult` 调用 `m.deleteListByPK(List)`；该方法实际按 `Billid` 查询并删除，而不是把下发 ID 当成本地自增 `_id`。

由此可确认客户端如何应用下发数据，但无法据此确定服务器如何仲裁同时发生的两次修改。

## 4. 对本项目的设计调整

1. 普通同步默认自动应用官方回执和下发数据，不为每次快照变化设置通用版本选择弹窗。
2. D1 发布副本与编辑草稿、待提交操作分别保存；自动同步副本时保留操作记录，草稿不计入官方统计或冒充钱迹已接受的结果。
3. 对于本次新建且已被明确拒绝的 ID，按核实后的 `conf_ids` 语义分配新 ID，并持久化操作、尝试和旧新 ID 的映射，再处理后续上传。原 `requestId` 保持不变。
4. 不能把现有账单的编辑或删除失败一律转换成新建，更不能因超时或回执丢失而换 ID 再提交。
5. 不能修改已有云端账单的 ID 来“腾出位置”；映射属于被拒绝的待提交记录及其已核对的引用。
6. 不把整次上传请求返回成功视为每一笔都成功；本项目仍逐项检查回执与回拉结果。
7. 两端并发编辑的最终仲裁规则列入双客户端实测；在确认前，描述为按官方结果收敛，不承诺本地或某个时间戳必胜。

## 5. 需要完成的真实验证

在用户指定测试数据下分别验证：同一账单的先后修改、相同字段交叉修改、不同字段交叉修改、删除与编辑交叉、离线修改后同步、受控的新建 ID 冲突，以及发送后响应丢失。

每项记录提交顺序、原始关键字段、回执 ID 集合、回拉结果与官方客户端显示。实验完成前不推测服务器的时间戳比较、条件写入或删除优先级。

## 6. 证据定位清单

| APK 方法或类 | 作用 |
| --- | --- |
| `Lcom/mutangtech/qianji/data/model/BillSyncResult;` | 回执字段 |
| `Lcom/mutangtech/qianji/data/db/dbhelper/m;->saveSyncedResult(Lcom/mutangtech/qianji/data/model/BillSyncResult;)V` | 新增、更新、ID 冲突、删除回执处理 |
| `Lza/h;->f()J` | 新业务 ID 生成 |
| `Lgh/a;->start(Landroid/content/Context;Z)I` | 上传循环、重新查询和批次数上限 |
| `Lbh/a;->getAllUnSync(Ljava/lang/String;Z)Ljava/util/List;` | 每批最多 200 条 |
| `Lcom/mutangtech/qianji/data/db/dbhelper/m;->q(Ljava/lang/String;Z)Lap/g;` | 待同步状态筛选 |
| `Lcom/mutangtech/qianji/data/db/dbhelper/m;->savePullResult(Leh/c;)V` | 应用云端更改、删除和分类 |
| `Lcom/mutangtech/qianji/data/db/dbhelper/g;->saveList(Ljava/util/Collection;Z)Z` | 批量插入或替换 |
| `Lcom/mutangtech/qianji/data/model/BillDao;->createTable(Lxo/a;Z)V` | `billid` 唯一索引 |
| `Lcom/mutangtech/qianji/data/db/dbhelper/m;->deleteListByPK(Ljava/util/List;)Z` | 按业务 ID 应用删除 |
| `Lcom/mutangtech/qianji/data/model/Bill;->toSyncJson()Lcom/google/gson/JsonObject;` | 整笔上送、去除展示字段；未观察到通用字段级合并载荷 |
