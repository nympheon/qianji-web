# Cloudflare 套餐与最终架构复核

- 日期：2026-10-18
- 对照：当前 APK 4.5.4 研究、个人单账号 Web/MCP 需求及[主设计](../superpowers/specs/2026-10-18-qianji-workers-design.md)
- 方法：核对 Cloudflare 官方现行文档及本地 APK 证据；没有购买套餐、创建云资源或运行性能基准
- 当前推荐：Workers Paid + Static Assets + 一个 SQLite-backed Durable Object；数据库直接采用该对象的 SQLite，不再单独配置 D1

## 1. 结论

建议生产部署采用 Workers Paid，减少为普通 Worker 的 CPU 与单次外部请求额度做特殊分拆，也避免初始化或重建集中写入时遇到 Free 的每日硬额度。按需同步、结果不明核查、持久任务仍保留，不能用升级替代正确的账务与恢复设计。

更直接的代码简化来自**把业务状态与数据库放进同一个 SQLite Durable Object**：此前的 D1 副本、DO 协调状态和操作记录可统一使用一个数据库及本地事务，少一个绑定、少一段跨服务数据库访问，也不需要协调两个存储的提交顺序。SQLite DO 本身在 Free 也可用；这项简化不是付费专属能力。[DO 套餐](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[存储选型](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)

这里的性能收益是依据架构作出的推断：同步和计算贴近数据库，减少数据库调用往返。尚未基准测试，不给出虚构的提速倍数；Paid 也不保证钱迹服务器响应或跨境网络自动变快。

## 2. 当前套餐差异

| 项目 | Free | Paid | 对本项目的实际影响 |
| --- | --- | --- | --- |
| 普通 Worker CPU | 每次10ms | 默认30秒，可配置至5分钟 | MCP编解码、参数校验、签名及响应转换有更大余量 |
| 普通 Worker 子请求 | 每次50 | 默认每次10,000，可配置 | 长同步不必为了50次上限人为切成极小调用；仍按页保存进度 |
| 普通 Worker 内存 | 128MB | 128MB | 付费没有增加内存，账单处理仍须有界读取 |
| SQLite DO 可用性 | 可用 | 可用 | 不是为了取得 DO 才付费 |
| SQLite DO 读写额度 | 每日读500万行、写10万行，超限失败 | 每月包含读250亿行、写5000万行，超出计费 | 历史首次同步、索引和重建集中写入更从容 |
| SQLite DO 存储包含量 | 账号合计5GB | 包含5GB-month，超出计费 | 包含量不等于每对象容量或无限免费 |

CPU、子请求及内存依据[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)；SQLite额度依据[DO 价格](https://developers.cloudflare.com/durable-objects/platform/pricing/)。10ms指普通 Worker，不能直接用它描述 DO 的执行限制；DO 有独立的执行限制说明，见[DO 限制](https://developers.cloudflare.com/durable-objects/platform/limits/)。Paid 的单个 SQLite 对象容量为10GB，不将整个账户的存储额度误称单对象可无限增长。

Free 并非无法完成本项目；薄入口 Worker + SQLite DO 在数据和请求较少时可工作。当前生产推荐 Paid，是用小额固定起步成本换取用量和入口执行余量，不是已经测出 Free 一定失败。代码只维护一套实现，不增加两种套餐的业务分支。

## 3. 三个候选方案

| 方案 | 优点 | 代价 | 结论 |
| --- | --- | --- | --- |
| Free + 单 SQLite DO | 无固定订阅费，协调和数据已经同处 | 入口预算较紧；每日数据库硬额度要留意首次同步、索引和重建 | 可用于小数据体验或开发，保留同一代码的部署可能 |
| Paid + D1 + 协调 DO | D1提供现成迁移、外部查询和数据库运维工具 | 多一个数据库服务；DO到D1的往返、任务和数据提交衔接仍要处理 | 可行，若重视D1外部工具可选，但不是当前最简方案 |
| Paid + 单 SQLite DO | 数据、操作、同步、游标及任务同库；业务计算与存储同处 | 需少量版本化SQL迁移；所有动态业务经同一个对象 | 当前单人需求推荐 |

Cloudflare 官方明确区分 D1 的成套数据库工具与 SQLite DO 的计算/存储共置，不能一面拿掉 D1，一面声称还自动拥有它全部工具。[官方选型说明](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)

本项目不需要向其他系统开放数据库、不做多人读扩展、没有报表服务器，也不提供数据导出界面，因此 D1 这些优势暂时不值得增加一个服务。采用正常的 `schema_version` 与顺序 SQL 迁移，保留 DO 的官方恢复能力即可；不为以后可能更换数据库同时维护两套适配器。

## 4. 与 APK 最相近的运行组织

```text
浏览器 / ChatGPT
    → 同一个 Worker：静态页面、业务HTTP入口、无状态MCP传输
    → 固定名称的 SQLite DO：领域用例、按需同步、签名与钱迹请求
       └ SQLite：账务副本、资料、关系、游标、操作、任务、连接配置
    → 钱迹官方接口与官方图片存储
```

APK 是“本地数据库 + 同步器 + 本地账务计算”，单 SQLite DO 与此结构接近。网页与 MCP 只映射交互，共用对象内领域服务；类型、日期、优惠、历史币种、退款报销、借贷、预算等规则继续由已核对的 APK 契约决定，不能让 SQL `SUM(money)` 替代模型。

具体减少的实现：

- 移除 D1 绑定、单独创建/部署数据库及 DO→D1 查询封装。
- 数据页应用、相关资料、修订号和任务进度进入同库事务；结果确认、操作逐项状态和副本更新也可同库提交。
- SQL查询同步执行，不在多个存储之间转发一份份账单或维护相同状态。
- 一个对象对接一个钱迹账号，不增加多租户分片、KV缓存、Queues、Workflows或后台出账器。

仍需保留的实现：

- 上游请求跨 `await` 时的明确顺序；对象单线程不能代替逻辑互斥。
- 发送前持久化、响应不明只核查、切换式动作不重放；本地事务不能覆盖钱迹远端网络副作用。
- 按页检查点及用户任务所需的有限 alarm 续跑；客户端断开后不能依赖一个普通 Promise 或 `waitUntil` 永久运行。
- SQLite业务ID和金额文本字段、无损原始JSON；SQL结果的数值仍会经过JavaScript数值语义。
- 有界查询、同步消费SQL游标、必要索引和按数据修订缓存的统计。Paid不能成为整库一次装进128MB内存的理由。

对象的数据库时间点恢复属于独立运维流程：先暂停写入，恢复后核对历史任务与钱迹当前结果，再解除暂停。平台恢复可能回退操作状态，不能将它与普通进程重启同等处理、自动重放恢复出来的旧任务。

存储事务和游标规则见[SQLite Storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)。SQL事务不跨网络；查询游标在下一次 `await` 前消费完。本地事务、平台持久化与远端请求是三个边界。

## 5. Paid 可以省什么，不能省什么

可以减少的是为紧额度而生的极小批次、频繁任务交接及入口CPU微优化。保留实际APK的每页、每批边界与短暂停顿，而不是把Paid的10,000次子请求额度用成增加钱迹请求频率的目标。

Paid并不免除以下限制：

- HTTP返回或客户端断开后的普通后台工作并非无限存活；`waitUntil`的延长仍有限，DO alarm每次也有时长边界。[执行时长](https://developers.cloudflare.com/workers/platform/limits/)
- alarm至少一次投递、失败可能重入，因此数据库任务续跑不能重放已发出的写入。[Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- 一个DO内的长同步不能用 `blockConcurrencyWhile` 把所有缓存查询和任务状态查询一起锁住；只对需要排队的上游变更/同步使用逻辑队列，短本地事务及时结束。[State API](https://developers.cloudflare.com/durable-objects/api/state/)
- 不改变钱迹的权限、账号权益、签名、服务端仲裁或限流；也不能直接执行APK中的Android/ARM JNI库。

## 6. 费用判断

当前 Workers Paid **账号最低每月5美元**，包含一定 Worker 与 Durable Object 用量，超出各维度另计。不是每个服务再固定收一个5美元。静态资源直出可使用官方免费静态资源请求规则。[Workers 价格](https://developers.cloudflare.com/workers/platform/pricing/)

以下只作预算演算，未测量用户的真实用量：

| 假设月用量 | 演算 | 对包含额度的判断 |
| --- | --- | --- |
| 动态入口30,000次，每次入口CPU 5ms | 150,000 CPU-ms | 低于Worker所含10,000,000请求及30,000,000 CPU-ms |
| 每次动态调用进入一次DO，另有500次任务/状态调用 | 30,500 DO请求 | 低于所含1,000,000次 |
| DO每天活跃1小时，30天 | `30×3600×0.128=13,824 GB-s` | 低于所含400,000 GB-s |
| SQL实际计量每月读3000万、写30万行，存储1GB | 含索引与操作记录后以实际计量为准 | 低于所含读250亿、写5000万、存储5GB-month |

上述假设、账号没有其他项目占用额度时，计算结果为5美元/月起步，不能据此保证永远只有5美元。DO的网络等待可能计入活跃时长，不能因为不消耗CPU就当作不计费用；数据及索引读写仍看平台实际指标。[DO 计价](https://developers.cloudflare.com/durable-objects/platform/pricing/)

生产实现不为省这笔起步费用加一套复杂限额补偿系统。仍保留合理页数/任务终止边界、无闲置请求和用量可查看，这些已有设计同时有利于减少费用与上游压力。

## 7. 落地与验收

1. 主设计改为上述推荐；已有研究文件中的D1是当时方案背景，APK证据不因此失效。
2. 所有动态业务经DO，不让Worker和DO各自实现一半账务规则；一次业务读尽量一次RPC返回需要的数据。
3. SQL schema有版本、索引与升级规则；事务只覆盖本地状态，不声称跨钱迹原子提交。
4. 核查并发查询不会在20秒上游等待期间被全局锁阻塞，重建切换不会丢掉已确认写入或操作日志。
5. 用同一契约集校验Web/MCP金额和关系；测首次全量、冷/热查询、年度统计、写入、重启恢复的耗时和CPU，性能判断以实际结果为准。
6. 继续先关闭native签名及真实协议验证问题；Paid与数据库选型不能替代这一实现前置工作。
