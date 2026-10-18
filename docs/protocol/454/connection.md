# 4.5.4 账号连接契约

本轮只读核对`rxvx4qt6`工作区，未使用真实账号登录钱迹。测试中的账号、密码、token均为人工无效值；HTTP/RPC集成测试调用同一服务，钱迹响应由测试替代。

| 行为 | APK证据 | 本服务实现 |
| --- | --- | --- |
| 密码登录 | `account/a.login(String,String,Lql/d;)` | 普通构造POST `account/login`，`v`为手机号/邮箱，`pwd=Lza/h.e(password)`；不携带旧连接的fr/utoken |
| 响应解析 | `account/c.f`与`account/b`字段注解 | `user.id`为UID，`token`为凭证，`books`为业务bootstrap；不保存完整登录响应 |
| 状态检查 | `Ljf/a.initConfig`、`Ljf/c`、`Ljf/b` | `client/init`的`uid/v/vvmark/newinstall/upgradealert`；核对`userinfo.id`，不能只凭本地token存在声称在线 |
| 会员标志 | `User.isVip()`→`Lza/b.a(JJJ)` | viptype≥1且`vipstart≤当前秒<vipend`时vvmark=1，其他为0；不改变账号权益 |
| 退出 | `account/a.logout` | 普通构造POST `account/logout`，参数uid；单次请求后清本地凭证，网络结果不明时明确说明，不恢复/重发退出请求 |
| 刷新token | `account/a.refreshToken` | 存在uid参数及字符串解析器；真实行为尚未验证，明确返回`REFRESH_UNVERIFIED`，可重新登录，不后台续期 |

三条线路沿用已核对的主机。切线不额外请求；已登录时的线路检测使用相应线路的`client/init`，不改变当前线路。未登录时返回需连接的明确状态，不用虚构账号测试登录。

凭证用32字节随机Worker Secret通过HKDF-SHA256派生AES-GCM密钥，盐为持久实例ID，附加认证数据包含UID/连接代次/格式版本，每次随机12字节IV。同UID重新登录保留设备ID和逻辑连接代次，替换加密token并递增凭证代次；不同UID新建逻辑代次并隔离旧任务。密码、可重放密码摘要、完整登录响应不落库或操作日志。

所有客户端请求携带发出时的凭证代次。只有结构化40005且UID、逻辑代次、凭证代次仍一致时才清除token；旧token的迟到失效不能清掉新凭证。HTTP403、断网、40009和响应格式变化均不视为账号密码错误。

专用`POST /api/connection/login`与DO的login RPC映射同一服务。输入受类型/长度约束，输出仅白名单连接视图；错误通过固定代码映射，不返回上游正文或密码字段。MCP不提供密码登录工具。
