# IM-Assistant

基于完整 OpenCode 应用二次开发的个人助手。尽量复用原生前端交互、客户端数据访问、会话服务、Inbox、历史、数据库、上下文和压缩；裁剪项目文件树及文件操作能力，换上助手的视觉样式和有限动效，再逐项接回需要的个人助手能力。

当前是重写后的实施计划，尚未导入上游源码或构建新应用。正式源码版本待选择，下一任务为R0-01。原“独立Python宿主+OpenCode后端”路线已归档；已有P0代码与49项测试仅为历史参考，不代表新版应用已经完成。

- [完整重构方案](docs/architecture/重构方案.md)
- [接手指南](docs/handoff/接手指南.md)
- [当前任务与依赖](docs/handoff/work-plan.json)
- [36项新路线验收](docs/architecture/实施与验收.md)
- [旧路线和完成证据](docs/archive/python-host-plan/README.md)

## 主要边界

项目文件树、文件编辑/读取/检索/补丁及通用shell等编码能力从助手产品移除；应用内部数据库、受控附件和明确业务文件处理仍保留。去掉文件能力不意味着删除所有磁盘持久化。

OpenCode普通API会话沿用原生执行和队列。Codex整套原生会话作为适配能力保留线程、账号、上下文和压缩，不套入另一层模型循环。QQ仅是可选转发入口，不影响应用启动。

旧助手保留在本地，提供能力探索、现行规则和缺陷经验，不整体搬入旧宿主、队列及私人数据。研究、下载、设备、播放器和小羊等按后续模块阶段逐项接回。

## 当前目录

opencode/为未来源码导入位置，upstream/记录正式来源和补丁，modules/放完整能力包。当前这些实现仍待任务创建。sdk/、host/、conversation/及portal_adapter/是旧路线的参考代码或预留位置，不是新版应用的主运行层。

## 接手检查

```sh
python -m pip install -r requirements-dev.txt
python tools/next_task.py --json
python tools/validate_design.py
python tools/run_runtime_checks.py --task R0-01
```

最后一条当前应报告尚未实现。原生构建/运行命令须由R0按选定源码核实，不能把设计校验或旧测试冒充新应用可运行。

旧客户端源码和handoff.local.json仅本地保存。凭据、会话、数据库、浏览器状态、运行日志、下载和第三方二进制不提交。上游源码导入时保留其LICENSE及版权，IM-Assistant是独立二次开发项目，不代表OpenCode官方产品。
