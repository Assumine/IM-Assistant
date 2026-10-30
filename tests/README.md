# 测试说明

当前活动计划是完整OpenCode应用二次开发。test_plan_tools.py只验证计划ID、任务路由、历史计划显式选择及防止错误完成的接手工具；它不证明原生应用已经运行。

```sh
python -m unittest tests.test_plan_tools -v
python tools/run_runtime_checks.py --task R0-01
```

第二条当前应报告新任务尚未实现。未来tests/rebase/入口应驱动锁定源码的原生测试、真实网页和Windows桌面，不能只用静态断言代替。

test_contracts.py、test_transport.py、test_backend_fixtures.py和test_conformance.py合计49项测试属于已归档Python宿主P0探索。需要重跑时显式指定归档计划，例如：

```sh
python tools/run_runtime_checks.py --task P0-01 --archived-python-host-plan
```

旧合成后端和SDK保留为幂等、隔离、顺序与恢复经验，不能计入新路线验收。所有测试仅使用合成身份和隔离数据，不读取旧生产库、账号和浏览器资料。
