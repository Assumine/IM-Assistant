# Codex 原生接入边界与当前切片

R3-01已通过正式隔离可行性验收，记录A20–A22；不是整个R3或生产发布完成。`modules/codex-native`已有原生适配器、公共后端定义、原生应用HTTP/SQLite、Windows/Bun共享实例及通用后端设置页。设置页支持查看后端、原生登录状态和只读历史，并可把原始Ref打开为主会话标签。主区域提供原生运行/队列观察、引导/编辑/恢复、文本/草稿、活跃文本及人工提问。产品启动支持显式下次启停，默认关闭；真人账号及生产切换未验收。

## 来源与版本

协议按 [官方 App Server 文档](https://learn.chatgpt.com/docs/app-server) 核对，并使用本机 CLI 的 `app-server generate-json-schema --experimental` 生成版本匹配的隔离 schema。实际验证的是 `codex-cli 0.166.0-alpha.5.1`，不是任意 Codex 版本；可执行文件摘要见 [当前切片证据](../../upstream/codex-checkpoint.json)。未更新、修改或接管现有 Codex 安装和账号。

该版本提供原生持久队列 `thread/queue/add|list|update|delete|reorder|start`。不能只依据通用文档猜测这些实验接口在别的版本也存在。模块打开前锁定实际版本，未来 CLI 变化须重新跑原生边界验收。生成的整份 schema、CLI 二进制、测试 native home 和日志不提交。

## 状态与调用归属

| 内容 | 当前归属和实现 |
| --- | --- |
| native thread/turn/item/queue ID | 原样保留，不转换成 OpenCode `ses_`、Inbox 或消息 ID |
| 输入 | 公共send先原子接纳；普通文本调用原生queue/add，空闲启动由Codex完成 |
| 排序、修改、撤回、显式引导 | 对应原生队列接口；没有助手取出任务再执行的循环 |
| 调整 | 同样经send接纳，delivery=steer并携带expectedTurnID；原生turn/steer校验旧turn ID，control不能绕过接纳追加输入 |
| 历史与恢复 | 原生 resume/read/turns/items 分页，不覆盖 history/path，不复制会话库 |
| 压缩 | 原生 thread/compact/start；本机兼容 API 使用原生本地摘要路径，非 OpenAI 远程 compact |
| 账号、模型 | 原生查询；另有可选认证域投影状态及原生浏览器登录/按ID取消；测试账号为空，未验证真人登录、切换或套餐用量 |
| 生命周期 | 产品后端使用鉴权的原生loopback WebSocket服务；跨进程复用同一PID，客户端关闭不停止执行，整个服务另行显式停止 |
| 传输 | 只保存尚未回包的 RPC 关联；通知直传、不持久化第二份消息历史；关闭事件单独暴露 |
| 应用接纳回执 | 原生KV表原子首写；只保留输入ID、目标、请求摘要和native回执，无正文、待执行内容或调度器 |

已实测：空闲 queue/add 自动启动；忙碌队列可编辑、排序、撤回，并自动依次执行。进程退出后，未完成输入和已完成历史仍由 native store 保存。测试在新进程续接同一 thread；需要显式继续的 pending 项由测试模拟用户引导，不由适配器自动补发。中断不等于撤回已发生的操作，恢复时仍需核对未知结果。

## 已发现且尚未消除的缺口

1. **裸原生队列不提供客户端消息ID幂等性。** 同一clientUserMessageId连续queue/add会生成两个native submission ID。公共入口现已使用原生KV的原子首写保证同一输入只调用一次后端enqueue；8份真实HTTP并发输入只产生一条native队列记录。结果未知时只查native队列/历史，不重发。不能将其宣传为跨系统exactly-once：首写后、原生调用前中断时可能没有实际交付；原生也查不到的输入保持uncertain，须人工核对，不默认为未发送。并发副本也可能在首轮交付尚未可查时暂时返回uncertain；原生可查或回执落盘后重查即可确认，不重新执行。
2. **公共整套后端位置及基础交互已接入，完整闭环仍待验收。** 核心ConversationBackend服务通过现有原生RPC发布有限的list/status/threads/history/execution/login/cancelLogin/create/query/control/send，并按backend ID＋native thread ID路由。普通OpenCode分支保持原Session/Inbox入口；Codex走完整后端，HTTP实测没有插入OpenCode Session或Inbox。原生插件session/provider hooks不足以承载整套后端，因此只补公共位置；不嵌套Agent、不新建外层宿主。Effect插件上下文提供可选experimental.conversation注册，但助手模式继续禁用任意SDK/配置插件，验证由受信任宿主通过公共服务注册。
3. **Windows/Bun共享生命周期已验证，真人认证和完整会话交互仍缺。** 实测两个独立Bun进程同时启动只连接到同一native PID；强杀一个客户端不停止服务；显式停止、重启及带未消费队列的竞争重连不重投旧输入或重复消费。普通stdio实际上允许多个进程打开同一home，因此nativeBackend现在拒绝注册stdio连接；不以进程内Set冒充跨进程锁。当前仍没有真实账户连接、生产线程迁移或UI人工提问转交。

因此package.json仍为实验性且publication=disabled。通用设置页可用，但默认后端清单为空，Codex没有注册到启动、默认模型或会话入口。这不是一次可供用户切换执行器的发布。

接纳键按稳定inputID全局唯一；更换目标、正文或调整目标turn不能复用原ID。accepted表示输入被接纳的事实，不表示任务此刻仍在排队、执行或已经完成；实时状态必须读原生后端。确认回执不会因队列消费或撤回而删除，避免旧输入重投。SQLite首写失败不调用后端，原生已接收但回执更新失败时不报告成功，后续只做核对。没有第二份待执行任务表、后台排空循环或消息历史副本。

## 文件能力边界

该切片只创建空的新 profile。配置摘要、目录归属和 CLI 版本在打开时检查，采用固定只读审批策略及禁用工具配置，不接纳任意原始 config、工作目录、MCP、动态工具或文件输入。密钥仅经受控 `IM_` 环境变量传入自身子进程；不复制旧 home，不记录原始 stderr 或密钥。

真实模型请求中只广告 request_user_input。测试服务强行返回未广告的 exec_command、apply_patch、view_image、MCP 文件读取和 spawn_agent 调用；原生 dispatcher 分别拒绝。自有 sentinel 未读出、未改写，补丁目标文件未生成。不能只凭隐藏工具名推断禁用成功。

除下文已接入的item/tool/requestUserInput外，服务端主动工具/审批请求均拒绝，不执行或自动批准。人工提问受原生模式和连接捕获范围限制，不能称所有交互完整。以上是该版本、受控profile的能力验证，不是OS沙盒证明，也不代表用户既有Codex系统被去除了文件能力。新增工具、配置、登录来源或CLI升级都须重新验证。

## 原生共享服务生命周期

`createSharedProfile`只在新目录创建端点、随机令牌文件及校验元数据；`loadProfile`核对后读取。连接限定127.0.0.1，通过Authorization握手，令牌内容不进URL、进程参数或应用公开事件。原生监听器本身的OS绑定保证同一端点只有一个执行器；竞争启动产生的落败CLI无法监听/接纳输入，客户端转接到已鉴权、home/版本/生效策略一致的实例。没有新服务端协议、守护转发层、PID文件锁或过期抢锁。断开连接只清理本连接的RPC关联，输入仍归native队列。

每次重连会核对config/read的实际配置与原生层；该版本的typed config省略update_plan，使用原生最高优先级配置层补核对，不将缺失伪作已禁用。策略不一致或令牌被修改时拒绝接管，也拒绝用停止接口杀掉未验证的监听器。shared路径强制使用锁定Bun宿主的鉴权WebSocket能力，不在Node中静默降级到无鉴权连接或stdio。

普通close只断开客户端。stopSharedService是受信任宿主的显式整实例操作：从已验证的原生diagnostics取得实际PID、停止并等待连接关闭，不将此能力暴露给模型/GUI RPC。服务断开时，后端注册与事件订阅自动撤下，旧作用域收尾不会误删后来注册的替代实例。窗口关闭、会话切换和普通客户端断开不得调用整实例停止。

原生daemon在本机报“缺少完整本地CLI包”，没有伪造manifest或安装/升级真实服务。本地Unix控制套接字也未通过本机目录私有性检查，没有绕过该检查，转而使用原生显式鉴权WebSocket。WebSocket仍是[官方标记的实验路径](https://learn.chatgpt.com/docs/app-server)，当前仅Windows/Bun、本地合成上游验证；真实账户、多用户目录ACL及正式激活未验收。其他OS未测只是范围说明，不扩大当前Windows任务。

## 后端设置与认证交互

通用backends内置GUI插件使用已有SettingsPage贡献位置，并在main/window两侧登记；不增加Codex专用核心页面，不进入provider列表。页面支持按服务器查看已注册后端、连接及可选账号状态，原选择离线后仍保留。选择只用于检查连接，不代表更改会话执行器；没有调用Session.create/Inbox或新增消息数据库。

公共RPC定义按原生Goal示例改为Standard Schema，Promise客户端可直接使用，不手改生成代码。新增changed通知用于注册/断连刷新；authentication通知只投影登录完成或账号变化。状态、登录URL和取消参数均有有限schema；无认证域返回null，与已登出、无需登录、连接不可用明确区分。状态输出移除未声明字段，拒绝脚本、带userinfo或非HTTPS登录URL；native异常不透传敏感正文。不开放任意RPC、API密钥或外部token注入。

Codex模块使用[官方认证接口](https://learn.chatgpt.com/docs/app-server)：account/read不强制刷新token，browser login由原生App Server持有回调和凭据，取消只传明确login ID。配置使用不需要OpenAI认证的兼容API时不启动ChatGPT登录。URL通过单独“打开登录页”按钮打开，远程服务器页面提示回本机登录；没有在测试中打开真实认证站点或复制旧凭据。页面离开/客户端替换会释放请求及订阅；页面激活、后端事件、连接变化和手动刷新才读取，无定时轮询。迟到的账号快照、比请求回包更早的登录事件和取消过程中到达的失败事件均不能覆盖另一后端或虚留等待状态。

## 只读原生会话浏览

完整后端Definition增加可选browse域；公共threads/history只返回有限展示投影，核心核对列表的backend归属和历史的完整Ref。原生RPC编码沿用Standard Schema及optional编码器，先按Schema.toType校验后端返回值，再在传输时去掉undefined可选字段，避免空游标导致JSON编码失败。没有新增Protocol/HttpApi或生成客户端。

原生SettingsPage内可打开通用ConversationBrowser，列表和历史均按20条分页，native游标保持不透明。历史每页按来源顺序展示，旧页前置，按turn ID＋item ID去重，不用字典序或时间戳重排；切换线程的迟到回包不能覆盖当前选择，加载旧页保留可见记录的位置。弹窗关闭或客户端切换会中止请求、释放事件订阅；无计时器或后台轮询。只保存当前可见快照，不持久化第二份历史。

Codex列表按profile工作区过滤，读取时再次核对thread.cwd。thread/read(includeTurns=false)和thread/items/list(sortDirection=desc)读取后反转单页，取得最近页并向前分页；这两个原生操作不resume线程。实测服务重启后读取持久线程仍为notLoaded，不增加模型调用；另一个工作区的线程不展示且不能读取。未支持的非文本条目保留native ID和所在位置，显示未完整预览的活动记录，不冒充assistant文本。当前没有Markdown/附件/工具展示；活跃文本增量见后文。

只读弹窗和主区域复用同一ConversationBrowser历史读取器，不是独立会话宿主。主标签已保留整套后端Ref，并增加有限队列交互；原生文本编辑器已接入公共send。原生OpenCode Session页继续绑定自己的Session ID，不能为复用组件伪造Session或将Codex输入再插入Inbox。

## 原生运行和队列投影

Definition增加可选execution域，现有公共RPC增加execution，共11个固定方法。执行器直接返回原生thread状态、最新turn ID/结果、pending队列页和nextCursor；核心校验完整Ref，剔除未声明字段，不建立第二份运行或待办数据库。已接纳回执是历史事实，execution才是本次观察到的运行/待办情况；执行中的输入不作为pending展示。空pending页可以同时有running turn；nextCursor存在时不能把这一页的长度当作总队列长度。

Codex读取thread/read元数据、thread/turns/list(limit=1, itemsView=notLoaded)和thread/queue/list；不加载整段turn内容、不resume或生成。三次读取不是原子快照，latest turn也可能已完成，不能依据一次观察承诺仍可调整；send(delivery=steer)仍必须带原生expectedTurnID，由原生校验。编辑/排序/撤回继续走既有control，不从回执推导队列状态，也不增加排空循环。原生分页结果及游标不重排、不合并成宿主队列。

activity是通用失效通知，仅包含Ref和execution/history/both。Codex映射queue/status变化、turn开始/结束、item完成及标题变化，不把文本delta逐条变成重读。转发前读取元数据核对工作区；核对失败不泄露另一个工作区的事件。此异步核对可能令失效提示先后交错，因此事件不携带执行状态、不保证重放顺序；前端仅为当前可见数据合并重读。退订和旧注册释放后丢弃迟到事件；核心另外检查backend归属及注册实例，防止旧实例污染替代实例。没有新增轮询定时器。人工提问后端与UI已接；GUI已消费失效通知，另用content处理逐段文本，不把content转换成每token重读。

工作区校验也补到旧query/control/enqueue/reconcile：不能绕过history入口，拿同home另一工作区的thread ID续接、发送或压缩。验证拒绝这些操作并确认没有额外模型请求。API不提供任意native RPC或工作目录配置。

## 主会话标签承载

GUI SDK增加BackendView贡献位置和ctx.tabs.openBackend，ShellTab分别提供可选backend引用与原有SessionRef。主路由为/server/:serverKey/backend/:backendID/thread/:threadID，只接受原始Ref。无精确backendID匹配时使用第一个通用视图；没有视图就显示不可用，不转换为Session。贡献带插件上下文和错误隔离；Ref身份切换释放旧视图，异步历史响应不能写入另一线程。

TabStorage增加backend变体，只保存server、Ref和标题。标签新增与普通Session共用addConversationTab；排序、导航、最近标签、关闭/重开和持久化仍归原shell，不增加另一份标签或任务状态机。闭合记录与Session删除清理按类型/完整身份区分，不因为native ID与Session ID相同而删除另一类。后端离线、视图失效或读取失败均保留原Ref；关闭只是撤掉读取器。标签标题更新只是本地展示，不重命名native thread。

backends内置GUI插件提供通用、按需加载的主视图。从设置历史的Open as tab按钮打开；主区域不显示另一列线程选择器，仍保留原读者的分页、阅读锚点、错误和部分内容提示。路由加载有相同尺寸的原生容器占位，没有跨整个窗口的Suspense空白。主视图复用原生编辑器及队列，没有另加表单或队列副本；只读预览不负责接纳。

## 主区域队列交互

ctx.ui.QueuePanel经UiQueueView复用Session原面板及拖动、进入/退出展示，不复制SessionQueue控制器。backends插件仅保留可见execution快照，经control调用guide/withdraw/reorder，再读取原生结果。打开视图只观察；不会从本地取任务、自动发下一项或伪造Session。读取串行合并失效，不轮询；server代际/Ref生命周期隔离异步回包。未知操作结果保留提示并阻止下一操作，需人工刷新核对，不自动重试。nextCursor存在时禁用排序；空pending与running独立。停放队列Send未接入、不展示；原位编辑/确认撤回后恢复由公共BackendComposer适配原生交互。

上一阶段新增两项生产浏览器用例验证原始身份的操作和迟到回包、不完整页/错误提示，并重跑原Session队列39项；该阶段为199项相关测试及10项HTTP。本轮又加入原生文本发送和生命周期历史更新，当前计数见下节。活跃文本增量已交付，正式激活仍未交付。

## 原生文本发送与草稿

ctx.ui.BackendComposer复用ComposerEditor、createComposerEditor、原生草稿状态/持久化及createComposerSubmission，输入经插件的公共send回调传入原始Ref，不伪造Session或模型provider。Enter投递queue、Shift+Enter换行；无本地shell/命令/文件上下文/附件入口。草稿按server/backend/thread隔离，只保留一个待确认handoff；它没有自动执行/重投能力。发送时清原稿但保留快照，后续编辑不被旧回执抹掉。uncertain/网络失败需要用户明确核对，沿用原ID与正文，重开/刷新不自动send。视图切换不取消已派发接纳，迟到UI结果不串线。原生草稿存储故障或跨进程崩溃下不承诺exactly-once。

真实CLI确认notLoaded线程虽接受queue/add但不执行，明确新queue输入现在先原生resume再入队；仅发生在首次send的enqueue，不发生在浏览或reconcile。原只读场景增加真实恢复输入和native-reply-4断言，读取依然不增加模型请求。主界面在接纳后及原生完成活动后读取历史，旧消息阅读期间保留锚点并提示最新内容，不做逐token轮询。

当前316项相关测试（100原生/协议/单测＋216浏览器/组件）及19项HTTP/产品启动检查通过，完整check通过；R3-01隔离可行性验收已接入，桌面全链路/真人账号/完整权限矩阵仍未验收。性能基准是既有输入的小样本，不是整应用性能完成证明。

## 控制回执与原轮次停止

control返回ControlResult：applied只表示后端确认操作，not-found表示待办目标已不在队列。Codex的withdraw根据deleted返回结果；不是从UI缺失猜测撤回成功。核心校验类型、剔除私有字段；异常/断线仍是未知，不能自动重试或恢复成待发送正文。HTTP和真实CLI检查第一次withdraw为applied，第二次为not-found，其他队列项未受影响。

Stop仅在原生thread/turn均running时提供，携带点击时的原始turn ID，底层拒绝过期ID而不是停止后来的turn。真实CLI证明旧turn ID停止请求被拒绝且原任务仍在运行，再以正确ID中断；浏览器覆盖慢回执期间轮次变化、未知结果/人工核对、成功回执不伪造空闲，以及同thread ID跨backend的迟到回包隔离。已派发控制不使用视图的AbortSignal，读取/订阅照常清理，旧UI结果丢弃。队列编辑/确认撤回后恢复已接入，直接文本Steer已接入，人工提问UI已接，不以这些控制回执宣称完整交互完成。

## 队列编辑与确认撤回恢复

公共BackendComposer可接execution/busy/control，由宿主复用原生队列面板和编辑器；插件只持有观察及通用RPC回调。共用queue-draft.ts的捕获/模式→正文→retry恢复和追加规则，原Session仍保留其Inbox控制器。Codex编辑只update原native ID，不撤回再接纳。保存时若又打字，旧回执不清新编辑；已消费条目不变成新任务。编辑ID和stash随完整Ref草稿持久化，刷新/加载不自动发送。

撤回到输入框只接受明确applied；合并到等待期间的最新草稿，not-found不恢复。未知结果保留原文/编辑未确认状态供核对，不凭队列缺失恢复，不自动重试。取消编辑和Dismiss只管理本地草稿记录，不能声称回滚native操作。未完整显示的输入不能通过文本编辑/恢复丢掉附件。草稿沿用原生异步持久化，恢复测试等实际IndexedDB提交后刷新，不保证突然关闭前未提交数据或跨进程exactly-once。

两项生产keeper覆盖此交互，并重跑完整原Session队列/编辑器/标签和插件宿主。草稿恢复的故意reset变异被新keeper拒绝，恢复字节后重新完整验收；不是静态源码检查或仅挂假按钮。

## 直接引导、拒绝事实与活跃文本

原生编辑器alternate delivery显示Steer及Mod+Enter，Enter仍queue。输入固定原Ref/inputID/expectedTurnID，确定拒绝与未知交付区分；未有可用轮次时保留草稿并提示，不另建任务。锁定CLI的InvalidRequest/InvalidParams转为rejected/not-accepted，原生旧turn已实测-32600；不解析错误文案，不把内部故障或断线当未发送。已有KV保留拒绝事实，核对/重注册/SQLite重启不重入队；UI确定拒绝后只恢复文本，原ID未知回执仍原样核对。

content是可选的原生ephemeral输出域，未增加RPC方法或历史数据库。History附活跃文本快照；新捕获streamID、原turn/item ID、UTF-16偏移及最终快照让增量可去重。Codex每轮readOwned一次，验证后才发布，不每token读数据库；只有agentMessage正文投影。完成/退订清缓存。中途缺起点不编造前缀，仍由native完成历史最终对齐。GUI缺口只自动补一次快照，读旧记录不跳位置，reconcile按位置合并而不重建增长消息节点；source与UI均有真实边界验证。

316项相关测试和19项HTTP/产品启动检查已通过，仍只作为R3局部验证；真实账号、另一Windows用户登录和正式产品激活未完成。流式文本不代表推理/工具输出及富媒体已全部接入，也不宣称断线期间完整重放。

## 人工提问的原生桥接与呈现

只允许item/tool/requestUserInput进入待答关联，其他host请求仍-32601拒绝。无owner的观察连接不能自动拒答：原生会广播同一问题。owner先核对工作区，只公开结构有效且非秘密的问题；公共随机questionID不暴露底层request ID，退订/重新捕获时失效。投影不持久化答案，不承担任务调度。问题里的other=false必须由前端禁用自填并由后端再次校验。

已有execution增加可选questions，control增加answer/dismiss-question，仍11个固定RPC。答案按题ID完整校验；错thread、旧ID和已解决问题不写回。底层发出JSON-RPC response后保留responding，等待匹配thread/request ID及类型的serverRequest/resolved，回执为resolved而不是applied；其他客户端可能抢先答复，不能承诺本地答案获胜。未知结果不自动重发。dismiss仅空answers跳过，不停止整个任务。轮次结束/连接关闭清理。

真实CLI已验证多题及自填、观察连接不抢答、非法答案拒绝、重新捕获换ID、结果进入下一原生模型输入、跳过空答案及等待中断清理。线协议覆盖确认前不报成功、超时/重复不重投、错thread/request类型、所有其他host能力继续拒绝。锁定CLI在Default下拒绝request_user_input，产品不为提问自动切Plan。初始rollout尚未建立时原生读取可能失败，不伪造空闲；之后的等待状态可正常读取。

提问UI已通过公共BackendQuestion复用原生QuestionDock，保留原Session行为及完整Ref草稿。新连接错过广播后的待答枚举也未验证；不能合成问答或自动恢复答案。此后端切片不代表正式R3已完成，不开放生产注册。

## 原生提问面板与草稿保留

ctx.ui.BackendQuestion按需加载原生classic/experimental呈现器；只传id/字段和回调，不伪造Session/FormInfo的sessionID。原Session的reply/cancel仍走ServerSDK；整套后端仅经已有control发送answer/dismiss-question。选项/自填/多题/快捷键/最小化/动效和内存questionCache均复用原实现。Schema校验字符串答案，后端题目逐题必答；custom=false同时控制自填UI和键盘路径。

blocking时保持原编辑器挂载但隐藏/inert，并禁用发送及队列动作；不阻塞的问题仍可编辑。未提交选择按完整server/backend/thread/question隔离；原生解决时清当前缓存。派发只由显式交互触发，不自动重试或隐藏，resolved/not-found也要等待原生投影移除问题；未知结果固定提示并人工刷新，responding不可重答。旧视图迟到错误丢弃，写入不随导航取消。没有Session/Inbox、权限批准、自动切Plan或第二个调度器。

新增3项表驱动/竞态keeper，加原5项请求面板原生回归，总8项。覆盖两种样式、关闭自填及快捷键、必答、草稿同节点保留、非阻塞、慢确认/状态滞后、未知答复/刷新、跨backend相同ID、缓存和迟到失败。缺失贡献的变异确实触发失败，恢复后完整gate通过。未验证真人账号或全局默认后端切换，不把UI接入算作整个R3完成。

## 新建页的明确后端入口

公共new-session.actions只提供server key，不开放原草稿控制权。backends插件按需加载入口；用户明确选择后才创建空的原生线程，或在同一个弹窗切换到原历史预览。原OpenCode草稿保留、原提交逻辑不变；选择不是默认执行器切换，不自动转送正文或fallback。create/browse能力决定按钮；目录只在打开、显式刷新和注册变化时读取，不后台轮询，失效选择保留。

现有create RPC返回规范化Created.thread与原Ref，核心剥离私有字段、检查backendID和await前后的注册实例。创建不resume、不入队或请求模型。非幂等写入在关闭后继续完成，但视图不接受迟到导航；创建期间禁用重复操作。结果未知时提示查原生历史并禁用本次弹窗内的再次创建，不自动重试，也不增加请求数据库。原生CLI、真实应用HTTP和生产构建keeper分别验证其各自边界。

新增3项进入原new-session keeper，完整30项纳入gate；覆盖一次创建、草稿保留、无隐式Session/发送、失效选择、只读能力、原Ref打开、未知不重投及关闭后迟到结果。三项各10次并发重复通过，完整新建页keeper全并行通过。以上仍为隔离测试，不代表真人账号、正式激活或整个R3完成。

## Home的原生线程分组

公共home.sessions.before只给当前server key，不开放Session数据与控制器。backends插件贡献默认收起的分组，展开才读目录，明确选择后端才挂原生列表；后端ID为读取器生命周期key。ConversationBrowser的listOnly模式复用原列表、分页/去重/错误与取消机制，单行标题、右侧原生状态，点击直接打开原Ref，没有历史预览、resume或接纳。

活动只改变刷新提示，不轮询或自动重排快照；收起/离开释放读取订阅。目录刷新保留数据，注册消失保留选择并显示不可用，不自动fallback。原Home搜索、分组、数据库与默认发送仍归OpenCode，没有额外默认后端偏好、跨后端搜索或归档。

原Home14项keeper保留并新增2项；覆盖按需读取、列表模式与直接打开、同ID隔离、目录错误/恢复、切换和失效选择、收起后的停止订阅。去掉身份key的变异在Beta条目断言失败，恢复摘要后整体通过；两项各10次并发重复和Home16项全并行均通过。以上仍为隔离验证，未开放生产注册。

## 可信启动组合与专用profile权限

公共Module工厂只接受可信程序代码组合，返回Definition和本连接close；不是可序列化配置或可远程加载的插件。原createRoutes/createEmbeddedRoutes、ServerFetch.make与ServerProcess.start接收可选模块列表，默认空列表。模块在原应用Scope分别获取连接和注册，未就绪或失败不阻断路由/其他模块，ID不匹配拒绝并释放。作用域结束先撤下目录，再关闭本连接；不隐式停止native服务/其他客户端任务，不增加调度器或自动重试。nativeModule复用原适配器，无启动时线程创建、登录或输入。

真实HTTP样本现通过启动模块列表加载，覆盖正常、失败、未就绪及身份不匹配模块；Scope退出保留原生运行请求，下一Scope读取原SQLite回执、原native线程，仍仅4次合成模型调用。断线等待模块自身onClose，再断言公共目录已撤下。产品装配已接到原CLI启动链并验证真实产品CLI；显式初始化/启停仅影响下次启动，默认关闭。桌面本轮未重新运行，不能据此宣称安装包或生产切换已完成。

创建空专用home先限制访问，再写凭据。Windows x64以Bun FFI调用系统安全API，DACL只允许当前用户与SYSTEM，根受保护、子项继承；重新打开核对home/workspace/配置/标记/令牌的所有者和权限，额外普通身份授权即拒绝，旧弱权限目录不自动接管/修改。产品不调用PowerShell或解析icacls输出。POSIX的0700/0600与UID分支尚未在本轮Windows环境验收。

真实OS用例分别向隔离根目录和令牌添加Everyone读取授权，确认读取/连接拒绝、服务未启动且无模型请求，再移除授权确认恢复。该用例不等于第二Windows用户实际登录，也不阻止同一用户程序或管理员权限。共享WebSocket仍实验性，真人认证及其他OS仍未验收。权限漂移检查补上的是凭据访问边界，文件/工具能力的原生强制拒绝继续独立验证。

## 真实验证

`python -m tools.codex_native_smoke`调用锁定工具链，执行模块类型检查、15个真实Codex场景、1个真实OS权限漂移场景、4个Connection线协议场景、20个核心/RPC/KV单测、3个服务端权限/错误回归、42个原生标签/路由/持久化单测、185个生产构建设置/历史/完整标签/完整队列/原生编辑器浏览器回归、12项真实原生应用HTTP/SQLite检查及完整canonical check。所有模型调用在新建隔离profile、本地合成Responses服务中执行，没有真实上游账号或模型请求。原始模块场景包括：

- 原生队列自动启动、忙碌时编辑/排序/撤回、FIFO 和历史分页；额外确认重复 clientUserMessageId 并不去重。
- 进程退出后的 native pending/历史恢复，原生 ID 和只读账号结果保持，不补发已交付输入。
- 原生 expectedTurnId 防止过期调整，中断状态来自原生事件。
- 强制未开放工具调用在原生 dispatcher 被拒绝。
- 原生本地压缩后重启，下一次真实模型输入使用压缩上下文，不再带旧 assistant 回复。
- 非空 home 拒绝接管、同进程重复打开拒绝、配置篡改拒绝、文件输入和无效参数拒绝。

新增共享场景覆盖：断开一个客户端后原请求继续、独立进程同PID竞争与客户端崩溃、显式停止/恢复历史、持久待办重连后消费一次、策略或令牌不匹配拒绝、以及共享执行器中同样强制调用五类禁用工具。六项stdio用例只作隔离基线，不能作为产品入口；共享路径没有降低原文件工具边界。

HTTP验证现使用共享native profile，证明发送/调整共用接纳ID与turn前提、8份并发只产生一个队列项、丢失回执后查队列、消费后查历史、SQLite重启返回原回执、OpenCode Session/Inbox不重复接纳，以及native断开后真实RPC清单自动撤下。此HTTP样本4次合成模型请求，未调用真实账号。故障单测另覆盖中断后不盲目重发、SQLite回执更新失败不虚报成功、ID冲突及旧注册收尾不误删替代实例。

设置页原6个场景覆盖离线选择保留、离开页面停止订阅、无轮询、原生浏览器完成通知、按login ID取消、切换后端时的迟到快照、完成事件早于login回包、失败后不自动重试。另3项覆盖原生列表/历史分页、跨turn相同item ID、来源顺序、重复边界条目、阅读锚点、切换后的迟到历史、读取失败/重试/部分内容提示和关闭后的无额外读取。HTTP另证明真实CLI的账号投影/取消与读取不二次接纳、不增加模型请求。浏览器认证只使用合成夹具，不冒充真人认证通过。execution场景和核心通知归属/旧注册回归保留；HTTP实际验证空待办但仍在运行、待办分页和编辑/排序/撤回只作用同一原生队列，模型仍4次。前一轮50项浏览器回归包含完整标签keeper和原9项设置，新增主标签用例证明两个backend与普通Session共享同一ID时不串线、刷新恢复、关闭重开、离线不改绑且无发送/续接请求；31项插件宿主回归另重跑通过。性能基准前后各3次仅为小样本描述，不能宣称整个应用性能已验收。

R3-01已通过tests/rebase/test_r3_01.py的隔离可行性验收；完整checkpoint仍partial_verified，生产发布仍disabled，QQ/真人账号/桌面与完整权限矩阵不是已验收项。累计产品补丁167个文件，源码最终摘要与台账保存。未改变Protocol/HttpApi，使用现有通用RPC，不手改生成客户端。助手权限仍仅放行此RPC的11个固定方法；任意RPC、MCP、文件和shell入口继续禁用。单独typecheck:e2e仍有原14条诊断，不标通过；既有client全套计时失败仍留R5处理。

## R3-01的正式隔离可行性验收

`python tools/run_runtime_checks.py --task R3-01`现调用实际原生CLI、真实产品CLI、HTTP/SQLite、生产浏览器和组件，不采用已有checkpoint当运行结果。A20–A22按计划的最小可行性切片记录；不是整个R3、真实账号迁移或安装包发布。316项相关原生/浏览器检查与19项HTTP/产品检查另附2项Python编排结果，计数不重叠。HTTP和产品启动两项夹具合计5次模型请求（不含各原生单测的独立本地夹具），没有生产凭据。

产品新增`backend codex init|enable|disable|status`。固定home位于助手数据根/modules/codex-native，init拒绝采用非空资料；激活配置在受保护home中，仅记录版本、启用和绝对可执行文件路径，不存账号或密钥，不接受任意插件路径。配置写入原子替换，错误配置让此可选后端不可用，普通核心仍启动。启停只影响下次正常服务启动，不热替换或迁移正在执行的任务，不停止共享native服务。

真实产品进程验证7项，包括全新home冷启动signed-out、启用/停用仅下次生效、产品进程退出保留native原任务/PID、重启复用原SQLite接纳回执和native历史、不重复模型生成，以及坏配置不阻塞核心。产品包负责具体能力组合；核心CLI只在personal profile下调用组合并将公共Module交给原ServerProcess.start，不含Codex业务分支。桌面沿原CLI服务链，但本轮仅实际验证产品CLI，真实桌面与发布构建仍另列。

最终证据见upstream/codex-verification.json；它与仍为partial_verified的checkpoint分别表示已通过的隔离切片和未完成的生产发布范围。真人登录/刷新凭据、另一Windows用户实际登录、其他OS、新连接待答恢复、QQ和R4/R5门槛仍未完成。原14条E2E类型诊断不因此变成通过。

## 下一步实施边界

公共整套后端位置、Windows/Bun共享实例、设置/登录状态、主会话标签和文本发送已实现。新建页和Home已提供明确的整套后端入口；下一步按R3-02接回QQ薄转发，生产发布前另做真人账号及桌面/权限矩阵验证；不直接读取或复制旧Codex凭据。保持OpenCode原Session/Inbox不变，不能在设置弹窗长出第二套会话运行层。使用createSharedProfile/loadProfile和nativeBackend，不能回退stdio或把KV首写当成执行锁。遵守窗口关闭只断连、明确停止才终止整实例的区分。设置页选择是检查对象；只有明确Open as tab才打开原始Ref，并不更换默认执行器。

前端可以复用原生展示与交互组件，但不能为复用而向 OpenCode Inbox 再插入 Codex 待执行消息。恢复/重复投递的接纳策略、同 profile 生命周期和 native UI 契约须真实验证，正式R3-01入口已覆盖当前本地闭环，生产开放前仍要完成剩余发布门槛。QQ 仍是可选转发层，不能解决这些公共框架缺口或成为执行入口所有者。

主标签及队列公共展示契约已补齐，原生编辑器已通过公共BackendComposer适配；不使用要求Session.prompt/ServerSDK的旧adapter。队列编辑/恢复已共用原生草稿暂存与恢复，新建页和Home入口已接，接下来接回QQ薄转发；生产激活仍需独立验证，不能复制控制器、伪造Session或从插件导入app私有模块。原生线程输入经send，队列经control，运行/历史从execution/history读取；不因打开、切换、收到完成通知而自行调度下一条。原生编辑器已经接入，不能另加临时表单或本地可执行队列。

## QQ受控图片增量

本轮在1b6566f后加入通用可选images描述及inline图片输入字段，原请求无附件时的摘要与native参数保持兼容。Codex仍自己持有image输入、队列、线程、上下文与压缩；不写OpenCode影子Session，不允许localImage、任意file路径或URL代读。QQ图文及纯图通过原生queue/add，当前补充使用expectedTurnId护栏，已结束引用使用原生后续接纳；按原起始QQ消息发送结果。原生读取未给出完整公开证据时继续等事件，不把暂未证实的中间输出当完成。

队列原生update会覆盖整份payload，没有CAS；公共文字编辑先检查原队列并拒绝含非文本部分的输入，避免覆盖图片。未提供原子附件合并，不能据此开放Codex待办追加。已验证真实回环链路和模块30项；当前前端输入框与历史缩略图未扩展，旧完整355项/browser证据仍绑定原source_revision，最新增量以qq-checkpoint为准。
