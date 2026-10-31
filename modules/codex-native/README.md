# Codex 原生会话后端切片

这是完整 Codex App Server 的适配器，不是 OpenCode 模型 provider。线程、历史、队列、上下文、压缩和账号仍由 Codex 原生系统拥有，没有自己的任务库、执行循环或自动重试。已验证原生应用的公共后端位置及HTTP调用；当前 `publication: disabled`，默认不注册Codex、不开GUI入口。

支持原生创建/续接、历史分页、入站队列的查看/修改/排序/撤回、显式引导、带 turn ID 前提的调整、中断、压缩以及只读账号/模型查询。结果和通知保留原生 ID。发送仅接收文本，不接收文件路径、任意配置、原始 RPC、动态工具或用户指定工作目录。

`createProfile` 只接纳空目录，生成独立 native home 和受控工作目录；不会采用或复制用户的旧 Codex home。连接密钥只经环境传给自身子进程，不写入配置。打开前验证配置摘要和实际 CLI 版本；不自动更新 CLI。该切片目前只验证 Windows 的 `codex-cli 0.166.0-alpha.5.1`。

从仓库根目录运行隔离验证：

```sh
python -m tools.codex_native_smoke
```

需要已安装的 Codex CLI 和仓库锁定的 Bun/TypeScript 工具链。测试使用本机合成 Responses 服务和新建临时 native home，不调用付费模型、不使用真实登录态、不接管旧进程。配置篡改及版本不匹配时拒绝打开，子进程退出或响应超时时返回结果未知，不盲目重发。

`nativeBackend(adapter)` 通过公共后端定义接入。原生应用的 `experimental.conversation` RPC负责注册、路由及原生KV接纳回执，发送和调整都经send，不经过OpenCode Inbox。8份并发HTTP输入只接纳一份；丢失回执时查原生队列/历史，重启后复用原回执。回执只存目标、请求摘要和native ID，不保存消息正文或调度任务。

已确认的限制：裸原生 `queue/add` 不按 `clientUserMessageId` 去重，必须使用公共send入口。原生状态也查不到的未知交付会保留uncertain，不自动重发；它不是跨系统exactly-once保证。进程内重复打开同一个profile会被拒绝，跨进程所有权、GUI、真实账号及人工提问转交仍未验收。受控助手模式继续禁用任意SDK插件，测试由受信任宿主注册，不放开通用插件加载。

详细证据、发布门槛和下一步见 [Codex 原生接入边界](../../docs/handoff/Codex原生接入边界.md)。
