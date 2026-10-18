# 4.5.4 签名核验

目标为`qianji_454_1234_gw.apk`，包名`com.mutangtech.qianji`。本次只读分析APK并在隔离模拟器中执行其native指令，没有安装/修改APK，也没有登录或调用钱迹业务服务器。

## 独立证据

JNI入口`Lcom/mutangtech/arc/http/JNIHelper;`加载`fabricsuffer`。ARM64库大小13,560字节，SHA256为`441122805c78ab4b1a0435d42495c2beecfbde626baf9880e08187c40cf2f7e3`。

| 函数/证据 | 位置 | 结果 |
| --- | --- | --- |
| native_requestId | ELF VA `0x26bc`，488字节 | 读取Context包名、实时时钟、版本码、ctrl与act |
| 时间组合 | VA `0x27bc–0x27f4` | 秒乘1000、纳秒除1,000,000取整，加入版本码和`0x8a9127` |
| new_request_id | VA `0x24b4` | 与上述时间/字符串结构一致 |
| encode_request_id | VA `0x2678` | 对reqid追加固定后缀再MD5 |
| native_encreqid | VA `0x28a4` | JNI包装，最终走encode_request_id |
| 外层tok | `JNIHelper.a(String,String,String)` | 原生encodedReqid参与外层MD5 |
| 密码 | `Lza/h.e(String)`→`Lza/i.b(String)` | 非空字符串经MessageDigest MD5，小写hex；空值由登录表单先拒绝 |
| 渠道/版本 | AndroidManifest.xml | APP_MARKET_NAME=`guanwang`，versionCode=`1234`，versionName=`4.5.4` |

计算规则：

```text
t = epochMilliseconds + versionCode + 9_081_127
reqidv2 = MD5(packageName + decimal(t) + ctrl + act + "free20170908&x_*1127")
encodedReqid = MD5(reqidv2 + "michaeljackson")
tok = MD5(reqidv2 + "1172020" + ctrl + encodedReqid + act)
```

拼接不含分隔符，MD5返回小写hex。签名时间和ID使用整数运算。这里使用Cloudflare提供的`node:crypto`兼容模块，无宿主Node进程、Android JNI或原生扩展部署依赖；workerd中的向量测试验证该路径。

## 向量来源与复现

[signing-vectors.json](../../../fixtures/apk-454/signing-vectors.json)中的预期值由[独立工具](../../../tools/protocol/native-vectors.py)生成：Unicorn 2.1.4执行该APK的原始ARM64指令，包括库内MD5；仅模拟JNI上下文、libc和时钟。库内MD5先与Python标准库对照空串、abc、多块字符串。reqid及encodedReqid来自native执行；Java外层tok由Python hashlib按已核对的Smali流程计算。工具不调用TypeScript signer。

5组向量覆盖不同接口、毫秒边界和版本参数。1207向量是本4.5.4库接收该参数的结果，不表示另行验证了旧APK。

复现时从用户授权的MT工作区读取该库至忽略目录，校验SHA256；将`unicorn==2.1.4`安装到临时Python target，并将该target设置为本次进程的PYTHONPATH，再执行：

```text
python tools/protocol/native-vectors.py <read-only-so-copy> <candidate-vectors.json>
```

先比较候选向量，不用本实现计算的结果覆盖期望。APK库文件及模拟器二进制不提交、不部署；Python只用于开发证据。

## 验证边界

静态证据和原始native执行已关闭签名可移植性门槛；真实登录、Cloudflare出口、服务器版本/画像接受条件、线路及账号权益仍按计划在真实验收阶段验证。不能把独立向量通过称为已连接钱迹。

参考项目`fangzhengjin/qianji-mcp`为MIT许可，所读client blob为`43aa9175e432870b06de6b7e898d177d5bd593f6`；用作协议对照。本实现按本APK证据独立编写。`cloverstd/qianji-bridge`未发现仓库许可证，未复制其源码。
