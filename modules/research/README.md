# 轻量研究脚本

一条路径就是一个有输入输出的小函数。已提供双分调度、可交接研究协助身份、受控函数编写/测试/发布、跨调用检查点及同一套原生AI/MCP工具，复用原生ApplicationModule、Session/Inbox与KV。已额外验证一条公开GitHub资料采集分支；产品启用入口与浏览器登录态尚未接入。

每轮只选择用途和参数匹配、本轮分最高且不低于零的路径。取得有效结果即结束；已确认可安全重试的失败扣本轮分，再重新比较所有路径。不存在重试次数上限；全部适用路径的本轮分低于零时结束并请求协助。初始分为零的路径仍可执行一次。

历史分是本轮的初始分。默认新路径为 1 分，本轮每次失败扣 2 分；轮末每条路径仅记一次历史变化。成功基础奖励 0.2（发生过失败则除以 1＋失败次数），全部尝试失败扣 0.1，再除以 sqrt(1＋历史有效轮数)。历史轮数多的路径受单轮影响较小。本轮几十次失败也不会变成几十次历史扣分。权重可由可信代码传入，不是执行次数限制。足够多轮的失败仍可让历史分低于零，此时需研究协助维修或发布新 revision；不会自动删除路径。

评分单位是实际可替换的函数，最初可以是完整路径，有真实分叉后可以是局部分支；不对每次点击单独打分。相同category/action且参数契约匹配的函数才会一起比较。普通采集函数可以先调用身份定位，再把有效输出传给资源分支，重选资源方法时复用身份结果，不重新查询主干。下游失败只扣它的函数分数，不连带扣前面成功的函数。跨调用结果绑定原生输入、参数、实现版本和有效性，不隐式跨任务缓存浏览器状态。

success表示取得了符合契约的事实，也包括经证据确认的“没有结果/资源不存在”。这类结果应返回结构化found:false等字段；结果验收验证事实和结构，不把“必须找到资源”当作方法正确性的条件。上层采集函数/研究协助再决定是否使用其他已验证分支。只有实际执行故障才返回failure，防止资源不存在导致可用方法被扣分。

验证码或登录阻塞、未知外部结果和用户取消会停止当前调用，保留原因，历史分不作可靠性判断。函数抛错默认视为结果未知，不能盲目重试；只有显式返回 failure 才表示可以再次调用。函数必须遵循 AbortSignal，并自己遵守网站访问间隔。调度器不负责浏览器轮询，不会开设后台任务。

轮末报告同时是唯一历史事实，写入当前插件的原生 StorageDomain。原生输入结束后才结算历史，同一输入的多次工具调用共享本轮分。只有开始标记而没有完整结果的调用要求核对，不能重放。换revision后重新积累该实现的历史。原生事件驱动核对与取消，没有后台轮询、独立会话库或第二套AI队列。低层createDispatcher及可信代码的run保留函数级验收用途，AI入口统一经过带原生输入归属的工具。

研究协助决定目标、可信路径和参数；研究任务调用已发布函数，陌生分支交回当前协助身份。原生AI和官方MCP客户端已经隔离验证真实回环HTTP采集及工具流程，公开GitHub采集分支另有实际联网记录；浏览器、登录网站及产品界面仍须后续验收，不能用合成数据冒充已开通。

## 最小公开来源测试

[github-repository.json](examples/github-repository.json)是当前AI会话经官方MCP客户端临时接任协助身份后，探测实际响应、编写并测试的一个小函数。输入repository（owner/repository），输出found、fullName、pageURL和defaultBranch；只调用宿主批准的GitHub只读JSON来源。函数结构异常返回uncertain并停止，不猜测字段或另找站点。

运行`python -m tools.research_public_branch`，在临时原生SQLite和两个测试身份中复现探测、保存、测试、发布、执行及重复调用。每次复现向公开GitHub API读取3次，默认间隔5秒，无生产账号或浏览器。当前重放使用1次本地合成响应保持真实原生输入打开，不调用用户模型。第二个身份是确定性的测试调用端，不宣称另一个AI已经自主研究。`--interactive`接受逐行JSON格式的MCP调用（caller、tool、arguments）供真实AI临时接任；完成后发送`{"finish":true}`，退出后关闭本轮服务，不安装全局MCP配置。

原始会话、凭据、数据库及调用全文只留在忽略的runtime目录。[首次公开验证记录](../../tests/modules/research-public-branch-evidence.json)保留4d13199时期的脱敏结果与源码指纹，不重绑为当前源码。该最小测试不等于完整影视/音乐链路；跨调用检查点由单独的S1-02B验收。

路径开辟先完成一条从输入到合格结果的完整采集函数，不预设多个备用网站、空分支或人为节点。首轮若实际发现多个方向，可以在相应位置标记候选分支入口，提示还有另一种走法；未打通的候选方向不注册成可执行函数，也不参与评分。只有实际运行频繁在某处报错时，协助才根据错误记录，在报错位置或更早的合适位置打通同级替代分支。验证后的分支才进入可选路径；不为绘制树状图而制造任务步骤或调用。

## 可交接身份和工具

身份只有版本及当前backendID/threadID。任何授权会话可先读取身份，再在被指派接任时提交已观察版本；交接中断旧持有者的探测/测试并撤销编辑权，原生上下文不转移，无关任务不停用。路径、候选、测试及求助资料归插件KV，新持有者按需读取，不复制其他会话的私人上下文。

原生AI工具由ApplicationModule.tools提供，生命周期、模块名前缀及权限由通用核心管理。只有激活的可信模块能提供业务工具，普通项目、文件、shell及任意MCP工具仍保持原裁剪。

- research_identity / research_adopt：读取职责与身份、按版本接任。
- research_paths / research_candidate：读取目录摘要或指定草稿全文，记录真实发现的候选方向。
- research_probe / research_save / research_test / research_publish：只读探测授权方法，保存不可变草稿，实际测试，发布对应已通过且有采集证据的版本。
- research_run / research_progress / research_help：执行已发布函数，读取当前输入的分数、检查点和结算结果，或将目的及证据送入当前协助者的原生Inbox，不维护另一套AI队列。

草稿为受限函数体，绑定input，只能调用tools中的授权采集方法，返回success/value或failure、blocked、uncertain/reason。复用OpenCode CodeMode解释器，不提供process、require、fetch、Bun、文件或系统接口。相同方法和参数在一次函数内复用观察结果；遇验证或未知结果后，即使程序忽略返回值也不能继续新采集。测试不增加生产分数；发布要求成功测试与实际采集证据，不能只返回固定答案或自述“测试通过”。解释器的单次资源保护不等于路径重试次数上限。

jsonCollector是真实只读HTTP适配器：仅访问宿主批准的origin，模型不能选择其他站点、凭据或写操作，不跟随重定向；默认每次请求间隔5秒，仅在有调用时等待。404是有效负结果，HTML/访问门槛返回blocked，不当作JSON反复解析。它不替代登录浏览器，BrowserAct和站点频率适配仍待接入。

## MCP 接入和后续

createResearchModule(...).mcp(authenticate)返回本机HTTP处理器，使用固定2.3.1官方SDK的[HTTP工厂](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md)，每请求独立协议实例。宿主绑定loopback端口；模块默认不监听，也不改全局MCP配置。

authenticate(token)须由宿主验证凭据并返回真实会话的backendID/threadID；执行还须绑定inputID，可附带原执行器的取消signal。原生工具通过当前assistant消息的inputRootID核实归属，MCP绑定也要经原执行器的公开输入API核实，不能从模型参数取身份或默认选择最新任务。未认证、外部Host或跨源浏览器请求拒绝。MCP只负责协议入口，身份、资料、测试及发布仍由同一研究模块管理。identity/paths资源只读；停用后拒绝新调用，等待已开始的原生移交核对并中断采集，不取消其他会话任务。

安装依赖：python -m tools.setup_research_dependencies。当前验收：python tools/run_runtime_checks.py --task S1-02B；使用隔离SQLite、回环网站、合成模型及官方MCP客户端，原生输入/Inbox回归重复10次。

## 同轮分数与主干检查点

原生输入拥有研究轮。research_run的roundID仅标识本轮内的一次采集调用，更换名称或参数不能重置该输入内已经变负的分数。成功返回checkpoint；后续调用在after中传入依赖的结果引用。这里只保存必要的结果关系，不建设DAG或新的任务队列。

复用须匹配原生输入、采集参数、实现版本、结果契约和全部上游结果。草稿可通过validForMs声明易变结果的有效期；省略时只在原始输入范围内有效。上游过期或版本变化会让下游结果失效，返回仍有效的主干供调用方从最近有效位置继续。readOnly由宿主批准的采集方法决定，模型不能自行声明；下载等操作的旧结果失效须先核对，不能按只读缓存刷新。

采集前持久化意图，采集后保存结果；只剩意图时，不能换调用名称或换方法继续访问。报告保留参数、尝试及可用主干。同一原生输入的卡点最多经当前协助者原生Inbox提交一次求助；新的卡点事实仍保存在当前输入记录中，不反复通知或向自己排队。

原生输入的experimental.outcome提供正常结束、失败或中断的只读证据。旧记录没有该字段时不猜测成功。原生事件和按需读取触发核对，没有后台轮询；结束的输入仍可读取原结果，不能执行新目标。其他整套后端也必须通过原有公共API证明原始输入及结束状态。

此前检查点运行证据见[检查点验收](../../tests/modules/research-checkpoints-evidence.json)，保留原源码指纹。当前产品阶段验收运行`python tools/run_runtime_checks.py --task S1-03`；BrowserAct、真实网站及生产启用仍须后续单独验证，不迁入旧任务或私人历史。

## 产品配置和执行展示

研究作为第三个独立可选业务模块与QQ转发、小羊并列，默认关闭。产品CLI支持`research init|status|enable|disable`以及`research configure <绝对JSON文件路径>`；也可在原生设置的Application modules中点Research的Configure。配置文件位于当前独立资料目录的`modules/research/research.json`，不读取旧助手资料。

最小设置：

```json
{
  "version": 1,
  "enabled": false,
  "sources": [],
  "mcp": { "enabled": false, "port": 0, "clients": [] }
}
```

sources仅接受宿主批准的HTTPS origin或本机HTTP origin，最多16个，不含路径、查询串、凭据或代码。每项为`{"id":"github","origin":"https://api.github.com","minimumIntervalMs":5000}`。一次调用只传已批准的source和相对path；仅一个来源时source可省略。间隔按来源共用，最低5秒，页面HTML、重定向、登录门槛及未知结果不盲目重试。scoring可选，完整字段为initial、failurePenalty、successReward、historicalFailurePenalty；不改变双分含义，也不是次数限制。

保存通过实际文件版本、锁和原子替换避免互相覆盖，明确在**下次服务启动**生效；Stop service仅停止本次资源，不修改下次启用开关。配置损坏或MCP端口异常只影响研究模块，不依赖QQ登录。配置读取、打开界面、重启均不发起研究任务。

启用本机MCP时设置mcp.enabled、port（0为系统分配）及clients。每项只保存tokenEnv（`IM_RESEARCH_MCP_TOKEN_`开头的环境变量名）、backendID、threadID和可选inputID。实际令牌从环境读取后清除，不写入配置、视图或模型请求；至少24字符，不含空白。界面显示实际loopback地址。当前原生opencode输入可通过公开输入归属和结束事件核实取消；其他后端的静态配置仅允许开路/读资料，不允许绑定执行inputID。没有可信原始inputID的MCP调用仍可授权开路，但不能执行采集；不会默认选择最新任务。

原生设置中展开Research的View activity，可读当前目标、会话、实际执行函数、参数摘要、进度/卡点及历史与本轮分。运行记录归插件KV；展示使用通用只读模块文档，不在核心定义研究字段。仅打开且可见时读取，后续由本模块viewChanged事件刷新，关闭或隐藏即取消在途读取，无后台轮询。最近记录和未结算输入以有界列表展示；技术记录默认收起，展开后的文本限制高度并使用原生滚动条。

产品阶段使用真实CLI服务进程、原生AI工具/SQLite、官方MCP客户端及构建后的GUI验证，来源和模型响应均为受控本机测试数据。此前公开GitHub小函数仍是独立联网证据；本阶段不宣称已完成真实影视、音乐、浏览器或账号接入。
