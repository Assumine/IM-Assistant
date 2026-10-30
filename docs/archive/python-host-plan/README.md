# 已归档：独立 Python 宿主路线

这套路线已被“基于完整OpenCode应用二次开发”替代，不再继续其待实施P1至P4任务。旧任务和进度保留原样，不以删除记录掩盖已完成工作。

work-plan.json、progress.json、dependency-baseline.json是历史原件；带.md.txt后缀的文件是归档时的文档快照，其中旧相对链接和未来指令不再作为当前实施入口。

当时完成P0四项工作，合计49项隔离行为测试通过，包含SDK、JSON-RPC及两套合成后端。源码仍在仓库sdk/tests中，可作为经验和回归参考；它们不是当前OpenCode应用实现，不计入新路线36项验收。

可通过python tools/run_runtime_checks.py --task P0-01 --archived-python-host-plan显式重跑旧任务；正式接手请回到当前docs/handoff/接手指南.md，下一项应为R0-01。
