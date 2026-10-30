# 模块包目录

所有后端与后续业务扩展统一放入 `modules/<module-id>/`，一个子目录代表一套完整包。

后续目录可以是 `modules/opencode/`、`modules/codex/` 或某个完整业务模块。这里暂不创建这些实现，避免把预留目录当作已完成模块。

完整会话后端可以自带历史、原生上下文、队列、工具、压缩、连接配置和自己的运行依赖。只通过一个整体后端契约接入壳，不要求把内部机制拆成独立插件。

包的静态清单声明类型、版本、宿主协议和一个入口；宿主按类型和能力发现，不能把文件夹名作为业务判断条件。源码与静态资源留在包内，实际运行数据由宿主分配到 `runtime/modules/<module-id>/<instance-id>/`，不写入源码树。

测试专用后端只放在 `tests/backend_fixtures/`。现有旧项目的模块不会在本阶段复制或自动加载。

参见 [完整后端接入契约](../docs/architecture/接口契约.md) 和 [清单 Schema](../docs/architecture/contracts/module-manifest.schema.json)。
