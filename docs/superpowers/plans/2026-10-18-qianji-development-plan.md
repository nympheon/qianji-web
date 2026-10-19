# 钱迹 Web 与 MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Cloudflare 上交付单人使用的钱迹完整业务网页版与 ChatGPT MCP，按 APK 4.5.4 的规则查询、同步、计算和变更数据。

**Architecture:** 同一个 Worker 提供静态网页、HTTP API 和无状态 MCP；一个固定名称的 SQLite Durable Object 运行所有领域用例、钱迹适配器、同步与持久操作。数据库、游标和任务同处，网页/MCP只负责交互映射，远端写入仍独立于本地事务。

**Tech Stack:** TypeScript strict、React、Vite、Tailwind CSS 4.3、shadcn/ui（官方registry、Radix基础）、lucide-react、Cloudflare Vite plugin、Workers Paid、SQLite DO、官方 MCP TypeScript SDK v2、Zod v4、lossless-json、decimal.js、Vitest/Cloudflare Vitest plugin、Playwright；Node 24、pnpm 11。具体依赖版本在任务01及11验证兼容后锁定。

**Spec:** [已批准主设计](../specs/2026-10-18-qianji-workers-design.md)，基线提交 `sanitized-history`；用户在2026-10-18明确“使用这个设计”。任务执行同时阅读主设计及相应APK研究，不用旧报告中的D1背景替代最新SQLite DO选型。

缓存策略补充：用户要求与APK比较后采用更合适的逻辑，已按[缓存与更新比较](../../research/2026-10-18-apk-cache-update-comparison.md)细化主设计§6.3及任务08/10/11；60秒为远端检查新鲜期，当前副本不按TTL删除，写回执驱动局部更新。

## Global Constraints

- “只有一个服务使用者、一个当前连接的钱迹账号，不建设多用户注册、租户或权限体系。”
- “应用页面和 MCP 均不增加访问认证，不建设 PAT、OAuth、一次性连接票据；入口保护由用户配置 Cloudflare。”
- “钱迹登录仅支持手机号或邮箱加密码，不实现微信、Apple 等第三方登录。”密码与可重放摘要不持久化、不进入MCP或日志。
- “使用时按需更新。闲置且没有用户发起的在途任务时，不向钱迹发起请求，不做周期性后台轮询。”
- “普通查询使用 60 秒数据新鲜期；同步任务共享、合并。”APK普通同步冷却5秒；手动增量不清游标，强制全量仅清任务起点。
- 源数据校验时间、数据修订和派生缓存独立；完整空集合可缓存，读取不续期，局部写不刷新整域校验时间；慢读不能覆盖稍后确认的新写。具体缓存测试见任务08、10、11。
- Workers Paid + Static Assets + 一个SQLite DO；不引入D1、Cron、Queues、Workflows、常驻WebSocket或另一台服务器。R2仅在官方图片链路证明需要暂存时另作有证据的变更。
- 默认 `Asia/Shanghai`；上游20秒默认超时、零自动重试；MCP用例默认最多等待10秒，超出返回真实任务/操作状态。
- ID、金额及原始JSON无损。整数ID十进制字符串、其他ID原样字符串；钱迹wire数字和嵌套字符串JSON按各操作契约编码。
- 只上传明确可发送的持久操作；结果不明只核查，逐项接受不重发，翻转动作按最新上游状态决定，不能承诺跨设备锁。
- 不复制APK系统/个性化设置，不做数据导出、注册注销改密、第三方登录、会员购买、手机自动化或新增AI/OCR服务。
- 前端使用CSS及组件库美化；用户已授权自行选型，采用Tailwind CSS当前4.3稳定线、shadcn/ui和Lucide，后续安装锁定确切版本，不使用预发布版本或运行时CSS CDN。
- 用户已确认按更新计划由主代理顺序实现、最后统一独立审查；真实写入使用明确的测试对象，发布使用已授权的目标。沿用已有授权，不反复请求同一确认；缺账号、目标或其他必要信息时才询问。

## Review Focus

1. 请求已送达但回执丢失，再刷新/重启/alarm重投递：只核查，不再产生第二次写入；归任务05、08、27测试。
2. 同UID换token与不同UID重绑：前者保留逻辑连接与操作，后者不发送或命中旧UID操作；归任务05、06测试。
3. 重建页间/切换前排队写、失败重建及核查依赖重建：不丢已确认数据、不清原游标、不互相等待；归任务08测试。
4. 手机先改状态，缓存仍新鲜，或账单当前绑定另一pack：暂停/解绑不会反向操作；归任务16、20、23、24测试。
5. 查询期间数据修订改变、跨期子记录缺失、未知wire字段：分页重查、完整统计等待/说明缺失、编辑保留字段；归任务02、09、10、14、15测试。

---

## 交付顺序与范围

本项目是共享同一模型、同步器和操作队列的一套应用，保持一个执行计划；按可验收的业务切片推进，不把独立页面建设成第二套后端。

| 里程碑 | 任务 | 可检查的成果与门槛 |
| --- | --- | --- |
| M0 运行与协议可行 | 01–03 | workerd内可构建/测试，长整数与金额契约通过，新版签名有独立证据；签名未关闭时不投入整套页面开发 |
| M1 只读应用 | 04–11 | 真实登录、按需同步、账单筛选/日历/统计，中文网页与MCP读结果一致；尽早验证Cloudflare出口与实际ChatGPT入口 |
| M2 核心账务 | 12–17 | 普通记账、转账还款、退款报销、资产与借贷，逐项真实写入验证 |
| M3 完整业务 | 18–25 | 账本/分类/标签、预算、图片、周期/分期/储蓄及各自Web/MCP操作 |
| M4 发布验收 | 26–28 | 完整响应式页面、异常/多端/性能验收、实际部署与ChatGPT验收、维护与恢复说明 |

M1不是最终范围裁剪。某写能力未真实验收时，保留交付目标和原因；不能以“后续再做”无记录省掉。各业务任务完成本地契约后立即接入任务27的对应真实用例，不等所有页面做好才第一次验证上游。签名、账号权益和服务器未知行为不适合在计划阶段给出确定日历工期。

## 文件与接口地图（均为待创建文件）

| 文件/目录 | 职责与创建任务 |
| --- | --- |
| `package.json`、`pnpm-lock.yaml`、`tsconfig.json`、`vite.config.ts`、`vitest.config.ts`、`wrangler.jsonc` | 单项目工具链、Workers/React与本地测试，01 |
| `src/worker/index.ts`、`src/worker/env.ts` | HTTP/MCP/Static Assets入口与绑定类型，01、11 |
| `src/actor/QianjiState.ts`、`src/actor/context.ts` | DO薄入口、领域上下文组装，01、04、05、11 |
| `src/shared/{model,numbers,wire-json,dates,errors,reply}.ts` | 无损边界、共用返回、日期及错误，02 |
| `src/protocol/{profile,signer,client,operations,errors}.ts` | APK协议画像、签名、固定上游操作注册表，03 |
| `src/storage/{database,migrations,mirror,resources,relations}.ts`、`src/storage/sql/0001-base.sql` | SQLite迁移、当前/临时数据集及资源，04 |
| `src/operations/{contract,store,runner,reconcile}.ts`、`src/actor/{coordinator,jobs}.ts` | UID写键、发送事实、续跑和目标影响，05 |
| `src/features/<domain>/{contract,service,use-cases}.ts` | 每个业务域的DTO/校验、领域逻辑和用例注册，所属业务任务 |
| `src/features/sync/{incremental,rebuild,freshness}.ts` | 同步页、完整性、按需刷新，07–08 |
| `src/storage/cache.ts`、`src/storage/sql/0004-cache.sql` | 查询范围校验、有效空结果、资源代次和迟到响应保护，08 |
| `src/features/ledger/{query,write,transfer,refund,reimbursement,statistics}.ts` | 账单专有算法，09–15；资产借贷算法放对应域 |
| `src/app/{use-case,registry}.ts`、`src/contracts/actions.ts` | 显式业务注册及调用类型，11及各域增量注册；不接受任意上游路径 |
| `src/worker/{http,mcp}.ts` | 同一用例的HTTP/MCP映射，11及各业务任务 |
| `src/web/{main.tsx,App.tsx,api.ts,styles.css}`、`src/web/components/`、`src/web/pages/` | 中文响应式页面、共享筛选/状态组件，11及业务任务 |
| `components.json`、`src/web/components/ui/`、`src/web/lib/utils.ts` | shadcn配置、按需加入的组件源码及cn工具，11；CSS入口由01创建 |
| `tests/{unit,workers,http,mcp,e2e}/`、`tests/support/{app,upstream,fixtures}.ts` | 算法、真实workerd存储、传输及浏览器验证，按任务增加 |
| `fixtures/apk-454/`、`docs/protocol/454/`、`docs/acceptance/` | 有来源的脱敏契约、协议与真实验收记录，03起 |
| `tools/{protocol,acceptance,ops}/`、`docs/{development,deployment,maintenance}.md` | 只读协议核验、限定测试对象和运维，03、27–28 |

域名固定为 `connection`、`sync`、`ledger`、`assets`、`debt`、`books`、`categories`、`tags`、`budget`、`attachments`、`repeat`、`installments`、`savings`。同变更相关的组件/测试放同域；不创建一个包含全部规则的巨大service文件。

### 共用调用契约

- 任务02在`src/shared/model.ts`定义：`Id = string`、`Money = string`、`ActorScope { uid:Id; connectionEpoch:string }`、`CallMeta { requestId?:string }`、`Freshness { revision:string; complete:boolean; stale:boolean; syncedAt:string|null }`；内部WireJson保留无损数字，公开DTO不含BigInt/凭证。
- 同任务导出`Clock { nowMs():number; nowIso():string }`供签名、冷却与任务使用；测试注入可推进时钟，业务代码不各自读取不可控的全局时间。
- 同任务定义`AppReply<T>`：`status`为`ready/running/uncertain/partial/unavailable/error`，`data:T|null`，`freshness:Freshness|null`，可选`jobId/operationId/error`。错误包含稳定`code/message`，不能将结果不明写成“失败，可重新提交”。
- 任务04提供`Repository`；任务05提供`Coordinator`与`OperationView`；任务06提供`ConnectionView`。任务11的`UseCaseContext`组合它们与任务03的`QianjiClient`、`Clock`，不提供第二套领域实现。
- 任务11定义`QianjiState.call(name:ActionName,input:unknown,meta:CallMeta):Promise<AppReply<unknown>>`、`defineUseCase<I,O>(definition:UseCaseDefinition<I,O>)`和`createRegistry(ctx:UseCaseContext):UseCaseRegistry`。`UseCaseDefinition`包含固定`name`、Zod输入/输出、`kind:'read'|'write'`、破坏性注解和`execute`；各域注册静态允许的动作，输入在Worker与DO边界校验。
- HTTP固定`POST /api/actions/{ActionName}`，写键用`X-Request-Key`；MCP写工具用顶层`requestId`，两者映射同一CallMeta。唯一密码入口为`POST /api/connection/login`，不注册成MCP工具；`/health`只说明服务存活，不声称钱迹在线。
- 各任务出现的`*Input/*View/*Receipt`由该域`contract.ts`定义并导出，字段须来自对应APK表单/载荷/回执证据；不得用`Record<string,unknown>`代替未核对业务契约。read/write能力独立记录，未验收写入口返回unavailable，测试上下文可注入模拟验证状态。
- 后文省略签名的方法遵循统一规则：读方法`method(input:MethodInput):Promise<MethodView>`，写方法`method(input:MethodInput,meta:CallMeta):Promise<OperationView>`，Method为方法名首字母大写；类型定义在该域contract中。已有显式签名优先，例如book的`members(input:MembersInput):Promise<MembersView>`、`quit(input:QuitInput,meta):Promise<OperationView>`；`preview/project`均为只读计算，返回其具名View，不进入发送队列。
- 测试支持`createTestApp(scenario):Promise<TestApp>`由任务04–05建立，先提供`actor/repository/seed/restart/runAlarm`、可控clock和脱敏upstream.calls；各任务注入其领域服务。统一`call`在任务11接入真实registry后才使用，不在04–10伪造另一套业务dispatch。底层依赖真实workerd SQLite与fake上游，预期值来自APK向量/独立计算，不从被测函数自动生成。
- active_dataset按`(uid,syncDomain)`保存：账单、关系与其同步下发资料为ledger组，标签与分组为tags组，其他在线资源使用各自缓存域。重建仅切换所选域，不能以一个全局指针抹掉未选择域；跨域查询的新鲜度/分页修订包含所依赖域的修订组合。
- `Freshness.syncedAt`表示所声明源范围最近一次完整成功校验，不是最近本地读取或单条写入时间。派生键加入实际业务日期/时间范围与依赖修订；无变化的校验不推进业务数据revision。源范围不完整、被确实失效或操作未核清时，不能仅凭未满60秒标成可用于完整结果。

### 命令与开发约定

使用当前已找到的Node `24.19.0`和pnpm `11.25.0`；PowerShell中将`pnpm`解析为已有运行时的`pnpm.cmd`，路径为`C:/Users/USERNAME/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm.cmd`。不为执行本计划修改系统全局PATH或安装第二套Node。

任务01固定脚本：`pnpm test -- <file>`→对应Vitest run；`pnpm test:e2e -- <file>`→Playwright；`pnpm typecheck`→tsc；`pnpm build`→Vite生产构建；`pnpm check:deploy`→Wrangler dry-run使用生成配置；`pnpm dev`→本地Vite/workerd；`pnpm verify`→静态检查、全部本地测试、构建和dry-run。真实验收单独`pnpm acceptance -- <case>`，默认不执行、不读生产凭证。

锁定本轮核对的包线：SDK v2 `@modelcontextprotocol/server`及测试客户端包，Zod v4，Cloudflare的`@cloudflare/vitest-plugin`；不照搬旧的v1 MCP导入或旧vitest-pool配置。执行任务01以官方peerDependencies解决兼容并记录确切版本到lockfile；不能混用main源码与已安装版本API。MCP使用官方`createMcpHandler(factory,{legacy:'stateless'})`，保留2025与2026协议的无状态兼容，不自写协议栈。[SDK](https://github.com/modelcontextprotocol/typescript-sdk)、[HTTP handler](https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/server/server/createMcpHandler.html)、[Cloudflare测试](https://developers.cloudflare.com/workers/testing/vitest-integration/)

每个任务按失败测试→最小实现→通过→提交执行。仅对高影响业务、协议、恢复和交互行为写测试；样式/文案不写镜像测试。每步只改所属文件，后续任务增量注册用例和页面；提交前检查diff，实际暂存明确文件，不覆盖用户改动。以下测试断言是实现标准；计划编写时未执行产品测试，执行结果通过任务勾选和台账记录。

### 前端样式和组件约定

Tailwind CSS 4.3通过`@tailwindcss/vite`编译；唯一全局入口`src/web/styles.css`使用`@import "tailwindcss"`及`@theme inline`语义变量。产物随Static Assets发布，样式计算不放入Worker请求路径。任务01先接通构建；任务11在已有Vite项目初始化shadcn，不另起第二个项目。

采用官方`@shadcn`registry、统一Radix基础与Lucide图标。初始化时解析当时稳定版CLI并锁定版本，记录组件来源、生成配置和依赖到`docs/development.md`/lockfile；使用项目pnpm runner，先查组件文档和已有文件，再按需添加并审阅生成源码。`components.json`的ui/utils/CSS路径与本项目一致，`@/`仅映射`src/web/`；保留该版本CLI所需CSS依赖，不照搬旧版配置或手写猜测组件API。

表单用FieldGroup/Field与可访问的错误提示，数据用Table/Card/Badge，交互用Dialog/Sheet/AlertDialog，反馈用Alert/Empty/Skeleton/Spinner与sonner；图表按需使用Chart。布局使用Tailwind，配色、间距和组件变体统一，不在每页重造控件。默认浅色中文界面，桌面侧栏、手机折叠导航；360px宽度可完成主要操作。金额采用等宽数字并保持字符串精度，收入/支出和未知/部分结果同时用文字识别；弹窗具备标题、键盘操作和焦点恢复。大型账单仍服务端筛选分页，不把全库交给浏览器表格。具体视觉方案在任务11按前端技能产出并浏览器核验，不扩展APK主题设置。

## M0：运行与协议

### Task 01：建立可在workerd运行的最小应用与测试环境

**Files:** Create 根目录工具链文件、`src/worker/{index,env}.ts`、`src/actor/QianjiState.ts`、`src/web/{main.tsx,styles.css}`、`index.html`、`tests/workers/smoke.test.ts`、`.gitignore`、`.dev.vars.example`、`docs/development.md`。
**Interfaces:** Consumes 已批准主设计；Produces Worker.fetch、导出的`QianjiState.ping():string`、唯一`QIANJI_STATE`命名空间、`ASSETS`绑定及上述脚本。对象固定名`personal`；compatibility_date=`2026-10-18`，new_sqlite_classes=`QianjiState`。

- [x] 准备并锁定工具链/本地测试配置；`.dev.vars`、`.wrangler`、`.artifacts`、真实验收数据全部忽略；生成绑定类型，默认没有Cron/D1/R2或登录中间件。
- [x] 在smoke测试写断言：`expect((await SELF.fetch('https://test/health')).status).toBe(200)`；同名对象两次`ping()`返回同一持久实例标识，网页返回真实“尚未连接”空态。
- [x] Run `pnpm test -- tests/workers/smoke.test.ts`；预期先FAIL于缺少入口/导出，不能以测试框架加载错误代替有效红灯。
- [x] 实现最小Worker/SQLite DO和空网页，接入`tailwindcss`/`@tailwindcss/vite`及唯一CSS入口；DO仅有本地ping，不请求钱迹，不提前建设完整业务页面。
- [x] Run上述测试、`pnpm typecheck`、`pnpm build`、`pnpm check:deploy`；预期PASS且dry-run包含DO导出及实际生成的CSS静态资源，开发文档记录锁定版本。
- [x] 提交任务文件：`chore: bootstrap Workers SQLite application`。

### Task 02：无损数字、日期、ID与公开结果契约

**Files:** Create `src/shared/{model,numbers,wire-json,dates,errors,reply}.ts`、`tests/unit/{wire-json,numbers,dates}.test.ts`、`fixtures/apk-454/numeric-cases.json`。
**Interfaces:** Consumes 无；Produces 共用类型、`parseWire(text:string):WireJson`、`stringifyWire(value:WireJson):string`、`newBillId(nowMs:bigint,suffix:number):Id`、`businessRange(filter:DateFilter,book:BookPeriod,zone:string):TimeRange`；Money运算返回十进制字符串。

- [x] 写失败断言：嵌套长整数`1792000000123100000`往返不变；字符串ID`plan-A`不被数值化；`newBillId(1792000000123n,100000)==='1792000000123100000'`；金额`0.1+0.2==='0.3'`。
- [x] Run `pnpm test -- tests/unit/wire-json.test.ts tests/unit/numbers.test.ts tests/unit/dates.test.ts`；预期FAIL于上述函数未实现。
- [x] 实现上述函数及类型；按APK显式舍入点执行，不统一中间两位；月起日25的十月范围为十月25日零时至十一月25日前一秒。29/30/31及未证实配置由已核对合法配置向量约束，不自行截断；原始扩展字段保持。
- [x] 重跑测试；补断言wire数字/嵌套JSON字符串/省略与空值不同、无效精度报错、日期显示不改原时间戳，全部PASS。
- [x] 提交：`feat: preserve wire numbers and accounting date contracts`。

### Task 03：关闭新版签名及固定协议客户端的可行性

**Files:** Create `src/protocol/{profile,signer,client,operations,errors}.ts`、`tools/protocol/mt-read.mts`、`docs/protocol/454/{signing,requests}.md`、`fixtures/apk-454/signing-vectors.json`、`tests/workers/protocol.test.ts`。
**Interfaces:** Consumes WireJson/ActorScope；Produces `signRequest(input:SigningInput):Promise<SignedRequest>`、`QianjiClient.request(op:ProtocolOperation,params:WireJson,scope:ActorScope|null):Promise<ProtocolReply>`；SigningInput含op/params/profile/nowMs/deviceId及可选会话信息，SignedRequest含url/method/headers/body。profile固定APK4.5.4/1234，操作注册表定义构造器/编码/解析/超时/requiresSession；仅核对过的登录/公共操作允许null scope，不接受任意URL。

- [x] 通过只读MT工作区`rxvx4qt6`追JNIHelper及实际native实现，核对密码处理、设备/版本、reqidv2/tok、fr与身份头；将算法和确定性输入输出证据写入signing.md。工具只允许读取/搜索/xref，不修改、构建或安装APK；复用参考代码先核对许可证。向量来自独立APK/native逻辑或受控真实观察，不调用待测signRequest自产。
- [x] 写失败断言：所有独立向量完全匹配；普通构造不擅加htoken、同步字符串构造带htoken；20秒超时触发后`fetch`调用数为1；原始业务码和网络错误区分。
- [x] Run `pnpm test -- tests/workers/protocol.test.ts`；预期FAIL于缺少签名实现/确定性字段，而非跳过向量。
- [x] 实现Worker可执行的TS/WebCrypto算法；必要时仅封装已验证的WASM。三线路只允许已核对主机；不尝试在Worker运行Android JNI，也不以改旧项目版本号冒充适配。
- [x] 重跑测试及`pnpm check:deploy`；预期全部向量PASS且无Node/Android原生运行依赖。若签名仍无法确定，交付具体证据与阻塞点，暂停真实连接相关任务，不用模拟登录掩盖；可继续纯本地数字/存储任务。
- [x] 提交：`feat: implement verified Qianji 454 request protocol`。这是M0退出门槛，不给空向量文件或硬编码成功结果放行。

## M1：可用的只读应用

### Task 04：SQLite持久模型、迁移与账号/数据集边界

**Files:** Create `src/storage/{database,migrations,mirror,resources,relations}.ts`、`src/storage/sql/0001-base.sql`、`src/actor/context.ts`、`tests/support/{app,fixtures}.ts`、`tests/workers/storage.test.ts`；Modify `QianjiState.ts`。
**Interfaces:** Consumes shared模型；Produces `Repository.transaction<T>(fn:()=>T):T`、`applyPage(scope:ActorScope,datasetId:Id,page:MirrorPage):void`、`readBill(scope:ActorScope,id:Id):BillRecord|null`、`readResources(scope:ActorScope,kind:ResourceKind,query:ResourceQuery):ResourcePage`、`switchDataset(scope:ActorScope,domain:SyncDomain,id:Id,cursor:WireJson):void`。类型由storage导出：MirrorPage含upserts/deletes/resources/pageState；BillRecord含id/bookId/type/timeSec/money/raw/relations，`ResourceRecord {id:Id;kind:ResourceKind;raw:WireJson}`、ResourcePage含items/nextCursor/revision；事务同步，业务ID为TEXT。

- [x] 写失败断言：同billid在不同UID/数据集不串行；重复页upsert不增记录；本页中途异常回滚数据/关系/修订/进度；旧raw未知字段仍可读取。
- [x] Run `pnpm test -- tests/workers/storage.test.ts`；预期FAIL于Repository缺失。
- [x] 建立connection、datasets、sync_state、bills、bill_relations、resources、drafts和schema_version；原始JSON+必要规范化索引，不按APK每字段建列。支持业务ID删除、active_dataset指针，任务/操作后续独立于可替换集合。
- [x] 在真实workerd SQLite重跑并测试升级两次幂等、迁移失败回滚、SQL游标不跨await，PASS；建立上述createTestApp支持，不用内存Map代替持久化测试。
- [x] 提交：`feat: persist scoped mirrors in Durable Object SQLite`。

### Task 05：持久写键、操作队列、结果核查与alarm恢复

**Files:** Create `src/operations/{contract,store,runner,reconcile}.ts`、`src/actor/{coordinator,jobs}.ts`、`src/storage/sql/0002-operations.sql`、`tests/support/upstream.ts`、`tests/workers/operations.test.ts`；Modify actor/context。
**Interfaces:** Consumes Repository/QianjiClient；Produces `Coordinator.submit(command:MutationCommand):Promise<OperationView>`、`getOperation(scope:ActorScope,id:Id):OperationView|null`、`reconcileOperation(scope:ActorScope,id:Id):Promise<OperationView>`、`resumeJobs():Promise<void>`、`changeConnection<T>(fn:()=>Promise<T>):Promise<T>`及MutationHandler。command含action/input/scope/requestId；handler含prepare/send/applyReceipt/reconcile，OperationView含id/action/state/items/affectedIds。仅连接变更走changeConnection；不序列化函数/密码，业务持久载荷不含明文token。

contract导出MutationCommand/StoredOperation/PreparedMutation/OperationUpdate/ReconciliationResult及OperationContext；后者提供repository/client/clock。handler接口为`prepare(command:MutationCommand,ctx:OperationContext):Promise<PreparedMutation>`、`send(prepared:PreparedMutation,ctx:OperationContext):Promise<ProtocolReply>`、`applyReceipt(prepared:PreparedMutation,reply:ProtocolReply,ctx:OperationContext):OperationUpdate`、`reconcile(operation:StoredOperation,ctx:OperationContext):Promise<ReconciliationResult>`；applyReceipt同步本地事务，不在事务中请求上游。runner负责持久状态/发送顺序，各业务只注册本域handler。

- [x] 写失败断言：`submit(k,x)`两次仅发送一次，同键不同参数拒绝；接收端已执行但丢回执，再restart/runAlarm/同步仍只有一次发送；旧UID同键不命中或发送；部分成功只保留失败/未知项。
- [x] Run `pnpm test -- tests/workers/operations.test.ts`；预期FAIL于去重/恢复不变量。
- [x] 实现唯一键`(uid,requestId)`、参数摘要、逐项结果、ID映射、发送事实及排队/发送/核验/成功/失败/未知/部分状态；发送前确认持久化。局部网络用例串行而缓存查询可并行处理；恢复不从Bill.status重建发送候选。
- [x] 重跑并注入“落库后、安排alarm前”“发送标记后、fetch前”“服务端接受后、回执落库前”等中断；保守归未知而非盲重发。主动reconcileOperation只读核验且合并并发核查；有限核查结束仍未知时保留状态，停止alarm并等待下次使用，不无限后台查询。多个任务共享唯一alarm，剩余任务不被另一任务完成时取消，PASS。
- [x] 提交：`feat: coordinate durable mutations and safe recovery`。

### Task 06：真实账号连接、凭证存储与三线路

**Files:** Create `src/features/connection/{contract,service,use-cases,vault}.ts`、`tests/workers/connection.test.ts`、`tests/http/connection.test.ts`；Modify worker的专用login路由。连接网页归任务11，避免先于实际路由/客户端创建无法运行的页面测试。
**Interfaces:** Consumes任务03–05；Produces `ConnectionService.login(input:PasswordLoginInput):Promise<ConnectionView>`、`check/refresh/logout():Promise<ConnectionView>`、`selectRoute(route:RouteId):Promise<ConnectionView>`、`testRoute(route:RouteId):Promise<RouteCheckView>`；QianjiState的专用login RPC同签名委托service，后续通用动作在11注册。公开ConnectionView不含凭证，login不进入MCP。

- [x] 写失败断言：同UID重新登录deviceId/connectionEpoch/操作不变；不同UID不混数据和旧操作；断网不报密码错；查状态不泄漏token，账号失效码40005与其他错误分开；专用HTTP入口只返回脱敏ConnectionView。
- [x] Run `pnpm test -- tests/workers/connection.test.ts tests/http/connection.test.ts`；预期FAIL于连接服务/路由缺失。
- [x] 按实际login协议实现手机号/邮箱+密码；token用Worker Secret派生的AES-GCM加密。初次无UID使用连接变更通道，不造假UID或持久化密码，重启不恢复登录请求。登录/退出/切线入协调顺序，三线路按需测试；refreshToken未真实验证前明确不可用，保留重新登录。
- [x] 重跑连接测试及`pnpm test -- tests/http/connection.test.ts`，验证专用密码入口映射同一login RPC、业务错误与脱敏响应；检查日志/持久库无密码或摘要，PASS。任务11网页可用后安排任务27首次只读连接，凭证只在网页输入，不进聊天或仓库。
- [x] 提交：`feat: connect Qianji account and manage encrypted credentials`。

### Task 07：账单与标签的按页增量同步

**Files:** Create `src/features/sync/{contract,service,use-cases,incremental}.ts`、`fixtures/apk-454/sync-pages.json`、`tests/workers/incremental-sync.test.ts`；Modify protocol.operations。
**Interfaces:** Consumes Connection/Repository/Coordinator；Produces `SyncService.start(input:SyncInput):Promise<JobView>`、`getJob(scope:ActorScope,id:Id):JobView|null`；SyncInput有domain与`incremental/rebuild`模式，JobView有真实阶段/页进度/完整性，相关类型由sync.contract导出。

- [x] 写失败断言：各页沿用固定起始lasttimes和真实bookid/pageoffset/pagesign；中途失败不推进成功游标，已应用页不误报空集合；deletes按billid；分类与关联更新随页落库。
- [x] Run `pnpm test -- tests/workers/incremental-sync.test.ts`；预期FAIL于分页/落库链缺失。
- [x] 按APK实现`syncv2/pull`逐页事务和标签`tag/syncall`独立lasttime/page/分组变更；只在相应域完整后标成功。保留200次账单、40页标签保护及全量页间150–220ms节奏，截断不冒充完整；bootstrap资料并入其真实回执。
- [x] 重跑并测重复页、失效分页、标签失败与账单成功独立、未知响应结构不清库、上传阶段不绕过持久操作状态，PASS；记录标签时间窗口真实核验项，不自造安全游标。
- [x] 提交：`feat: synchronize Qianji incremental pages and tag groups`。

### Task 08：分层缓存、新鲜度合并、全量重建和跨请求连续任务

**Files:** Create `src/features/sync/{freshness,rebuild}.ts`、`src/storage/cache.ts`、`src/storage/sql/0004-cache.sql`、`tests/workers/{cache-policy,sync-lifecycle}.test.ts`；Modify coordinator/jobs、sync.service、Repository及actor.context。
**Interfaces:** Consumes任务05、07；Produces `ensureFresh(scope:ActorScope,domains:SyncDomain[],mode:FreshnessMode):Promise<FreshnessResult>`、`rebuild(scope:ActorScope,domains:SyncDomain[]):Promise<JobView>`；sync.contract导出FreshnessMode=`normal/manual-incremental`、FreshnessResult含freshness及可空job。仅rebuild任务起点清游标，active集合成功游标保持至切换。

cache.ts导出`CacheKey { domain:SyncDomain; queryKey:string }`、`CacheReadStamp {scope:ActorScope;key:CacheKey;datasetId:Id|null;generation:number}`、`ResourceRefresh {items:ResourceRecord[];complete:boolean;deletes?:Id[]}`及`ResourceCache.captureRead(scope:ActorScope,key:CacheKey):CacheReadStamp`、`applyRead(stamp:CacheReadStamp,result:ResourceRefresh):'applied'|'superseded'`、`invalidateSource(scope:ActorScope,key:CacheKey):void`。ResourceRefresh只表达本查询范围；记录validatedAt/changedAt/complete与源代次。列表、详情、选择器共享相应源域的写入代次和资源行，查询缓存只记录成员关系/顺序，不各存一份对象。业务写开始/回执和同步变更推进相关代次，失效派生结果；只有缺失或不可靠源数据才调用invalidateSource，完整回执不一概失效为需重新拉取。

- [x] 写失败断言：60秒内同域查询无新请求、并发冷查询只启动一任务；普通冷却5秒；重建首/中/末页排队写均在切换后执行且结果不丢；重建失败保留原集合与游标。
- [x] 写缓存失败断言：t=0校验、t=40读取、t=80仍需检查；t=50单条写不推迟t=65整域检查；完整空列表60秒内不再请求；重复/无变化页不推进数据revision；旧读A迟于写B确认到达不能覆盖B，UID/数据集切换同样拒绝旧响应。
- [x] Run `pnpm test -- tests/workers/cache-policy.test.ts tests/workers/sync-lifecycle.test.ts`；预期FAIL于缓存/生命周期缺失。
- [x] 实现ResourceCache与元数据迁移；源校验、业务变化和派生失效分开。资源过期只在使用时获取，保留SQLite副本；按需检查无变化时只更新validatedAt。对完整回执局部落库并更新依赖，不固定增加全域pull；不完整查询不标为已完整空集合。筛选列表为空只更新其查询成员，不能删除别的筛选或其他域资源；实体删除仅采已核对的明确删除或完整覆盖契约。旧响应应用前复核轻量代次，过时则保留新数据及必要失效状态，不重发写入。
- [x] 实现临时集合/同库切换、任务级远端写串行边界与短页事务；草稿/日志不随集合替换。允许未知写的只读核查使用重建，不互相等待；仅未发送或明确ID拒绝可继续的项进入push。
- [x] 重跑并测过期失败保留副本/陈旧状态、不自动持续重试；空的过滤查询不清其他资源、不伪装全域已校验；只重建tags不切ledger、断开页面后有限alarm续跑、恢复不重发未知写、冷却不使已发生写入变失败、任务终止后虚拟时钟推进10分钟上游计数不变，PASS。
- [x] 提交：`feat: merge on-demand refresh and rebuild mirrors safely`。

### Task 09：账单筛选、关系详情、日历与稳定分页边界

**Files:** Create `src/features/ledger/{contract,service,use-cases,query}.ts`、`tests/workers/ledger-query.test.ts`；Modify storage查询索引。
**Interfaces:** Consumes Repository/ensureFresh；Produces `LedgerService.list(input:BillFilter):Promise<BillPage>`、`detail(id:Id):Promise<BillDetail>`、`calendar(input:CalendarInput):Promise<CalendarView>`；BillPage游标绑定UID/数据集/筛选/修订。

- [x] 写失败断言：长ID、隐藏/多账本、父子分类、成员/标签/资产/备注/来源组合筛选正确；修订变化后旧页游标明确失效；主记录可加载区间外退款/报销子记录。
- [x] Run `pnpm test -- tests/workers/ledger-query.test.ts`；预期FAIL于查询实现缺失。
- [x] 实现有界索引查询及实际关系补载，支持设计§2全部筛选；组合报销22仅生成含真实成员ID的显示分组，未知类型保留；完整性/陈旧信息透出，不将缺失子账单补成零。
- [x] 重跑并测删除后分页、账号切换游标、单成员组、多组packId及聚合前后原始账单数不变，PASS。
- [x] 提交：`feat: query bills with relationship-aware pagination`。

### Task 10：共用收支、历史币种与预算执行计算

**Files:** Create `src/features/ledger/statistics.ts`、`src/features/budget/{contract,calculate}.ts`、`fixtures/apk-454/statistics.json`、`tests/unit/statistics.test.ts`、`tests/workers/statistics-read.test.ts`；Modify ledger.contract/service。
**Interfaces:** Consumes BillDetail/数字日期函数/分层缓存规则；Produces `toStatItem(bill:BillDetail,mode:'statistics'|'budget',currency:Id):StatItem`、`aggregate(items:Iterable<StatItem>):StatSummary`、`calculateBudget(input:BudgetCalculationInput):BudgetProgress`及`LedgerService.statistics(input:StatisticsInput):Promise<StatisticsView>`。StatisticsInput含BillFilter、目标币种、按日/月/年趋势、分类层级/标签/成员/资产维度及可选同期范围；View区分总额、分组、趋势、比较及不完整原因。查询键包含相关域修订、规范化筛选、实际业务日期/范围、时区和币种，资产债务汇总由任务16接入。

- [x] 写失败断言：已保存money90/transfee-10得到支出90/优惠10，不再扣到80；一月支出100二月退款30令一月70、二月退款独列30；待报销100无入账总支出0；本金不算收支，双flag独立，父子预算总额只算一次。
- [x] Run `pnpm test -- tests/unit/statistics.test.ts tests/workers/statistics-read.test.ts`；预期FAIL于统计模型未实现。
- [x] 按BillStatItem/StatSet与研究公式实现逐类型槽位，补历史src/target/base优先级、费用和舍入；有界补载/汇总，不用SQL浮点SUM或现汇重算。不完整数据、缺关联及异常超额flag组合明确标状态。
- [x] 增加缓存行为断言：源远端检查无变化不重复aggregate；源revision不变但跨过业务日/月起日边界时，“今天”、同期范围与预算日均可用正确换键；退款改变源历史期时对应缓存失效，不主动重算未被访问的无关期。不以60秒计时器重算全部统计。
- [x] 重跑完整研究向量，包含旧字段优先级、退款超额、三币种余数、同币种匹配优先级、闰年/合法自定义周期；正常组装type22不重复入统计。同一过滤结果的日/月趋势合计一致，分类层级/标签/成员/资产分组和同期比较仍使用同一StatItem口径；多标签分组允许重叠但总额不重复相加，PASS。
- [x] 提交：`feat: reproduce APK accounting and budget calculations`。

### Task 11：网页与MCP的只读纵向闭环

**Files:** Create `src/app/{use-case,registry,capabilities}.ts`、`src/contracts/{actions,capabilities}.ts`、`src/worker/{http,mcp}.ts`、`src/web/{App.tsx,api.ts}`、`components.json`、`src/web/lib/utils.ts`、按需`src/web/components/ui/`、`src/web/components/{Filters,DataStatus,TaskStatus}.tsx`、`src/web/pages/{Connection,Overview,Bills,Calendar,Statistics,Service}Page.tsx`、`tests/{http/actions,mcp/transport}.test.ts`、`tests/e2e/{connection,read-only}.spec.ts`；Modify `main.tsx/styles.css`、Vite/tsconfig别名、工具依赖和`docs/development.md`。
**Interfaces:** Consumes任务06–10；Produces上述共用调用契约，注册`connection.status/check/refresh/logout/selectRoute/testRoute`、`sync.start/status`、`ledger.list/detail/calendar/statistics`、`operations.get/reconcile`、`capabilities.list`；HTTP与MCP返回相同AppReply。`listCapabilities():CapabilityView[]`从已核对的动作元数据及运行连接/权益取得状态，View含动作、读写类型、协议/证据阶段、enabled/reason；不因mock成功自动启用。

- [x] 写失败断言：HTTP与MCP同筛选集合/金额/新鲜度一致；无账号返回连接页面地址；缺失能力给原因；超过10秒只返回running/jobId而不重复启动任务；MCP不暴露密码、SQL或任意上游请求工具；动态业务响应为no-store，浏览器不另开独立刷新轮询。
- [x] Run `pnpm test -- tests/http/actions.test.ts tests/mcp/transport.test.ts`；预期FAIL于注册和映射缺失。
- [x] 用SDK v2 per-request factory及`legacy:'stateless'`实现`handleMcp(request,env,ctx):Promise<Response>`；不存MCP会话。
- [x] 按frontend-app-builder、shadcn、react-best-practices技能在当前Vite项目初始化上述组件规范，完成中文响应式骨架、连接表单、只读页面及服务状态；登录走专用入口，其他操作走共用registry。过期时可用AppReply的running/data/freshness/jobId返回当前缓存并共享更新任务，网页先展示并注明时间/状态，MCP明确待更新；完整统计不能用半轮数据重算。不匹配当前数据修订的旧统计仅保留页面既有显示并标状态，不作为当前API统计结果返回。登录卡片、表格筛选、空态和弹窗复用已有组件，不复制全部APK外观或放演示数据。
- [x] 重跑协议两代initialize/discovery、tools/list/call、注解与错误测试及`pnpm test:e2e -- tests/e2e/connection.spec.ts tests/e2e/read-only.spec.ts`；桌面/360px手机宽度完成登录→同步→筛选→统计，键盘可提交与关闭弹窗，构建确实加载CSS，PASS。将真实Cloudflare出口/ChatGPT只读验证登记到任务27，不假定本地成功等于远程可用。
- [x] 浏览器补测上游延迟20秒时已确认缓存先显示“正在更新”，失败后仍可见；没有完整数据则显示任务/空态区别。查看任务进度不重启同步，MCP不把旧缓存描述为新校验结果。
- [x] 提交：`feat: expose shared read workflows in web and MCP`。

## M2：核心账务与资产

以下各业务任务同时修改本域`contract/service/use-cases`、`src/contracts/actions.ts`及`src/app/registry.ts`，增加对应Web表单/详情及MCP明确业务工具；不能只交付后端类或只做不可写的页面。所有上游操作先补`docs/protocol/454/<domain>.md`和对应脱敏fixture的载荷、头、响应及省略/清空语义。

### Task 12：普通收支、待报销支出的增删改与批量结果

**Files:** Create `src/features/ledger/write.ts`、`src/web/components/BillEditor.tsx`、`tests/workers/ledger-write.test.ts`、`tests/e2e/bill-write.spec.ts`；Modify ledger域、BillsPage、registry和protocol.operations。
**Interfaces:** Consumes Coordinator/Repository；Produces `LedgerService.create(input:CreateBillInput,meta):Promise<OperationView>`、`edit(input:EditBillInput,meta)`、`remove(input:DeleteBillsInput,meta)`；动作`ledger.create/edit/delete`，输入明确金额、费用、时间、分类、资产、标记和选择性变更，不开放raw v。

- [x] 写失败断言：录入100优惠-10保存money90，未知extra保留；同一写键重放只一笔；批量部分成功不重发成功项；网络未知时UI/MCP保持operationId，不提示重新创建。
- [x] Run `pnpm test -- tests/workers/ledger-write.test.ts`；预期FAIL于普通写用例缺失。
- [x] 实现APK普通整笔上送/删除及状态回执，普通保存走push-only，不每次先拉全域。网页草稿保存稳定requestId直至结果确定，新增与编辑分开；仅明确新建ID拒绝才换ID并留映射，一轮5批/每批200边界不改成每项5次重试。源子关联删除由14–15接入，之前明确不可操作而非孤立删父行。
- [x] 重跑及`pnpm test:e2e -- tests/e2e/bill-write.spec.ts`；覆盖刷新/重开草稿、长ID、模拟业务失败、同键异参，PASS。
- [ ] 执行对应真实小额测试后才启用该写能力：第18步建立专用测试账本后闭环核验，第27步统一真实回归。现有账本保持只读。
- [x] 提交：`feat: write bills with stable keys and itemized receipts`（sanitized-history）。

### Task 13：转账与信用卡还款

**Files:** Create `src/features/ledger/transfer.ts`、`src/web/components/TransferEditor.tsx`、`tests/workers/transfer.test.ts`；Modify ledger contract/service/use-cases、BillsPage和registry。
**Interfaces:** Consumes任务12；Produces `LedgerService.transfer(input:TransferInput,meta)`及`repayCard(input:CardRepaymentInput,meta)`；支持编辑与删除同一真实记录，两个动作复用已核对资产变更算法。

- [x] 写失败断言：输入103/手续费3→本金100、转出-103/转入+100；输入100/优惠-10→本金90、转出-90/转入+100；有curr采用targetValue；两相同或借贷资产拒绝。
- [x] Run `pnpm test -- tests/workers/transfer.test.ts`；预期FAIL于转账用例缺失。
- [x] 实现type2/3载荷，编辑按资产ID合并旧回滚/新增变动；新信用卡还款仅向前更新lastPayTime，删除不自行恢复上一日期；Web/MCP显示本金、费用、两侧币种的实际含义。资产变动与日期保留为明确的预期值，不覆盖钱迹回读确认值。
- [x] 重跑并测A→B改B→A各资产只更新一次、本金不入普通收支/预算、旧记录未知扩展保留，PASS；已补备注编辑不清费用、未知操作核清后恢复队列及新旧资产保护回归。
- [ ] 第16/18步准备专用测试资产与账本后，真实核对两侧余额和账单，第27步统一回归；公开写动作保持未启用。
- [x] 提交：`feat: reproduce transfer and card repayment rules`（sanitized-history）。

### Task 14：退款创建、编辑与关联删除

**Files:** Create `src/features/ledger/refund.ts`、`src/web/components/RefundEditor.tsx`、`tests/workers/refund.test.ts`；Modify ledger域和统计缓存失效范围。
**Interfaces:** Consumes任务09–12；Produces `LedgerService.refund(input:RefundInput,meta)`；RefundInput区分源billId与可选refundBillId。删除用同一ledger.delete入口展开已核对的父子影响。

- [x] 写失败断言：refund2回执整组源/子一起应用；跨期退款使源历史月/分类/预算失效；已有25次拒绝继续新增；有退款的源记录不能切类型；失败不自行造收入或只改rfds。
- [x] Run `pnpm test -- tests/workers/refund.test.ts`；预期FAIL于专用退款缺失。
- [x] 实现refund2的did/v、嵌套currency编码及编辑旧退款ID；使用回执和资产差额算法。源删除/子删除按APK关联处理、回滚预期和逐项删除状态，日志记录全部关联ID。APK未上传源关系修改，故单独删退款后另保留源关系只读核查项，不臆造源changelist。
- [x] 重跑24/25次、旧/新退款字段优先级、跨币种/换资产、超额输入与未知回执向量，PASS；备注/图片/标签清空尚未证实，明确拒绝并列入真实核验，不能自定全部refund≤remaining。
- [ ] 第16/18步准备新测试资产与账本后，真实验证回执、空值清理和关联删除；第27步统一回归。公开写入继续门控。
- [x] 提交：`feat: manage refunds and source bill relationships`（sanitized-history；真实验收另列）。

### Task 15：报销分配、取消与组合显示

**Files:** Create `src/features/ledger/reimbursement.ts`、`src/web/pages/ReimbursementsPage.tsx`、`tests/workers/reimbursement.test.ts`；Modify ledger域、BillsPage、关联删除和registry。
**Interfaces:** Consumes任务14；Produces `LedgerService.reimburse(input:ReimburseInput,meta)`、`cancelReimbursement(input:CancelReimbursementInput,meta)`；输入源ID集合、入账资产、总额/币种/日期，输出跟踪真实源/子ID。

- [x] 写失败断言：按源时间升序、末笔接余数；两个剩余各50、入账120的本地分配为50/70而非均分；官方inAsset只应用一次；取消保留type5；type22不生成云端ID或重复统计。
- [x] Run `pnpm test -- tests/workers/reimbursement.test.ts`；预期FAIL于报销用例缺失。
- [x] 实现baoxiao专用载荷、三币种分配/余数及整组回执；取消与“取消待报销属性”分开。批量修改/删除组合行先展开真实21成员，必要时按packId读取成员；保留旧字段兼容，不自动upgradev2或复制硬编码特例账号。
- [x] 重跑新旧混存、取消子记录/源关系/资产、超过本金及多币种余数、缺失关联不可伪装完整统计，PASS；真实核查旧数据升级影响仅在明确请求下进行。
- [ ] 第16/18步准备专用测试资产与账本后真实核验报销回执、取消源子关系及资产变化；第27步统一回归。公开写入继续门控。
- [x] 提交：`feat: support reimbursements with APK allocation semantics`。

### Task 16：资产资料、分组、余额差额和结清

**Files:** Create `src/features/assets/{contract,service,use-cases,summary,balance,groups,finish}.ts`、`src/web/pages/AssetsPage.tsx`、`tests/workers/assets.test.ts`；Modify resources/registry/protocol.operations。service只编排，差额/分组/结清各自聚焦文件。
**Interfaces:** Consumes tasks05–12；Produces `AssetService.list/summary/submit/reorder/setVisible`、`adjustBalance(input:BalanceAdjustmentInput,meta)`、`setFinished(input:DebtFinishInput,meta)`、分组与delete/check方法；各方法在contract导出对应Input/View，mutations返回OperationView。

- [x] 写失败断言：差额可选，不记差额不造账单；账号内未同步普通账单阻止余额调整而非只看当前资产；type6包装项不重复汇总，借贷方向/incount/信用卡分期选项生效；结清目标绕过60秒旧缓存。
- [x] Run `pnpm test -- tests/workers/assets.test.ts`；预期FAIL于资产域缺失。
- [x] 按APK各资产类型建明确表单，资产submit可选diffparams；实现官方asset_group动作、删除检查和关联提示、历史资产趋势的已核对来源。finish仅在最新状态未达目标时一次调用，回执不足则核查；结清不清零余额或替代还款。
- [x] 重跑未知写恢复不反向finish、普通资产/借贷删除前提不同、缺真实历史不伪造趋势、差额回执与关联账单核对，PASS；真实只读核对正常列表、类型、空分组及详情。
- [ ] 第27步在限定验收环境创建命名测试资产，逐项验证资产/分组/差额/结清/删除写入；当前写能力继续门控。
- [x] 提交：`feat: manage assets and native balance adjustments`。

### Task 17：借贷创建、追加、本金偿还与利息

**Files:** Create `src/features/debt/{contract,service,use-cases,accounting}.ts`、`src/web/pages/DebtPage.tsx`、`tests/workers/debt.test.ts`；Modify AssetsPage和registry。
**Interfaces:** Consumes任务12/16；Produces `DebtService.create/appendPrincipal/editPrincipal/pay`，分别使用`CreateDebtInput/AppendPrincipalInput/EditPrincipalInput/DebtPaymentInput`及CallMeta；pay返回包含本金/利息逐项状态的OperationView。

- [x] 先核对借贷资产创建是否由官方生成初始本金记录，形成独立fixture，防止本地再次生成。写失败断言：C=-100偿还本金30/利息5→C=-70、现金一次-35、统计支出5；输入120按APK拆100本金/20利息；纯利息无本金记录。
- [x] Run `pnpm test -- tests/workers/debt.test.ts`；预期FAIL于专用借贷分派缺失。
- [x] 实现6/7、9/4、10/11的真实assetid/fromid/targetid映射及LoanInfo更新；本金/利息独立ID和回执，放入账单同步，不另造归还API或多一次资产submit。保留编辑/删除边界、非本位币拒绝、金额上限9,999,999,999及缺LoanInfo处理。
- [x] 重跑追加与编辑差额、换资产、本金成功利息未知、单删本金保留利息、余额符号夹取，PASS（15个核心/来源测试、HTTP草稿与保护、桌面/手机交互）。
- [ ] 真实核查两条账单/资产/LoanInfo，不能以批次HTTP成功承诺原子性（按已定隔离测试策略，在任务27仅用新建专用测试账本/资产验收）。
- [x] 提交：`feat: implement principal and interest debt workflows`。

## M3：完整资料与高级业务

### Task 18：账本、成员资料与业务配置

**Files:** Create `src/features/books/{contract,service,use-cases}.ts`、`src/web/pages/BooksPage.tsx`、`tests/workers/books.test.ts`；Modify registry及共享筛选。
**Interfaces:** Consumes资源镜像/Coordinator；Produces `BookService.list/submit/configure/reorder/setVisible/members/checkDelete/delete/quit`；各方法有对应本域Input/View，保留上游owner/member身份，不建设本服务RBAC。

- [x] 写失败断言：退出与删除使用不同动作；owner/member过期、默认账本和未结事项影响正确；旧has_unresolved与新owner/member字段兼容；隐藏账本仍可明确查询。
- [x] Run `pnpm test -- tests/workers/books.test.ts`；预期FAIL于账本管理缺失。
- [x] 实现官方账本动作及影响统计的本位币/range等配置；成员已有操作逐项核对真实表单/权限后注册，不因为单人服务忽略云端角色，不自造邀请流程。写后更新回执/失效依赖缓存，Web/MCP共享业务配置。
- [x] 重跑创建/编辑/排序/显隐、删除检查与退出、配置变化使统计/预算依赖正确失效，PASS；17个本域用例、跨服务接入、共享筛选及桌面/手机交互通过。
- [ ] 真实写入核查延至任务27，仅使用新建专用测试账本；涉及其他成员或全局业务配置实际变更仍须符合用户具体命令和测试范围。
- [x] 提交：`feat: manage books and accounting configuration`。

### Task 19：分类层级、移动、排序与删除迁移

**Files:** Create `src/features/categories/{contract,service,use-cases}.ts`、`src/web/pages/CategoriesPage.tsx`、`tests/workers/categories.test.ts`；Modify registry。
**Interfaces:** Consumes BookService/资源镜像；Produces `CategoryService.list/submit/reorder/changeLevel/move/checkDelete/delete`；DeleteCategoryInput明确did、deleteBills及可选newCategoryId，不暴露通用级联选项。

- [x] 写失败断言：有子类父分类先拒绝删除；check的count/other完整呈现；迁移调用deletev2/newcateid而非本地逐笔重写；其他成员引用不能靠本地数量假定不存在。
- [x] Run `pnpm test -- tests/workers/categories.test.ts`；预期FAIL于分类管理缺失。
- [x] 实现submitv2/reorder3/changelevel/movesubcate/deletecheckv2/deletev2，保留类型/账本/父ID前提与未知字段；更新源/目标分类及受影响账单、预算和任务的核查范围。
- [x] 重跑层级变更与移子类、替换/保留/删除策略、部分/未知结果不盲级联，PASS；网页/MCP相同参数触发相同上游动作。
- [x] 提交：`feat: manage category hierarchy and native migration`。

实现阶段已验证；实际写入验收仍由 Task27 完成。

### Task 20：标签、分组、归档与恢复

**Files:** Create `src/features/tags/{contract,service,use-cases}.ts`、`src/web/pages/TagsPage.tsx`、`tests/workers/tags.test.ts`；Modify标签资源与registry。
**Interfaces:** Consumes tag/syncall/Coordinator；Produces `TagService.list/submitTag/submitGroup/reorderTags/reorderGroups/setArchived/deleteTag/deleteGroup`；setArchived输入明确目标，不直接把toggle开放为幂等设置。

- [x] 写失败断言：删组后含归档标签在内groupId=null且标签/账单保留；归档以返回Tag替换且不清账单标签；手机先归档而服务缓存未变时，再要求归档不会反向切换。
- [x] Run `pnpm test -- tests/workers/tags.test.ts`；预期FAIL于标签管理缺失。
- [x] 实现各原生动作、组与标签独立排序及颜色/名称实际校验；setArchived按最新上游状态一次调用并核查，权益/数量从当前账号证据取得，不照搬旧服务常量。
- [x] 重跑新旧同步接口共存、删除标签后的实际引用核查、结果不明不重发归档，PASS；页面选择器可识别历史归档引用。
- [x] 提交：`feat: manage tags groups and archive state`。

实现阶段已验证；实际写入验收仍由 Task27 完成。

### Task 21：预算配置与执行进度页面

**Files:** Create `src/features/budget/{service,use-cases}.ts`、`src/web/pages/BudgetPage.tsx`、`tests/workers/budget.test.ts`；Modify budget.contract/registry。
**Interfaces:** Consumes任务10、18、19；Produces `BudgetService.list(input:BudgetQuery):Promise<BudgetView>`、`submit(input:BudgetChangesInput,meta):Promise<OperationView>`；配置请求包含bookId、DateFilter、原生range及changelist。

- [x] 写失败断言：不同range/日期不共用缓存；submit使用响应预算集合，不把输入当最终结果；父子used各100但总额100；排除预算与排除收支分别生效。
- [x] Run `pnpm test -- tests/workers/budget.test.ts`；预期FAIL于预算配置用例缺失。
- [x] 实现list/submitv2、总/分类月度与年度预算、日均可用及执行进度；本地执行计算复用任务10，响应daystats按真实模型处理。不自加预算结转/复制任务，也不凭BookConfig的季度range宣称独立季度预算写能力。
- [x] 重跑自定义月界、零/取消预算的已核对载荷、退款源历史期失效、submit返回值与查询一致，PASS；真实与官方页面对照。
- [x] 提交：`feat: manage budgets with native book periods`。

实现阶段已验证；真实写入及官方页面数值对照仍由 Task27 完成。

### Task 22：官方图片上传、关联与展示

**Files:** Create `src/features/attachments/{contract,service,use-cases,upload}.ts`、`src/web/components/Attachments.tsx`、`src/worker/upload.ts`、`tests/workers/attachments.test.ts`、`tests/e2e/attachments.spec.ts`；Modify已支持图片的业务表单与registry。
**Interfaces:** Consumes任务03、05及图片业务；Produces `AttachmentService.upload(input:UploadImageInput):Promise<OperationView>`、`result(operationId):UploadedImage|null`、`resolve(input:ImageReferenceInput):Promise<ImageView>`；UploadedImage的有效凭据是已确认上游对象key，上传字节与登录token不得混淆。

- [x] 先核对原生预处理格式/大小、token及上传区/凭证/响应key契约；写失败断言：过期前60秒不再复用token，数量取配置而非硬编码6，上传未成功没有可关联key，普通URL不是上传成功证明。
- [x] Run `pnpm test -- tests/workers/attachments.test.ts`；预期FAIL于附件链路缺失。
- [x] 通过Web标准HTTP/流或有界FormData接入官方对象存储，不引入Node七牛原生依赖或R2。网页文件上传和MCP有界base64输入转换为同一UploadImageInput；未提供实际图片字节的ChatGPT调用给网页上传入口，不承诺平台会自动传图片文件。按已核对协议预处理；移除账单引用不声称销毁云端对象。
- [x] 重跑测试及`pnpm test:e2e -- tests/e2e/attachments.spec.ts`；覆盖凭证失效、对象上传成功但账单失败、重复回调不重复关联、实际图片展示，PASS。若官方链路确需持久暂存，再提出有证据的R2变更，不默认绕过去。
- [x] 提交：`feat: upload and associate official Qianji images`。

实现阶段已验证；真实官方上传与关联验收仍由 Task27 完成。

### Task 23：周期规则预览与任务管理

**Files:** Create `src/features/repeat/{contract,service,use-cases,preview}.ts`、`src/web/pages/RepeatPage.tsx`、`tests/unit/repeat-preview.test.ts`、`tests/workers/repeat.test.ts`；Modify registry。
**Interfaces:** Consumes资料/资产/附件；Produces `RepeatService.list/submit/preview/setPaused/setBillBinding/delete`；分别使用RepeatQuery/RepeatInput/RepeatPreviewInput/PauseTargetInput/PlanBindingInput/DeleteRepeatInput，写返回OperationView、预览返回不持久化的PreviewBill[]。

- [x] 写失败断言：月末32、291/301、间隔日、结束次数/日期按APK；缺官方节假日年映射不退化为工作周；手机先暂停后服务再要求暂停不反向toggle；当前绑定U而请求解绑T不发T.bindbill。
- [x] Run `pnpm test -- tests/unit/repeat-preview.test.ts tests/workers/repeat.test.ts`；预期FAIL于周期域缺失。
- [x] 实现任务查询/创建/修改/排序筛选、暂停恢复、结束条件和删除；预览只展示，不上送生成的Bill。提交应用官方task+bills，绑定用已有billId及具体packId；不凭状态常量开放手动finished/resetCount，不建Worker定时出账。
- [x] 重跑规则修改保留旧账单、状态0/1启停前提、最新状态核查、submit与binding结果不明只读恢复，PASS；将所有手机离线/服务闲置时执行条件交任务27实测。
- [x] 提交：`feat: manage recurring tasks with native date previews`。

实现阶段已验证；真实出账、手机离线条件及官方执行对照仍由 Task27 完成。

### Task 24：分期新增、统计配置与提前还款

**Files:** Create `src/features/installments/{contract,service,use-cases,preview}.ts`、`src/web/pages/InstallmentsPage.tsx`、`tests/unit/installment-preview.test.ts`、`tests/workers/installments.test.ts`；Modify registry。
**Interfaces:** Consumes任务13、22及PlanBindingInput；Produces `InstallmentService.list/create/preview/configure/prepay/setBillBinding/delete`，配置仅已确认incount/feeincount，提前还款使用独立PrepayInput。

- [x] 写失败断言：新增count按首期日/今天及totalCount计算，不固定0或自行补历史账；手续费ave/first/last及尾差first/last/rndf/rnd/intf/intl与独立APK向量匹配；已有对象不开放任意金额/期数编辑。
- [x] Run `pnpm test -- tests/unit/installment-preview.test.ts tests/workers/installments.test.ts`；预期FAIL于分期域缺失。
- [x] 实现官方提交/config/prepay和关联动作，预览与正式回执bills分开；提前还款的支出/还款结果各跟踪，不再次本地生成。先专项核对images疑似错误载荷，正确契约未确认不盲抄备注到images；新建入口仅证实type1，采用通用分期及明确统计选项，不虚构type2变体；提前还款图片待任务27专项核验。
- [x] 重跑首期今天/过去/未来、首末期与除不尽、目标packId/重复解绑、prepay部分或未知结果及附件分支，PASS；真实核对任务状态、两笔账单和资产移交任务27；当前正式写能力未启用。
- [x] 提交：`feat: implement installment configuration and prepayment`。

### Task 25：储蓄计划、存入、撤销与删除

**Files:** Create `src/features/savings/{contract,service,use-cases,projection}.ts`、`src/web/pages/SavingsPage.tsx`、`tests/workers/savings.test.ts`；Modify registry。
**Interfaces:** Consumes资产/账本/附件；Produces `SavingsService.list/submit/reorder/project/deposit/cancelDeposit/delete`；明确planId/transId为原样字符串，DepositInput有可选billInfo，DeleteSavingsInput明确deleteBills。

- [x] 写失败断言：计划计算行不当实际交易；无billInfo只存交易，有则采用官方transaction/bill；撤销传transId并核查关联账单删除；删计划deleteBills=0/1影响分开。
- [x] Run `pnpm test -- tests/workers/savings.test.ts`；预期FAIL于储蓄域缺失。
- [x] 实现已确认七个创建入口的规则/预览、编辑名称规则及排序；保存原始字符串ID和秒/毫秒边界。random仅枚举和适配器发现，已确认七分支无新建入口，明确不开放随机创建；不改历史交易或按计算行定时deposit，不自行再写一笔转账。
- [x] 重跑关联账单已删/未删、存入/撤销响应丢失、规则改动不重写历史、模式币种校验和删除策略，PASS；真实同时检查plan/transaction/bill/资产移交任务27；正式写能力未启用。
- [x] 提交：`feat: manage savings plans and linked deposits`。

## M4：整体验证与发布

### Task 26：完整网页、MCP覆盖与性能收尾

**Files:** Modify `src/web/{App.tsx,styles.css}`、所有页面/共用组件、registry与各域输出映射；Create `tests/e2e/full-app.spec.ts`、`tests/mcp/coverage.test.ts`、`tests/workers/performance.test.ts`、`docs/acceptance/local-matrix.md`。
**Interfaces:** Consumes所有已实现use-case；Produces完整路由/导航和Web/MCP能力覆盖表；不增加新的账务公式或一套页面专用后端。

- [x] 写失败断言：设计§2每项可实现能力至少对应Web操作、MCP工具、所属契约/测试及状态；不依赖金额label猜单位；所有写视图能区分排队/未知/部分/已确认。
- [x] Run `pnpm test -- tests/mcp/coverage.test.ts tests/workers/performance.test.ts`和`pnpm test:e2e -- tests/e2e/full-app.spec.ts`；预期先FAIL于明确缺口，不能仅断言注册工具数量。
- [x] 完成总览/账单日历/统计/资产借贷/预算/周期分期/储蓄/资料/服务管理的桌面与手机交互，筛选与状态共用，并沿用任务11的Tailwind/shadcn组件与语义变量；页面不混演示账、内部签名术语或APK系统设置。按React最佳实践消除可测瀑布/重复读取，索引/修订缓存及有界统计不改变口径。
- [x] 按frontend-testing-debugging技能做渲染与交互检查，工具控制优先可用Browser插件，回归保留Playwright；记录选择工具原因及截图到忽略的`.artifacts/qa/`。核对360px/桌面长中文、长ID/金额、表单错误、表格滚动与弹窗焦点，不对CSS类名写镜像断言。网络被fake延迟20秒时本地状态请求仍能完成且先于上游释放；冷热/年度统计记录实际CPU和读写量，不编造提速倍数。
- [x] 重跑上述回归及`pnpm verify`，全部PASS后提交：`feat: complete responsive web and MCP feature coverage`。

实施记录：本地覆盖见 `docs/acceptance/local-matrix.md`；真实写入与发布验收仍属于任务27/28。Web普通账单逐笔维护，批量数组通过MCP；两者范围在覆盖表明确列出。

### Task 27：逐域真实验收与能力放行

**Files:** Create `tools/acceptance/{run,cases,scope}.mts`、`docs/acceptance/{live-matrix,conflicts,protocol-gaps}.md`、`tests/workers/capabilities.test.ts`；Modify各域fixture/能力状态与协议记录，必要修复回所属任务文件。
**Interfaces:** Consumes所有use-case、明确测试UID/账本/资源清单；Produces逐操作read/write验收状态及证据，不把mock-tested自动变为live-verified。

- [x] 写失败断言：未live-verified的正式写能力返回unavailable原因；验收模式只允许明确测试UID及账本/资源ID，拒绝真实生活数据目标；fixture与日志不含密码/token或个人原始账单。
- [x] Run `pnpm test -- tests/workers/capabilities.test.ts`；预期FAIL于能力/验收范围约束缺失。
- [x] 实现`pnpm acceptance -- <case>`，在独立本地/预览环境复用生产实现并注入限定测试能力，生产不开放任意写入开关或原始请求接口。测试账户、账本和命名资源未明确时只准备好用例后询问；已有授权直接沿用。登录仍在网页输入，不从聊天收密码。
- [ ] M1起逐域执行相应用例：真实签名/三线路/只读同步；普通写回执→回拉→官方客户端；长ID/币种/跨期/删除/差额/本金利息/储蓄/计划/图片；手机离线的计划执行；多端同/异字段修改、删改交叉、ID冲突、响应丢失。记录提交顺序、实际响应、查回及客户端结果，既定测试对象清理也逐项记录，不自动清空账本。
- [ ] 记录缓存真实向量：手机修改后普通查询在源校验过期时按需获取、显式增量绕过60秒但不清游标；空预算/空计划重复读取请求数、写回执后新增请求数、无变化检查与统计重算数。注明60秒是检查策略，没有闲置轮询或跨设备即时推送保证。
- [x] 对未确认的标签窗口、旧报销升级、images疑点、random/resetCount入口等逐条关闭证据或保留具体不可用原因；修复后运行对应回归与真实用例，验收矩阵每个范围都有结果。实际接口/权限限制须报告，不用mock通过替代，也不无声删功能。
- [x] 提交脱敏证据/修复及能力更新：`test: verify Qianji workflows against real upstream results`。真实个人数据和凭证不提交。

当前：提供范围内的原生业务补验完成，见live-matrix.md与protocol-gaps.md。用户已在早期审批拒绝之后明确“全部验收后全部启用”；正式Web/MCP写入现已统一启用，不再等待授权。原生不支持及未明确输入有具体限制，本位币修改、全局排序与成员操作按用户要求不提供。手机普通净额已确认；手机离线执行、实际手机并发和真实ID冲突未观察，所以不勾选包含这些要求的复合验收项。

### Task 28：部署、ChatGPT联调、升级与恢复交付

**Files:** Create `docs/{deployment,maintenance,release}.md`、`tools/ops/maintenance.mts`、`tests/workers/maintenance.test.ts`；Modify wrangler配置、package脚本和生产能力清单。
**Interfaces:** Consumes通过验收的构建与能力清单；Produces一个Cloudflare生产Worker/单SQLite DO/静态资源部署，实际`/mcp`连接说明、Secret配置与恢复步骤。维护工具只走受控运维路径，不增加公开SQL/恢复API。

- [x] 写失败断言：维护状态即使数据库恢复出旧queued操作也不发送；解除暂停前须完成与钱迹现状核查；普通restart保留deviceId/UID/操作且不重新全量；预览与生产命名空间隔离。
- [x] Run `pnpm test -- tests/workers/maintenance.test.ts`；预期FAIL于维护恢复规则缺失。
- [x] 实现维护/恢复流程与SQL迁移说明，配合Cloudflare官方PITR；Worker Secret不随数据库恢复丢失，回退的操作状态不能冒充未发送。记录Code回滚与DB兼容边界、用量查看及付费开通方式，不实现产品内导出或运维后台。
- [ ] Run `pnpm verify`及生产配置dry-run，检查实际打包无Android/Node原生依赖、无D1/Cron/常驻连接、Secret示例无真实值；整理版本、迁移、已验收能力与已知限制，再对已授权Cloudflare目标部署，不提前购买套餐或随意选择账户/域名。
- [ ] 从实际入口验证网页/手机号或邮箱登录/MCP协议与工具调用；按用户Cloudflare保护规则测试ChatGPT可达、只读与受控写入、10秒任务返回/状态跟踪。完成在途任务后真实观察至少10分钟，上游请求计数不再增长；保存实际URL/版本/验收结论，不把dry-run当部署成功。
- [ ] 提交：`docs: deliver Cloudflare deployment and verified operations guide`。只有真实部署和ChatGPT验证完成才标记M4交付；缺少外部账号权限时说明具体缺项，继续完成不依赖该项的本地交付。

本地维护实现、隔离预览构建、生产 dry-run、运维文档与一次整支独立审查均已完成；四项 P2 已分别复现并修复，详见 `docs/acceptance/final-review.md`。本地持续10分钟闲置计数0增量通过。用户已明确本次暂不部署，只完成代码、审查和部署文档。本地验证及部署预检已通过；生产URL、实际ChatGPT、远端PITR与生产观察留待部署，原计划M4生产验收未执行。

## 依赖、验收和执行交接

### 依赖规则

- 默认按任务编号顺序执行。01–08和11固定公共接口；不得因某页面可单独编码而跳过协议/恢复门槛。03受阻时只做不依赖真实协议的本地任务，不能用mock数据宣布M1完成。
- 任务12的简单写先闭环，再扩展13–17关联写；18–25各域可在接口稳定后独立安排，但不并行编辑registry/共用契约/数据库迁移。是否用子代理由用户选择，计划阶段不自行启动实现。
- 任务27为贯穿式真实验收，M1首次可连接后就启动只读用例，每个写域完成后执行其用例；最终统一清单。28的目标/权限缺失不阻断其他测试、构建或文档准备。
- 每个任务的“提交”只包含该任务实际改动和必要共享注册；先看diff再暂存明确文件。任务间保存接口与验收结果，不能只回复“功能完成”而不记录验证方式。

### 主设计覆盖表

| 主设计范围 | 实现任务 | 最终验证 |
| --- | --- | --- |
| 单人免应用鉴权、Workers Paid/SQLite DO、共用领域层 | 01、04–06、11、28 | 本地/生产绑定与访问、无额外登录层 |
| 新版签名、身份头、编码、长ID和金额、稳定设备 | 02–03、06 | 独立向量、workerd与真实请求 |
| 按需60秒、冷却5秒、分页/标签/删除/全量/闲置 | 07–08 | 故障顺序向量、真实10分钟闲置 |
| 本地优先、源/派生分层、有效空集合、校验时间及慢读保护 | 08、10–11、27 | 空结果/非滑动/局部写/跨日/响应乱序及请求计数 |
| UID写键、逐项状态、未知结果、ID映射、恢复 | 05、08、12、27–28 | 发送计数、故障注入和双端实验 |
| 账单筛选/详情/日历/统计/预算计算 | 09–11、21、26 | APK向量及Web/MCP同条件同结果 |
| 普通账单/转账还款/退款报销/组合显示 | 12–15 | 整组记录/资产/历史期间核对 |
| 资产分组、差额、趋势、借贷与结清 | 16–17 | 真实命名对象及账户统计 |
| 账本/成员/业务周期、分类/标签及关联处理 | 18–20 | 角色/删除/迁移/归档及回拉 |
| 图片、周期/分期/储蓄及关联账单 | 22–25 | 实际上传/生成/撤销/删除边界 |
| 全部中文响应式页面、MCP Schema/注解/任务 | 11–26 | 桌面/手机、两代协议、实际ChatGPT |
| Tailwind CSS、统一组件/图标、页面美化与可访问交互 | 01、11、26 | 实际CSS产物、360px与桌面渲染/键盘验收 |
| 日志脱敏、升级/PITR、用量及部署文档 | 03、05–06、26–28 | 仓库检查、迁移/恢复演练及部署记录 |
| 仍待证实的协议/权益/历史异常及不可用能力 | 每个业务任务、27 | 逐项证据和具体限制，不静默降级 |

### 完成标准

本地 `pnpm verify` 通过且构建可部署；主设计每个范围有Web/MCP入口、契约、状态与验收结果；真实写入完成回执/回拉/官方客户端对照；实际Cloudflare与ChatGPT可用；无空闲上游请求；未知写和恢复不产生重复账务。模拟、静态、真实、已启用四类结果分别说明，不能互相替代。

### 自审清单（计划编写者执行，不派发子代理）

- [x] 对照主设计全部章节，覆盖表没有未分配需求。
- [x] 检查每任务文件、类型/方法名、生产接口与测试接口依赖一致；未来文件用代码路径表示，不伪装成已存在成果。
- [x] 每步骤有明确动作/断言/通过标准，不用“完善相关功能”代替业务规则，也不提前写整段实现。
- [x] Review Focus五项各有所属测试，尤其签名门槛、未知写不重放、UID、重建、目标packId及缺失子记录。
- [x] 文档链接、编号、围栏和空白检查通过；计划测试命令仅为未来执行，不宣称已运行产品验收。

### 执行方式建议

推荐由主代理顺序实现，按上述接口和门槛推进，并在整个分支完成时做一次独立审查：协议、存储、恢复和账务跨任务依赖密集，顺序执行能减少接口衔接成本。另一选择是逐任务子代理实现并独立审查，检查更细但会增加上下文与审查开销。用户已确认更新计划并选择主代理顺序实现、最后统一独立审查；使用executing-plans，当前执行进度见逐任务勾选与台账。

## 参考材料

- [APK逻辑汇总](../../research/2026-10-18-apk-logic-audit.md)、[最终边界复核](../../research/2026-10-18-apk-final-design-review.md)、[Cloudflare选型](../../research/2026-10-18-cloudflare-paid-final-review.md)。
- [APK与当前方案缓存/更新比较](../../research/2026-10-18-apk-cache-update-comparison.md)：1–12小时分支证据、采用理由及完整缓存顺序向量。
- [同步/登录](../../research/2026-10-18-apk-sync-auth-audit.md)、[冲突](../../research/2026-10-18-apk-conflict-analysis.md)、[账单/统计/借贷](../../research/2026-10-18-apk-bills-statistics-audit.md)、[资产/资料/图片](../../research/2026-10-18-apk-assets-catalogs-audit.md)、[计划类业务](../../research/2026-10-18-apk-scheduled-plans-audit.md)。
- [Cloudflare Vite集成](https://developers.cloudflare.com/workers/vite-plugin/)、[Workers测试](https://developers.cloudflare.com/workers/testing/vitest-integration/)、[SQLite DO API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)。
- [MCP SDK v2](https://github.com/modelcontextprotocol/typescript-sdk)、[无状态与兼容HTTP handler](https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/server/server/createMcpHandler.html)、[Vite运行要求](https://vite.dev/guide/)。执行时复核实际锁定版本，不照抄会变化的在线main接口。
- [Tailwind CSS Vite安装](https://tailwindcss.com/docs/installation/using-vite)、[shadcn Vite安装](https://ui.shadcn.com/docs/installation/vite)、[Tailwind v4兼容](https://ui.shadcn.com/docs/tailwind-v4)、[shadcn CLI](https://ui.shadcn.com/docs/cli)。2026-10-18核对Tailwind文档标示4.3；具体patch和组件CLI在实际安装时锁定。

## 2026-10-19 本地交付范围更新

依用户后续决定：本位币修改、全局排序、账本成员功能不提供；Cloudflare真实部署暂不执行。任务12–25原生业务已在新建测试资源上补验，具体限制保留，不以未勾选的早期复合条目误示仍等待用户权限。任务27的手机离线未来执行/真实手机竞争与任务28的生产验收继续明确列为未执行，不属于本次代码与文档交付。统一开放后的严格类型、467后端测试、116桌面/手机页面测试、构建及dry-run通过。最终整支独立审查覆盖后续原生修复，结果见docs/acceptance/final-review.md。
