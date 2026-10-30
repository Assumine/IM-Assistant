> 历史参考：本目录属于已归档的Python宿主P0探索，不是当前OpenCode应用的主实现。旧49项测试不计入新路线验收。

# 后端接入 SDK

这是完整会话后端的公开边界，不包含模型执行器或原生会话调度器。

- contracts.py：公共类型、必需方法和能力映射。
- errors.py：显式错误及重试策略。
- manifest.py：有界静态包/描述/事件校验；不导入入口，不探测网络。
- jsonrpc.py、transport.py：UTF-8 LF JSON-RPC、并发响应与事件分流、有界积压；超时不取消任务、不自行重发。
- conformance.py：只在隔离实例运行的统一行为验收，覆盖提交、幂等、事件、历史、重启和已实现的可选能力探针。

Schema 位于 docs/architecture/contracts，当前从仓库内加载，运行需安装 requirements-dev.txt 的 jsonschema。SDK 尚未打包为独立分发包。

ConformanceRunner 必须显式传入隔离 Endpoint；reconnect 回调负责重启自己的测试实例并返回新世代。验证排队动作还需 hold_execution 测试回调，保证输入确实处于等待状态；不允许暂停用户生产任务来制造测试条件。缺少恢复条件或对应探针时返回 failed/unverified，不计为通过，不启用该能力。

当前行为探针覆盖 queue_inspect、queue_reorder、queue_withdraw、context_inspect、compact、usage。其他可选能力即使结构合法，仍报告 unverified；后续接入方应补充真实行为探针。资源接口当前仅完成结构、范围和作用域校验，授权及到期行为须由实际后端验证。
