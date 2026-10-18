# 请求层契约

当前仅登记已核对的固定操作：account/login、account/refreshtoken、account/logout、client/init、syncv2/pull、bill/syncall、tag/syncall。新增领域操作必须先补对应APK构造/解析证据，再扩展`operations.ts`；不接受调用者传任意URL。

后续领域扩展：bill/refund2、baoxiao/baoxiao、baoxiao/cancelbaoxiao，均为普通构造器；载荷、回执、关系处理及合成测试向量见[报销与关联写入契约](reimbursement.md)。

client/init的本样本构造器位于`Ljf/a;`（不是按包名猜测的network/api/client/a），含vvmark/newinstall/upgradealert及普通请求构造；其具体初始化资料解析在连接/同步任务中实现。

- 方法为POST，普通表单编码；空参数按APK `params(name,null)`省略，空字符串是否发送由该业务构造器决定。对象/集合明确编码为无损JSON表单值，JSON字符串不自动二次解析。
- `Lbl/c.build/buildSyncStringRequest`均在已有用户时追加**表单参数**`fr=uid`。它不是HTTP身份头，也不替代各接口自身所需的uid参数。
- 普通构造只有必要utoken；同步字符串构造额外带`htoken=1`。syncv2/pull、bill/syncall、tag/syncall属于后者，登录和刷新属于前者。
- 登录的新连接请求不携带旧账号token/fr。其他请求核对UID与逻辑连接代次，不能用新账号凭证发旧scope请求。
- 当前固定三线路均为HTTPS；不自动切线，不跟随重定向。线路保留与真实可达性由连接服务及实际验收确认。
- 身份画像的包名、版本和市场来自样本；`os=1`为Android兼容协议，`osvs=35`、MCP/Cloudflare Workers设备描述是适配器选值，不声称实际运行于Android，也不将compileSdk当作设备OS证据。默认中文、中国地区、偏移28800秒；业务日期另按共享日期模型计算。
- 默认超时20秒，包括响应体读取，零自动重试。任何可能已送达的失败保留unknown结果；后续由操作协调器核查。
- 成功外层ec为200，数据无损解析。ec=8888且内层code=40005按明确失效处理，40009为限制；HTTP403、网络错误和文本中出现token字样不能直接使账号登出。其他业务码保留原码，不凭陌生错误推断写入一定未执行。
- 原始密码、摘要、token和完整响应不写日志。公开错误只包含稳定类别和必要状态码，未知响应结构不当成功。

只读MT工具：

```text
node tools/protocol/mt-read.mts --tool mt_apk_read_text --args-file <args.json> --output .artifacts/protocol/result.json
```

args使用该服务实际工具Schema。工具只允许源码/结构/native检查，不自动执行返回的nextActions，不包含修改、安装、写入APK或文件管理操作。
