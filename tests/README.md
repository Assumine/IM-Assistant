# 隔离行为测试

P0 契约、RPC、两套完整测试后端和统一接入驱动已经实现。运行：

```sh
python -m unittest discover -s tests -t . -v
```

临时数据置于 runtime/tests，退出时清理；不读取旧应用数据库、账号或浏览器资料。测试创建的子进程通过自己的标准输入输出接入，测试管理器只停止自己创建的进程。RPC 分帧/隔离用例另使用临时本机端口，不占用正式服务端口。

test_contracts.py 覆盖 F01/F04/F05，test_transport.py 覆盖 F07，test_backend_fixtures.py 覆盖 F02/F03/F06，test_conformance.py 覆盖 F08。实际任务完成记录仍以 progress.json 为准，不由本页单独维护。

P1 至 P4、真实 OpenCode 集成、浏览器及 WebView2 实机验收尚未实现。合成后端成功不能替代这些验收。
