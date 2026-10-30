> 历史参考：本目录属于已归档的Python宿主P0探索，不是当前OpenCode应用的主实现。旧49项测试不计入新路线验收。

# 完整后端夹具

仅供测试，不参与正式模块发现或生产执行。

backend_a 使用 SQLite 对象行与词单元上下文，backend_b 使用原子写入的嵌套 JSON 文档与轮次上下文；原生 ID 格式不同。两者共用测试门面，但存储和上下文变换由各自 store 所有。它们都是合成实现，不是 OpenCode/Codex 的替代品。

client.py 仅通过 stdio 公共 RPC 驱动子进程；control.py 提供同一测试门面和 fixture.configure/fixture.inspect 故障开关。这两个 fixture 方法只存在于测试夹具，不进入生产 SDK 方法或正式模块包。

夹具支持输入持久化/查询、内部队列、修订调序和撤回、稳定历史分页、来源事件、压缩保留历史和重启核对。执行动作只是后端内部的合成计数，没有模型或外部副作用。中断中的运行恢复为 recovery_required，不自动重做。
