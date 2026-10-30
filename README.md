# IM-Assistant

个人助手的宿主地基与整套会话后端接入框架。

P0 契约与接入测试工具已实现：静态包验证、有界 JSON-RPC、两套内部结构不同的测试后端和统一行为验收驱动。独立宿主、OpenCode 正式后端和客户端迁移仍待后续阶段实现。旧应用、业务模块和本机运行数据没有放入这个仓库。

后续 AI 从 [接手指南](docs/handoff/接手指南.md) 开始，运行 `python tools/next_task.py` 查看第一项可开展工作。旧客户端源码按本地只读配置参考，不要求上传到 GitHub。

宿主提供应用生命周期、统一输入、身份与会话绑定、可靠转交、事件展示和通知。接入单位是一整套会话后端：后端自行保留原生历史、上下文、压缩、工具执行和队列，不要求把这些机制拆成独立插件。

OpenCode 是计划中的默认参考后端；Codex 原生会话系统作为后续同级后端接入。普通模型 API 由所属完整后端使用，Agent2API 和 QQ 都不是宿主的必要启动条件。

## 仓库目录

| 目录 | 用途 |
| --- | --- |
| `host/` | 宿主生命周期、身份、配置、输入账本、事件与通知，待实现 |
| `conversation/` | 完整后端目录、会话映射与统一访问门面，待实现 |
| `sdk/` | 已实现后端接入类型、静态验证、有界协议和接入行为测试驱动 |
| `modules/` | 完整会话后端和未来业务模块，每个完整包占一个子目录 |
| `portal_adapter/` | 对接现有客户端的通用门面，待实现 |
| `tests/` | 已实现 P0 契约、子进程隔离与接入验收测试；其他阶段待实现 |
| `docs/architecture/` | 完整方案、接入契约、实施清单、Schema 与示例 |
| `docs/handoff/` | 接手入口、18项实现任务、真实进度、决策及本地参考约定 |
| `tools/` | 当前设计规范校验工具 |

模块统一放在 `modules/<module-id>/`。压缩器、上下文和工具循环属于完整后端内部实现，不各自占用一个必装模块。测试后端放在 `tests/backend_fixtures/`，不被正式模块发现加载。

## 设计与建设顺序

- [完整重构方案](docs/architecture/重构方案.md)
- [整套后端接入契约](docs/architecture/接口契约.md)
- [实施阶段与66项验收定义](docs/architecture/实施与验收.md)
- [模块目录约定](modules/README.md)
- [接手指南与当前任务](docs/handoff/接手指南.md)

建设按 P0 契约与测试工具、P1 独立宿主、P2 OpenCode 参考后端、P3 客户端闭环、P4 故障与恢复验收推进。业务模块的拆分、合并、迁移以及生产切换安排在后续阶段。

## 校验设计文件

需要 Python 3.12 或更高版本。在隔离的开发环境安装校验依赖后执行：

```sh
python -m pip install -r requirements-dev.txt
python tools/validate_design.py
```

校验覆盖 JSON Schema、示例、必要能力约束、文档链接和待实施验收项。它不启动后端，不调用模型，不执行66项运行验收。结果写入本机 `.reports/`，不提交到仓库。

实际实现按 `work-plan.json` 的目标文件与测试推进，完成后更新 `progress.json`。P0 的四项测试可以逐项运行；测试会创建隔离子进程，不连接模型或 QQ，也不使用旧应用数据：

```sh
python tools/run_runtime_checks.py --task P0-01
python tools/run_runtime_checks.py --task P0-02
python tools/run_runtime_checks.py --task P0-03
python tools/run_runtime_checks.py --task P0-04
python -m unittest discover -s tests -t . -v
```

尚未实现的后续任务仍应返回非成功，不能以空测试通过。P0 通过证明测试后端的接入闭环；不代表 OpenCode、Codex 或旧客户端已完成生产接入。

需要参考旧客户端时，复制 `handoff.local.example.json` 为 `handoff.local.json`，填写本地旧项目位置。本机配置和旧源码不会随本仓库提交。

## 数据边界

运行数据统一放在不受版本控制的 `runtime/`。密钥、账号登录态、聊天历史、数据库、浏览器资料、缓存、下载文件和模型权重不属于源码提交内容。示例仅使用合成身份和公开协议，不包含真实用户数据。
