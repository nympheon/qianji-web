# 图片附件（钱迹 4.5.4 / 1234）

## 原生契约

- `common/uploadtoken`：普通请求、`uid`、账单 `dt=1`，封面和分类 `dt=2`；响应 `data.v` 为临时七牛凭证，`expireAt` 为秒。距离有效期不足或等于 60 秒时不复用，凭证只存内存。
- 七牛区域查询使用 `https://api.qiniu.com/v2/query?ak=…&bucket=…`，取 `up.acc.main`，仅接受七牛上传域。HTTPS multipart 发送 `token/key/file`，原请求只发送一次，回执 key 和 ETag 必须匹配。
- 账单普通图片：JPEG、质量 80，先判断长边 `>=3200`，否则判断短边 `>1920`，按 APK float32 缩放。不是同时满足两条边界的矩形裁剪。长边 `>30000`，或长边 `>8000` 且宽高比 `>=3` 时保留尺寸并加 `_hg`。
- 账单 key 为 `_` 加无连字符 UUID，无扩展名；封面 `headimages/_UUID`；分类 `cateupload/_UUID.png`。封面关联值为公共主机 + key + `!headimages`，分类为公共主机 + key，账单只存 key。
- 普通账单缩略/中图/原图：`!webpsmall240/!webpmd640/!webporigin`；长图为 `!hugesm240/!hugemd640/!huge`。
- 全局 `client/init.data.configs` 按键合并 `max_bill_image/bill_image_host/pub_image_host`，不覆盖未返回的旧键。原生默认数量 6；页面与写入校验读取实际配置。
- 转账和本金记录：`Bill.images` 数组。退款：`refund2.v.images` 数组。报销：`images` 参数为 JSON 数组字符串。差额：`diffparams.images` 数组。新借贷：`asset.submit.extra.images`。还款图片属于本金记录，利息子记录不复制图片。

证据：`kf/a,c`、`fl/d,e,a`、`dl/n`、`ab/a.generateUploadFileKey`、`mk/f.buildHeaderImageUrl`、`ld/o.imagePrepared`、`DiffParams.toJson`、`LoanPayAct.E0/J0`、`network/api/bill/a.baoxiao`、新建借贷保存流程。

## 服务行为

Web 在浏览器解码、处理 EXIF 方向、按原生尺寸规则转 JPEG/PNG；分类图标提供居中方形裁剪。单张处理后最大 8MiB；浏览器输入最大 32MiB、100M 像素，超过时提示裁剪。没有引入 R2 或 Worker 图片编码依赖。

`attachments.upload` 与其他写操作一致返回 `OperationView`；`attachments.result` 在确认成功后返回 `UploadedImage`。持久日志只保存用途、尺寸、SHA256、ETag 和对象名；字节仅在有界短期内存中保存。重启后未发送且已失去字节的操作明确失败，上传结果未知时只读核查原对象 ETag，不重新 POST。

上传草稿绑定原 requestId、用途和内容哈希，发送前再次核对。确认图片先保存到业务草稿，再标记已应用，避免用户移除图片后刷新又被自动添加。上传未确认时不能提交所属业务表单。

新账单引用必须对应当前账号已确认上传的对象；普通 URL 不构成上传证明。已有官方引用可保留或移除。移除引用不代表删除七牛对象。退款清空原字段的语义仍等待专用资源真实验证。

网页 `/api/uploads` 为有界 multipart；MCP 使用同一服务的有界 base64 输入，SDK 请求体上限 12MiB。未提供实际字节时返回 `/attachments` 入口，不假设 ChatGPT 会自动传输聊天图片。

实际只读检查发现原生公共图片主机 HTTP 地址对应的 HTTPS 证书已过期。保留原生关联值，通过同源 `/api/images` 展示 HTTP 图片：来源限当前官方配置主机、禁止重定向、不转发 Cookie/Authorization、限图片 MIME/8MiB/30 秒。没有绕过 TLS 校验。

官方对象存储资料：[上传协议](https://developer.qiniu.com/kodo/1312/upload)、[上传凭证](https://developer.qiniu.com/kodo/1208/upload-token)、[七牛 JavaScript SDK](https://github.com/qiniu/js-sdk)、[ETag 实现](https://github.com/qiniu/python-sdk/blob/master/qiniu/utils.py)。

实现阶段验证：320 项单元/Worker/HTTP/MCP 测试和 74 项桌面/手机页面测试通过；真实官方上传与业务关联仍由 Task27 的专用测试资源验收。
