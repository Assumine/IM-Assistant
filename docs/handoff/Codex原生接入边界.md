# Codex 原生接入边界与当前切片

R3-01 仍为进行中。新增 `modules/codex-native`，完成独立原生后端适配器及真实 CLI 验证；尚未接入主程序会话选择、前端或生产账号，没有宣称正式接入。A20–A22 尚不记为完成。

## 来源与版本

协议按 [官方 App Server 文档](https://learn.chatgpt.com/docs/app-server) 核对，并使用本机 CLI 的 `app-server generate-json-schema --experimental` 生成版本匹配的隔离 schema。实际验证的是 `codex-cli 0.166.0-alpha.5.1`，不是任意 Codex 版本；可执行文件摘要见 [当前切片证据](../../upstream/codex-checkpoint.json)。未更新、修改或接管现有 Codex 安装和账号。

该版本提供原生持久队列 `thread/queue/add|list|update|delete|reorder|start`。不能只依据通用文档猜测这些实验接口在别的版本也存在。模块打开前锁定实际版本，未来 CLI 变化须重新跑原生边界验收。生成的整份 schema、CLI 二进制、测试 native home 和日志不提交。

## 状态与调用归属

| 内容 | 当前归属和实现 |
| --- | --- |
| native thread/turn/item/queue ID | 原样保留，不转换成 OpenCode `ses_`、Inbox 或消息 ID |
| 输入 | 文本转成原生 `UserInput`，只调用原生 queue/add；空闲启动由 Codex 完成 |
| 排序、修改、撤回、显式引导 | 对应原生队列接口；没有助手取出任务再执行的循环 |
| 调整 | 原生 turn/steer，必须携带 expectedTurnId；旧 turn ID 不能误改当前 turn |
| 历史与恢复 | 原生 resume/read/turns/items 分页，不覆盖 history/path，不复制会话库 |
| 压缩 | 原生 thread/compact/start；本机兼容 API 使用原生本地摘要路径，非 OpenAI 远程 compact |
| 账号、模型 | 原生只读接口；测试账号为空，未验证真人登录、切换或套餐用量 |
| 生命周期 | 自己的 stdio 子进程，进程内同一 profile 只允许一个实例；故障不自动重启或重发 |
| 传输 | 只保存尚未回包的 RPC 关联；通知直传、不持久化第二份消息历史；关闭事件单独暴露 |

已实测：空闲 queue/add 自动启动；忙碌队列可编辑、排序、撤回，并自动依次执行。进程退出后，未完成输入和已完成历史仍由 native store 保存。测试在新进程续接同一 thread；需要显式继续的 pending 项由测试模拟用户引导，不由适配器自动补发。中断不等于撤回已发生的操作，恢复时仍需核对未知结果。

## 已发现且尚未消除的缺口

1. **原生队列不提供客户端消息 ID 幂等性。** 同一 clientUserMessageId 连续 queue/add 会生成两个 native submission ID。测试显式记录此行为并撤回多出的测试项，不能把“有客户端 ID”写成“不会重复接纳”。超时返回 OutcomeUnknown，不自动重试。后续统一应用入口必须接管输入接纳的唯一性和结果核对；不能为此再造第二个执行队列或历史账本。未知交付不能默认为未发送。
2. **应用公共入口尚缺整套后端槽位。** 已核查 OpenCode 原生插件的 session/provider hooks，它们主要修改原生会话和模型请求，不能替换整个会话后端。不能把 Codex 接成 provider，再套一层 OpenCode Agent/Inbox。下一步需要在原生应用框架内提供有限的公共后端位置，不新建外层 Python 宿主。
3. **跨进程生命周期与账号未验收。** 模块的进程内 profile 排他仅防同一宿主重复打开；未来公共入口须利用原生应用服务的单实例生命周期，不能任由多个 stdio 实例竞争同一 native home。当前没有真实账户连接、原生产线程迁移或 UI 人工提问/审批转交。

因此 `package.json` 明确为实验性且 publication=disabled，入口没有注册到启动、默认模型或主界面。这不是一次可供用户切换使用的发布。

## 文件能力边界

该切片只创建空的新 profile。配置摘要、目录归属和 CLI 版本在打开时检查，采用固定只读审批策略及禁用工具配置，不接纳任意原始 config、工作目录、MCP、动态工具或文件输入。密钥仅经受控 `IM_` 环境变量传入自身子进程；不复制旧 home，不记录原始 stderr 或密钥。

真实模型请求中只广告 request_user_input。测试服务强行返回未广告的 exec_command、apply_patch、view_image、MCP 文件读取和 spawn_agent 调用；原生 dispatcher 分别拒绝。自有 sentinel 未读出、未改写，补丁目标文件未生成。不能只凭隐藏工具名推断禁用成功。

所有服务端主动工具/审批请求当前一律返回“不提供该 host 能力”，不执行或自动批准。人工提问转交尚未接入，不能称交互闭环完整。以上是该版本、受控 profile 的能力验证，不是 OS 沙盒证明，也不代表用户既有 Codex 系统被去除了文件能力。新增工具、配置、登录来源或 CLI 升级都须重新验证后才能开放入口。

## 真实验证

`python -m tools.codex_native_smoke` 调用锁定 Bun 和 TypeScript，对模块进行类型检查并驱动真实 Codex App Server。六个场景全部在新建隔离 profile、本地合成 Responses 服务中执行，没有真实上游账号或模型请求：

- 原生队列自动启动、忙碌时编辑/排序/撤回、FIFO 和历史分页；额外确认重复 clientUserMessageId 并不去重。
- 进程退出后的 native pending/历史恢复，原生 ID 和只读账号结果保持，不补发已交付输入。
- 原生 expectedTurnId 防止过期调整，中断状态来自原生事件。
- 强制未开放工具调用在原生 dispatcher 被拒绝。
- 原生本地压缩后重启，下一次真实模型输入使用压缩上下文，不再带旧 assistant 回复。
- 非空 home 拒绝接管、同进程重复打开拒绝、配置篡改拒绝、文件输入和无效参数拒绝。

证据只标 partial_verified。它不能代替 `python tools/run_runtime_checks.py --task R3-01` 的正式应用验收；正式 R3 Python 验收文件尚未实现，整个阶段不能标绿。已有 OpenCode 产品源文件未改变，原 106 文件补丁台账不增加。

## 下一步实施边界

先落实原生应用内的公共整套后端位置，至少保留 backend ID＋native thread ID 的引用，生命周期、能力和事件订阅有明确归属。OpenCode 分支继续直接使用原生 Session/Inbox；Codex 分支直接调用此模块的原生队列，不能两个入口认领同一输入。跨后端引用仅保存路由与回执所需元数据，不复制另一套会话历史。

前端可以复用原生展示与交互组件，但不能为复用而向 OpenCode Inbox 再插入 Codex 待执行消息。恢复/重复投递的接纳策略、同 profile 生命周期和 native UI 契约须真实验证，再添加正式 R3 运行验收并考虑开放。QQ 仍是可选转发层，不能解决这些公共框架缺口或成为执行入口所有者。
