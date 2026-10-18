# 钱迹 4.5.4 APK：资产、预算与资料管理审查

- 日期：2026-10-18
- 样本：`qianji_454_1234_gw.apk`，`com.mutangtech.qianji`，4.5.4 / 1234，MT workspace `rxvx4qt6`
- 对照：[主设计](../superpowers/specs/2026-10-18-qianji-workers-design.md)
- 范围：资产及借贷、结清、预算、账本、分类、标签、图片附件；只读静态研究，未修改 APK、主设计或产品，未请求真实钱迹业务 API。
- 证据来源：MT MCP 的 DEX outline、方法 Smali、交叉引用。下文 locator 可直接用于 `mt_apk_read_text`。`dispatch` 交叉引用仅用于寻找调用者，结论以读取后的方法体为准。
- 缓存：`$env:TEMP\qianji-requirements-20261018\assets-*`；缓存是研究辅助，文中已保留关键 locator 和条件。

## 1. 审查结论

主设计已经正确选择“钱迹为权威来源、写后核验、附件优先上游存储”。本轮应补充具体的原生规则，而不是另外设计资产差额记账、借贷结清、分类级联或附件文件系统。

最重要的修订是：余额修改允许选择是否记录差额；借贷结清接口具有恢复未结清状态的行为；债务汇总包装项不能与明细重复累计；预算修改返回的数据本身就是官方预算结果；删除分类、标签组和资产的关联策略各不相同，不能统一为一个本地级联规则。

证据级别如下：

- **静态已确认**：本 APK 确实构建该参数、执行该分支或处理该回执。
- **设计推论**：据上述分支提出本服务应采用的组织方式，不是服务端契约的实测结果。
- **上游待实测**：云端接受条件、真实返回、跨设备影响和失败语义。本报告不把“接口存在”称为“能力已支持”。

## 2. 资产余额修改与删除

### 2.1 余额修改：原生提供是否记录差额，不应另造一笔调整账单

**静态已确认：**

1. `dex_method:Lcom/mutangtech/qianji/asset/submit/mvp/SubmitCommonAssetViewImpl;->N()Z` 仅在原资产对象 `p` 非空时返回真。
2. `dex_method:Lcom/mutangtech/qianji/asset/submit/mvp/SubmitCommonAssetViewImpl;->k0(Ljava/lang/String;D)V` 先校验金额及 `D(D)Z`；只有 `N()==true` 且原余额 `r` 与新金额不同才进入差额处理。此分支先调用 `getUnSyncBillCountExcludePack(uid)`；若大于零则显示提示并返回，否则启动 `AssetDiffAct`。新增资产或余额未变走 `C(name,money,null)`。
3. `dex_method:Lcom/mutangtech/qianji/asset/diff/AssetDiffAct;->a0(Z)V` 返回 `yesorno` 和 `DiffParams`；布尔参数为真且附件开启时，先要求图片准备完成。`DiffParams` 包含分类、账单标记、备注及可选图片引用。
4. `dex_method:Lcom/mutangtech/qianji/asset/submit/mvp/SubmitCommonAssetViewImpl;->onActivityResult(IILandroid/content/Intent;)V` 只处理请求码 `0x1123`、结果 `-1`；`yesorno=false` 时把 `DiffParams` 置空，再调用 `C(...)`。因此“修改余额但不记差额”是明确存在的路径。
5. `dex_method:Lcom/mutangtech/qianji/network/api/asset/a;->submit(Ljava/lang/String;Lcom/mutangtech/qianji/data/model/AssetAccount;Lorg/json/JSONObject;Lcom/mutangtech/qianji/asset/diff/DiffParams;Lql/d;)Lcom/android/volley/Request;` 调用 `asset/submit`，发送 `uid`、Gson 序列化的资产 `v`；仅当非空时发送 `diffparams` 和 `extra`。
6. `dex_method:Lcom/mutangtech/qianji/asset/diff/DiffParams;->toJson()Lcom/google/gson/JsonObject;` 总是写 `cateid`、`billflag`，备注非空才写 `remark`，图片集合非空才写 `images`。默认 `cateid=-1`，见该类无参构造器。

**设计推论：**网页和 MCP 应把“目标余额”和“是否记录差额及差额资料”作为同一资产用例。沿用上游 `diffparams`；不要先改余额，再由 Worker 计算差额并新增第二笔普通账单。沿用 `getUnSyncBillCountExcludePack(uid)` 的账号范围前提，先完成/核清相应未同步账单，不能无证据放宽为只检查当前资产的记录；不必移植 Android 离线队列的界面实现。

**上游待实测：**差额账单的最终类型、日期、账本归属、ID、资产影响；不同资产子类型的可编辑金额及 `extra`；修改成功回执和差额账单下发是否原子。尚不能宣称所有资产余额调整都生成差额账单。

### 2.2 删除检查是领域特定的

**静态已确认：**

- `dex_method:Lcom/mutangtech/qianji/network/api/asset/a;->deleteCheck(Ljava/lang/String;JLql/d;)Lcom/android/volley/Request;` 使用 `asset/deletecheck`，参数 `uid/did`。
- `dex_method:Lcom/mutangtech/qianji/network/api/asset/c;->j(Lcom/google/gson/JsonObject;)Lcom/mutangtech/qianji/network/api/asset/b;` 按字段存在与否读取 `installcount`、`repeatcount`。
- `dex_method:Lac/i;->U0()V` 对 `isDebtLoan()==true` 直接走 `T0()`；普通资产才调用 `deleteCheck`。`T0()` 进入删除 presenter 的 `startDelete()`。
- `dex_method:Lcom/mutangtech/qianji/network/api/asset/a;->delete(Ljava/lang/String;JLql/d;)Lcom/android/volley/Request;` 使用 `asset/delete`，发送 `uid/did`，没有通用的“级联删除所有账单”参数。

**设计推论：**第 7 节删除规范应指向“相应领域的官方检查及处置规则”，而不是要求所有对象都调用同一种 check、都提供任意级联选项。分期/周期关联的检查结果要进入可操作性判断。

**上游待实测：**两个计数触发的完整阻止/提示规则、普通账单引用如何保留、债务删除的实际关联处理。不能从 `delete` 的路径推断云端会删除关联账单。

## 3. 借贷、结清与资产汇总

### 3.1 结清与恢复未结清有独立官方动作

**静态已确认：**

- `dex_method:Lcom/mutangtech/qianji/asset/detail/loan/LoanDetailPresenter;->doFinish(Lcom/mutangtech/qianji/data/model/AssetAccount;Ljava/util/Calendar;)V` 调用 `asset/a.finish`，日期非空时先转换为字符串。
- `dex_method:Lcom/mutangtech/qianji/network/api/asset/a;->finish(Ljava/lang/String;JLjava/lang/String;Lql/d;)Lcom/android/volley/Request;` 发送 `asset/finish`、`uid/did`；日期非空才发送 `v`。请求没有显式的目标状态或还款金额。
- `dex_method:Lcom/mutangtech/qianji/asset/detail/loan/LoanDetailPresenter$a;->onExecuteRequest(Lta/b;)V` 仅在业务成功且 `isDebtLoan()` 时更新本地对象：已结清则 `status=0`，未结清则 `status=1`。在未结清→结清、且原 `extra` 为空的分支，创建 `AssetExtra` 并写入秒级 `finishDate`，再替换本地资产并发送刷新广播。
- `dex_method:Lcom/mutangtech/qianji/data/model/AssetAccount;->isZhaiWuFinished()Z` 为 `status==1`；`isDebtLoan()` 为 `type==5`。

**设计推论：**范围应明确包含结清和撤销结清；在网页/MCP 业务层使用明确目标状态，适配器读取最新状态后才决定是否调用这个可能具有切换语义的接口。重复调用“设为已结清”不能无条件再发 `finish`。结果不明时必须回查，避免第二次调用恢复未结清。结清不能实现为本地余额清零，也不能凭 `finish` 成功推断生成了还款账单。

**上游待实测：**云端是否确为切换、日期缺省/撤销语义、结清后剩余金额及账单影响。本回调的本地状态切换不是服务端仲裁和真实还款的证明；借贷还款仍须逐账单规则验收。

### 3.2 汇总包装项、借贷方向和分期要沿用原生口径

**静态已确认：**

- `dex_method:Lcom/mutangtech/qianji/data/model/AssetAccount;->isDebtLoanWrapper()Z` 为 `type==6`。
- `dex_method:Lhc/c;->f(Ljava/util/List;IZLjava/util/HashMap;)V` 在 `:goto_ec` 检测包装项后直接进入下一条循环，因此包装项没有按明细再次累计。该方法对 `type==5` 的借贷资产另外处理；显示明细与折叠到 `debtLoanList` 是展示选择，之后仍统一做借贷计算。
- 同一方法读取 `debt_include_install`；信用卡据此采用 `getMoneyWithInstalment()` 或 `getMoney()`；金额进入汇总前均检查 `isIncount()`，并带币种进入汇总方法 `g(...)`。
- `dex_method:Lcom/mutangtech/qianji/data/model/AssetAccount;->isDebt()Z` 为 `stype==0x33`（51），`isLoan()Z` 为 `stype==0x34`（52）。
- `dex_method:Lcom/mutangtech/qianji/data/model/AssetAccount;->getDebtLoanMoney()D`：借入方向仅保留 `money<=0`，正值返回零；借出方向仅保留 `money>0`，非正值返回零；其余返回零。
- `dex_method:Lcom/mutangtech/qianji/data/model/AssetAccount;->getMoneyWithInstalment()D` 在分期列表非空时，把分期余额经 `Lza/j;->j(D[D)D` 与资产余额结合；本轮不另行推断该 helper 的全部精度规则。
- `dex_method:Lcom/mutangtech/qianji/asset/detail/loanwrapper/LoanHomePresenterImpl;->loadAssetList(ZI)V` 由借入/借出页面选择 `t=51/52`，再调用 `asset/listloan(t,status)`。该接口和资产主列表不是互不相干的两套债务。

**设计推论：**第 8.2 节的“分别建模”应改为“保留列表来源，但按官方资产 ID、type/stype及包装项语义建立同一借贷对象；包装项与明细不重复计入”。不能给资产总额再加一份独立 `listloan` 总额，也不能对所有 `money` 直接取绝对值。信用卡是否包含未还分期是业务配置，不能作为手机个性化设置删掉。

**上游待实测：**完成/隐藏状态的查询过滤、共享额度信用卡、币种换算及各汇总字段的最终报表口径。

### 3.3 资产分组是 APK 已有业务能力

`dex_class:Lcom/mutangtech/qianji/network/api/asset/d;` 的已读方法体使用 `asset_group/list/submit/delete/reorder/addasset/removeasset`；其中添加发送 `groupid/assetids/startSort`，移除发送 `assetid`。`AssetGroupManagePresenterImpl` 有对应管理调用。

主设计资产行宜补“分组及组内管理”。不应实现一套只存在于 D1、无法与官方客户端同步的本地资产文件夹。分组删除对资产的真实影响尚待实测。

## 4. 预算与账本业务周期

**静态已确认：**

- `dex_method:Lcom/mutangtech/qianji/network/api/budget/a;->list(Ljava/lang/String;JLcom/mutangtech/qianji/filter/filters/DateFilter;Ljava/lang/String;Lql/d;)Lcom/android/volley/Request;` 发送 `budget/list`、`uid/bookid/flts`；`range` 非空才发送。`flts` 由 DateFilter 经 `Ldf/a;->buildFilterParams` 生成。
- `dex_method:Lcom/mutangtech/qianji/network/api/budget/a;->submit(Ljava/lang/String;JLjava/util/List;Lcom/mutangtech/qianji/filter/filters/DateFilter;Ljava/lang/String;Lql/d;)Lcom/android/volley/Request;` 发送 `budget/submitv2`、同一日期上下文及可选 `range`；集合非空时，把非空 Budget 的 `toAPIJson()` 放入 `changelist`。
- `dex_method:Lcom/mutangtech/qianji/budget/BudgetManageAct;->O0(Lal/b;)V` 明确把当前账本 `getRange()` 传给 submit；`BudgetManagePresenterImpl.i()` 对 list 同样传账本 range。
- 两个请求均使用 `network/api/budget/c`。其 `f(Lta/d;JsonObject)` 解析 `list` 及可选 `daystats`，生成 `budgets/dayStatistics`。
- `dex_method:Lcom/mutangtech/qianji/budget/BudgetManageAct$g;->onExecuteRequest(Lta/d;)V` 在业务成功时保存**响应中的 budgets**；其 `onFinish(Lta/d;)V` 用响应 budgets 刷新 `BudgetSetNew`。因此 APK 保存的是官方修改结果，并非把原始输入认作最终预算。
- `dex_method:Lcom/mutangtech/qianji/data/model/Budget;->toAPIJson()Lcom/google/gson/JsonObject;` 由 Gson 模型生成对象后移除 `category`、`createtime`，不能直接把带本地关联对象的模型原样上传。
- `dex_method:Lcom/mutangtech/qianji/data/model/Book;->getRange()Ljava/lang/String;` 返回 `BookConfig.getRangeValue()`，没有配置时返回空。
- `dex_method:Lcom/mutangtech/qianji/data/model/BookConfig;->setRangeValue(Ljava/lang/String;)V` 接受 `all/y/q`；对 `m` 前缀解析后续整数，至少为 1 才设置自定义月起始日。其余情况回到默认起始日 1、range 为空。该方法没有给出完整 UI 输入上限，不应将“至少1”误写成任意正整数均为服务端合法输入。

**设计推论：**第 6、8 节应明确预算缓存键包含账本、DateFilter、原生 range；修改后先采用官方回执里的预算集合，再针对性查询核验。不要在本地新增预算覆盖、自动结转、每月复制任务，也不要按自然月重新解释自定义账本周期。

**上游待实测：**Budget 字段的删除/取消限制标记、零预算、总预算与分类预算联动、年度预算及跨月边界。`BookConfig` 有季度/全年范围，不足以证明存在独立“季度预算”写能力。

## 5. 账本、分类与标签管理

### 5.1 账本：复用上游身份和删除检查

- `dex_class:Lcom/mutangtech/qianji/network/api/book/a;` 已读方法体包含 `book/deletecheck/delete/quit/visible/reorder/config/submit/members`；退出 `quit` 和删除 `delete` 是不同请求，不能将共享账本“移除”统一为删除云端账本。
- `dex_method:Lcom/mutangtech/qianji/network/api/book/b;->j(Lcom/google/gson/JsonObject;)Lcom/mutangtech/qianji/network/api/book/c;` 分别解析 `owner_has_unresolved`、`member_has_unresolved`；当这两个新字段均不存在，且旧 `has_unresolved==1` 时，把二者都标真。新旧响应兼容在 APK 内已存在。
- `dex_method:Lcom/mutangtech/qianji/data/model/Book;->isExpiredAsMember()Z` 要求 `expired==1 && isMember()`；`isExpiredAsOwner()Z` 要求非默认账本、当前用户 VIP 已过期且是 owner。此处只证明 APK 区分角色及过期，不足以推导所有写权限矩阵。

**设计推论：**单使用者服务仍需保留云端已有账本的 owner/member、过期和未结事项语义；不需要新造本服务 RBAC。能力状态依赖官方回执与当前账本资料，不能以“本应用只有一个人”绕开共享账本限制。

### 5.2 分类：移动、层级调整与删除迁移都有原生动作

**静态已确认：**

- `dex_method:Lcom/mutangtech/qianji/network/api/category/a;->changeLevel(Ljava/lang/String;JJLql/d;)Lcom/android/volley/Request;` 使用 `category/changelevel(uid,did,parentid)`。
- 同类 `moveSubCategory(Ljava/lang/String;JJLql/d;)...` 使用 `category/movesubcate(uid,did,parentid)`；排序是 `reorder3`，新增/修改是 `submitv2`。层级调整与子分类移动不是修改本地 `parentId` 后等待普通账单上传。
- `dex_method:Lcom/mutangtech/qianji/ui/category/manage/a;->k1(Lcom/mutangtech/qianji/data/model/Category;)V` 若对象是父分类且有子分类，先提示并返回；其余调用 `deletecheckv2(did)`。
- `dex_method:Lcom/mutangtech/qianji/network/api/category/f;->f(Lcom/mutangtech/qianji/network/api/category/e;Lcom/google/gson/JsonObject;)V` 解析 `count/other`。
- `dex_method:Lcom/mutangtech/qianji/ui/category/manage/a;->P1(Lcom/mutangtech/qianji/network/api/category/e;Lcom/mutangtech/qianji/data/model/Category;)V` 两个计数均不大于零时显示简单删除确认；任一大于零时将它们作为 `my_count/other_count` 传入专门处置页面。
- `dex_method:Lcom/mutangtech/qianji/network/api/category/a;->delete(JJZLql/d;)Lcom/android/volley/Request;` 使用 `category/deletev2`，发送 `did/deletebills=1或0`，仅当替换分类 ID 大于零时发送 `newcateid`。

**设计推论：**删除 API 应明确选择官方支持的关联处置策略，先处理子分类，再按 check 的当前结果展示影响。迁移可复用 `newcateid`，不应先批量重写所有本地账单再删分类。`other_count` 表明不能只用当前用户的本地筛选结果推断完整影响。

**上游待实测：**层级和跨类型/跨账本移动的全部前置条件，其他成员账单的可迁移性，分类删除后的账单/预算/任务变更集合。

### 5.3 标签：归档保留对象，删除分组保留标签

**静态已确认：**

- `dex_class:Lcom/mutangtech/qianji/network/api/tag/a;` 各方法分别使用 `submittag/submitgroup/archivetag/deletetag/deletegroup/reordertag/reordergroup`。标签提交可带 `groupid/color`，标签和分组有各自排序请求。
- `archiveTag(uid,tagId,listener)` 只发送 `uid/did`，没有显式目标状态。`dex_method:Lih/h0$c;->onExecuteRequest(Lta/d;)V` 在成功时用服务端返回对象 `insertOrReplace`，然后刷新选择、管理和归档视图。不能擅自假设所有调用都把状态改为某固定值。
- `dex_method:Lih/h0$d;->onExecuteRequest(Lta/b;)V` 在删组成功后调用本地 `d0.deleteGroup`。
- `dex_method:Lcom/mutangtech/qianji/data/db/dbhelper/d0;->deleteGroup(Lcom/mutangtech/qianji/data/model/TagGroup;)V` 删除分组，再查询该组 `STATUS_ALL` 的标签，把每条 `groupId=null` 后更新列表；**没有删除这些标签**。
- `dex_method:Lih/h0$e;->onExecuteRequest(Lta/b;)V` 在删标签成功后仅删除对应本地标签对象；成功完成后刷新标签选择和账单主列表。这个回调没有遍历并删除账单。
- 新的 `tag/syncall` 和旧的 `tag/list` 同时存在；不能据旧接口没有分组便丢掉分组。完整同步证据由根审查记录，本报告不另重复展开。

**设计推论：**标签分组与标签是独立资源；删组默认成为未分组，不能默认级联删标签和账单。归档状态以官方返回对象为准；MCP 的明确“归档/恢复”动作须先读当前状态，不能将可能的切换请求直接当幂等设置。上传原有账单扩展里的标签 ID 不应因本地归档隐藏而被顺手清除。

**上游待实测：**归档/恢复切换的云端语义、删除标签后账单引用变化、名称/颜色限制、当前账号权益及数量限制。本轮未确认固定标签数，不应引入参考项目的常量作为官方规则。

## 6. 图片附件：上游上传凭证、七牛对象和账单引用

**静态已确认链路：**

1. `dex_method:Lcom/mutangtech/qianji/bill/add/image/AddBillImagePresenter;->uploadNewImage(Landroid/content/Context;Ljava/util/List;)V` 优先复用内存 token，再检查持久缓存的 `bill_image_upload_token_value/expire_at`；缓存仅在 `nowSeconds < expireAt - 60` 时复用，否则按需请求新 token。该 60 秒是上传凭证安全余量，与本服务普通查询 60 秒缓存无关。
2. 同方法调用 `dex_method:Lkf/a;->getUploadToken(ILql/d;)Lcom/android/volley/Request;`，账单图片使用 `dt=1`。接口路径为 `common/uploadtoken`、参数 `uid/dt`。
3. `dex_method:Lkf/c;->f(Lta/d;Lcom/google/gson/JsonObject;)V` 从响应 `v` 读取 token、从 `expireAt` 读取长整数。上传 token 与钱迹登录 token 是不同凭证。
4. `dex_method:Lcom/mutangtech/qianji/bill/add/image/AddBillImagePresenter;->g(Lcom/swordbearer/free2017/util/photopicker/entity/Photo;)V` 用 `Lab/a;->generateUploadFileKey(null)` 生成文件 key；把 key、token、本地文件/URI 放进 `Lfl/f;`，添加 `Lfl/d;` 预处理器及上传任务。
5. `dex_method:Lfl/k;->h(Lfl/f;)Z` 先预处理，再经 `Lfl/c;->buildUploadManager(dataType)` 获取七牛 `UploadManager`，调用 `syncPut(file,key,token,UploadOptions)` 并检查上传返回。存在本地临时文件及上传日志不等于云端项目需要永久文件仓库。
6. `dex_method:Lcom/mutangtech/qianji/bill/add/image/AddBillImagePresenter$a;->onFileUploadedSuccess(Lfl/k;Lfl/f;)V` 成功后才把 file key 写入 `Photo.imageKey`。
7. `dex_method:Lcom/mutangtech/qianji/bill/add/image/AddBillImagePresenter;->imagePrepared()Z` 要求所选每张图片 `imageKey` 非空；`getImageUrls()Ljava/util/ArrayList;` 实际收集的是 `imageKey`，方法名不应被误读为“允许任意外链 URL 即视作已上传”。
8. `dex_method:Lse/a;->getMaxBillImageCount()I` 从配置 `max_bill_image` 读取值，回退值 6。6 只是本 APK 默认值，不是已实测的上游硬限制。

**设计推论：**保持第 4 节“优先官方上传存储”的决定，并具体为按需获取官方上传凭证→上传对象→记录上游 key→提交账单关联。暂不引入 R2、独立媒体库、文件夹或自建外链协议。网页和 MCP 的上传输入方式可以适配交互，但对外不能接受未验证字符串并宣称上传完成。移除附件先移除账单引用；未确认云端对象删除协议前，不把“移除引用”描述成已销毁七牛对象。

**上游待实测：**Worker/浏览器的上传兼容、CORS及上传区选择、文件 key/读取地址规则、压缩格式和大小限制、失败后重传及孤儿对象清理、附件引用与账单提交顺序。只有在这些验证证明必须持久中转时才论证 R2；当前静态证据不支持把它列为基础依赖。

## 7. 对主设计的具体修订建议

| 主设计位置 | 建议补充或改写 | 不需要自创的机制 |
| --- | --- | --- |
| 第 2 节资产范围 | 明确资产分组、组内增删、差额记录选择、结清与撤销结清、是否包含信用卡未还分期 | 本地资产文件夹、额外“调整余额账单”生成器 |
| 第 7 节删除第 9 条 | 使用各域官方检查和关联策略；分类有子项先处理子项，删标签组保留标签；退出共享账本与删除分开 | 跨所有资源通用级联删除参数 |
| 第 7 节写用例 | `finish/archivetag` 等无目标状态的动作需以最新状态映射明确目标，结果不明只回查 | 对可能切换的接口无条件重放 |
| 第 8.2 节资产债务 | 按共同ID及 type/stype识别借贷，排除type6包装项；incount、符号截断和分期配置参与计算 | 资产与listloan各算一次再相加、对债务一律取绝对值 |
| 第 6、8 节预算 | 缓存和核验包含 book+DateFilter+range；submit回执中的list是官方结果，再按需回查 | 本地预算复制、结转任务、自然月强行覆盖自定义周期 |
| 第 2、8 节分类标签 | 分类层级/移动/迁移走原生动作；归档和删除区分；组删除成为未分组 | 本地批量改引用代替上游迁移、归档时清账单标签 |
| 第 4、8 节附件 | 保留官方对象key与元数据，记录上传与关联各阶段状态；配置上限而非固定硬编码6 | 默认R2、永久图片副本、把任意URL当上传结果 |
| 第 3.3、12 节能力核验 | 本文各动作继续保留“静态发现”，上游验收按动作与状态转换逐项做 | 从查询/方法存在推导整个域已写入验收 |

## 8. 最小上游验收清单（本轮未执行）

1. 测试资产余额改变：分别“不记录差额/记录差额”，对照资产、差额账单、统计及再次同步；另测有在途账单的阻止条件。
2. 测试借贷结清→恢复未结清；分别丢失第一次回执后只读取核查，确认不会再次切换；另按借贷还款账单规则核验余额和关联。
3. 核对资产汇总与listloan明细，同一借贷不重复；包含/不包含分期和incount选项逐项对照。
4. 预算测试普通月/自定义月起始日/年度，总预算及分类预算；比较submit回执、重新查询和官方页面，而非仅检查请求成功。
5. 分类测试有子项、只有本人引用、存在其他成员引用、迁移与删账单策略；同步后核查分类、账单、预算和任务。
6. 标签测试归档与恢复、删组保留标签、删标签的账单引用及新旧同步并存；核对当前账号限制。
7. 用明确命名的测试对象核验账本删除/退出与未结事项，资产分组删除及资产删除的分期/周期关联。
8. 上传真实小图片，验证上游对象、成功回执、账单引用及展示；模拟上传成功但账单提交失败、凭证到期、移除引用。不要在未知清理语义下承诺永久文件删除。

上述任务均不要求新增本服务认证、多用户、Cron或闲置轮询；按用户既定的单人、免应用鉴权、Workers Paid+D1+单DO、使用时按需同步方案推进即可。
