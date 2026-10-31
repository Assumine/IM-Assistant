# Codex 原生会话后端切片

这是完整 Codex App Server 的适配器，不是 OpenCode 模型 provider。线程、历史、队列、上下文、压缩和账号仍由 Codex 原生系统拥有，没有自己的任务库、执行循环或自动重试。当前 `publication: disabled`，尚未注册到主程序。

支持原生创建/续接、历史分页、入站队列的查看/修改/排序/撤回、显式引导、带 turn ID 前提的调整、中断、压缩以及只读账号/模型查询。结果和通知保留原生 ID。发送仅接收文本，不接收文件路径、任意配置、原始 RPC、动态工具或用户指定工作目录。

`createProfile` 只接纳空目录，生成独立 native home 和受控工作目录；不会采用或复制用户的旧 Codex home。连接密钥只经环境传给自身子进程，不写入配置。打开前验证配置摘要和实际 CLI 版本；不自动更新 CLI。该切片目前只验证 Windows 的 `codex-cli 0.166.0-alpha.5.1`。

从仓库根目录运行隔离验证：

```sh
python -m tools.codex_native_smoke
```

需要已安装的 Codex CLI 和仓库锁定的 Bun/TypeScript 工具链。测试使用本机合成 Responses 服务和新建临时 native home，不调用付费模型、不使用真实登录态、不接管旧进程。配置篡改及版本不匹配时拒绝打开，子进程退出或响应超时时返回结果未知，不盲目重发。

已确认的限制：原生 `queue/add` 不按 `clientUserMessageId` 去重；同一条消息重复提交会生成不同队列项。进程内重复打开同一个 profile 会被拒绝，跨进程的唯一生命周期所有权仍须由原生应用服务保证。不能把这些检查写成端到端一次交付保证。完整应用后端入口、原生 UI 绑定、账号连接与人工提问转交尚未完成。

详细证据、发布门槛和下一步见 [Codex 原生接入边界](../../docs/handoff/Codex原生接入边界.md)。
