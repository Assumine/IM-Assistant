# Codex 原生会话后端切片

这是完整Codex App Server的适配器，不是OpenCode模型provider。线程、历史、队列、上下文、压缩和账号仍由Codex原生系统拥有，没有自己的任务库、执行循环或输入自动重放。已验证公共后端位置、HTTP调用及Windows/Bun下的跨进程共享实例；当前publication=disabled，默认不注册Codex、不开GUI入口。

支持原生创建/续接、历史分页、入站队列的查看/修改/排序/撤回、显式引导、带 turn ID 前提的调整、中断、压缩以及只读账号/模型查询。结果和通知保留原生 ID。发送仅接收文本，不接收文件路径、任意配置、原始 RPC、动态工具或用户指定工作目录。

公共后端使用`createSharedProfile`创建独立native home，后续经`loadProfile`读取；均不采用旧home。它生成固定的loopback端点和随机握手令牌，令牌不进URL、命令行正文或公开RPC。打开时核对配置摘要、CLI版本、native home及实际生效的禁用配置，再复用同一个原生服务。仅验证Windows、锁定Bun及codex-cli 0.166.0-alpha.5.1，不自动更新CLI。旧createProfile保留为stdio隔离验证；nativeBackend拒绝将它注册为产品后端。

共享连接的`close()`只断开客户端，不中断native任务或停止其他客户端。受信任宿主可显式调用`stopSharedService`，经鉴权及身份/策略核对后停止整个自有实例；这不在模型或GUI RPC中。没有PID文件锁、过期抢锁或第二个守护服务，排他依靠原生监听器的OS端口绑定。重连不重发输入，停止/重启也保留native历史和未消费队列。

从仓库根目录运行隔离验证：

```sh
python -m tools.codex_native_smoke
```

需要已安装的 Codex CLI 和仓库锁定的 Bun/TypeScript 工具链。测试使用本机合成 Responses 服务和新建临时 native home，不调用付费模型、不使用真实登录态、不接管旧进程。配置篡改及版本不匹配时拒绝打开，子进程退出或响应超时时返回结果未知，不盲目重发。

`nativeBackend(adapter)` 通过公共后端定义接入。原生应用的 `experimental.conversation` RPC负责注册、路由及原生KV接纳回执，发送和调整都经send，不经过OpenCode Inbox。8份并发HTTP输入只接纳一份；丢失回执时查原生队列/历史，重启后复用原回执。回执只存目标、请求摘要和native ID，不保存消息正文或调度任务。

已确认的限制：裸原生queue/add不按clientUserMessageId去重，必须使用公共send。未知交付且native也查不到时保留uncertain，不自动重发；这不是跨系统exactly-once保证。共享WebSocket在官方仍属实验性，GUI、真实账号及正式宿主激活未完成；多用户ACL和其他OS未验收。受控助手模式继续禁用任意SDK插件，不为此放宽通用插件加载或真实系统权限。

详细证据、发布门槛和下一步见 [Codex 原生接入边界](../../docs/handoff/Codex原生接入边界.md)。
