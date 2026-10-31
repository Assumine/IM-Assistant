# Codex 原生接入边界与当前切片

R3-01仍为进行中。`modules/codex-native`已有原生适配器、公共后端定义、原生应用HTTP/SQLite、Windows/Bun共享实例及通用后端设置页验证。设置页支持查看后端、原生登录状态和只读历史，并可把原始Ref打开为主会话标签。主区域已有运行/队列观察及guide/withdraw/reorder；文本发送/草稿/生命周期更新已接入；队列编辑/恢复到输入框、直接调整、逐token内容、真实账号及正式激活尚未完成，没有宣称正式接入。A20–A22尚不记为完成。

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
2. **公共整套后端位置和只读浏览已落地，完整会话交互未接。** 核心ConversationBackend服务通过现有原生RPC发布有限的list/status/threads/history/execution/login/cancelLogin/create/query/control/send，并按backend ID＋native thread ID路由。普通OpenCode分支保持原Session/Inbox入口；Codex走完整后端，HTTP实测没有插入OpenCode Session或Inbox。原生插件session/provider hooks不足以承载整套后端，因此只补公共位置；不嵌套Agent、不新建外层宿主。Effect插件上下文提供可选experimental.conversation注册，但助手模式继续禁用任意SDK/配置插件，验证由受信任宿主通过公共服务注册。
3. **Windows/Bun共享生命周期已验证，真人认证和完整会话交互仍缺。** 实测两个独立Bun进程同时启动只连接到同一native PID；强杀一个客户端不停止服务；显式停止、重启及带未消费队列的竞争重连不重投旧输入或重复消费。普通stdio实际上允许多个进程打开同一home，因此nativeBackend现在拒绝注册stdio连接；不以进程内Set冒充跨进程锁。当前仍没有真实账户连接、生产线程迁移或UI人工提问转交。

因此package.json仍为实验性且publication=disabled。通用设置页可用，但默认后端清单为空，Codex没有注册到启动、默认模型或会话入口。这不是一次可供用户切换执行器的发布。

接纳键按稳定inputID全局唯一；更换目标、正文或调整目标turn不能复用原ID。accepted表示输入被接纳的事实，不表示任务此刻仍在排队、执行或已经完成；实时状态必须读原生后端。确认回执不会因队列消费或撤回而删除，避免旧输入重投。SQLite首写失败不调用后端，原生已接收但回执更新失败时不报告成功，后续只做核对。没有第二份待执行任务表、后台排空循环或消息历史副本。

## 文件能力边界

该切片只创建空的新 profile。配置摘要、目录归属和 CLI 版本在打开时检查，采用固定只读审批策略及禁用工具配置，不接纳任意原始 config、工作目录、MCP、动态工具或文件输入。密钥仅经受控 `IM_` 环境变量传入自身子进程；不复制旧 home，不记录原始 stderr 或密钥。

真实模型请求中只广告 request_user_input。测试服务强行返回未广告的 exec_command、apply_patch、view_image、MCP 文件读取和 spawn_agent 调用；原生 dispatcher 分别拒绝。自有 sentinel 未读出、未改写，补丁目标文件未生成。不能只凭隐藏工具名推断禁用成功。

所有服务端主动工具/审批请求当前一律返回“不提供该 host 能力”，不执行或自动批准。人工提问转交尚未接入，不能称交互闭环完整。以上是该版本、受控 profile 的能力验证，不是 OS 沙盒证明，也不代表用户既有 Codex 系统被去除了文件能力。新增工具、配置、登录来源或 CLI 升级都须重新验证后才能开放入口。

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

Codex列表按profile工作区过滤，读取时再次核对thread.cwd。thread/read(includeTurns=false)和thread/items/list(sortDirection=desc)读取后反转单页，取得最近页并向前分页；这两个原生操作不resume线程。实测服务重启后读取持久线程仍为notLoaded，不增加模型调用；另一个工作区的线程不展示且不能读取。未支持的非文本条目保留native ID和所在位置，显示未完整预览的活动记录，不冒充assistant文本。当前没有Markdown/附件/工具展示或实时增量接入。

只读弹窗和主区域复用同一ConversationBrowser历史读取器，不是独立会话宿主。主标签已保留整套后端Ref，并增加有限队列交互；原生文本编辑器已接入公共send。原生OpenCode Session页继续绑定自己的Session ID，不能为复用组件伪造Session或将Codex输入再插入Inbox。

## 原生运行和队列投影

Definition增加可选execution域，现有公共RPC增加execution，共11个固定方法。执行器直接返回原生thread状态、最新turn ID/结果、pending队列页和nextCursor；核心校验完整Ref，剔除未声明字段，不建立第二份运行或待办数据库。已接纳回执是历史事实，execution才是本次观察到的运行/待办情况；执行中的输入不作为pending展示。空pending页可以同时有running turn；nextCursor存在时不能把这一页的长度当作总队列长度。

Codex读取thread/read元数据、thread/turns/list(limit=1, itemsView=notLoaded)和thread/queue/list；不加载整段turn内容、不resume或生成。三次读取不是原子快照，latest turn也可能已完成，不能依据一次观察承诺仍可调整；send(delivery=steer)仍必须带原生expectedTurnID，由原生校验。编辑/排序/撤回继续走既有control，不从回执推导队列状态，也不增加排空循环。原生分页结果及游标不重排、不合并成宿主队列。

activity是通用失效通知，仅包含Ref和execution/history/both。Codex映射queue/status变化、turn开始/结束、item完成及标题变化，不把文本delta逐条变成重读。转发前读取元数据核对工作区；核对失败不泄露另一个工作区的事件。此异步核对可能令失效提示先后交错，因此事件不携带执行状态、不保证重放顺序；前端仅为当前可见数据合并重读。退订和旧注册释放后丢弃迟到事件；核心另外检查backend归属及注册实例，防止旧实例污染替代实例。没有新增轮询定时器。人工提问、流式文本增量及UI消费此事件仍未接通。

工作区校验也补到旧query/control/enqueue/reconcile：不能绕过history入口，拿同home另一工作区的thread ID续接、发送或压缩。验证拒绝这些操作并确认没有额外模型请求。API不提供任意native RPC或工作目录配置。

## 主会话标签承载

GUI SDK增加BackendView贡献位置和ctx.tabs.openBackend，ShellTab分别提供可选backend引用与原有SessionRef。主路由为/server/:serverKey/backend/:backendID/thread/:threadID，只接受原始Ref。无精确backendID匹配时使用第一个通用视图；没有视图就显示不可用，不转换为Session。贡献带插件上下文和错误隔离；Ref身份切换释放旧视图，异步历史响应不能写入另一线程。

TabStorage增加backend变体，只保存server、Ref和标题。标签新增与普通Session共用addConversationTab；排序、导航、最近标签、关闭/重开和持久化仍归原shell，不增加另一份标签或任务状态机。闭合记录与Session删除清理按类型/完整身份区分，不因为native ID与Session ID相同而删除另一类。后端离线、视图失效或读取失败均保留原Ref；关闭只是撤掉读取器。标签标题更新只是本地展示，不重命名native thread。

backends内置GUI插件提供通用、按需加载的只读主视图。从设置历史的Open as tab按钮打开；主区域不显示另一列线程选择器，仍保留原读者的分页、阅读锚点、错误和部分内容提示。路由加载有相同尺寸的原生容器占位，没有跨整个窗口的Suspense空白。没有新的发消息表单或队列副本，未把read-only UI当成发送能力。

## 主区域队列交互

ctx.ui.QueuePanel经UiQueueView复用Session原面板及拖动、进入/退出展示，不复制SessionQueue控制器。backends插件仅保留可见execution快照，经control调用guide/withdraw/reorder，再读取原生结果。打开视图只观察；不会从本地取任务、自动发下一项或伪造Session。读取串行合并失效，不轮询；server代际/Ref生命周期隔离异步回包。未知操作结果保留提示并阻止下一操作，需人工刷新核对，不自动重试。nextCursor存在时禁用排序；空pending与running独立。停放队列Send未接入、不展示；原位编辑/确认撤回后恢复由公共BackendComposer适配原生交互。

上一阶段新增两项生产浏览器用例验证原始身份的操作和迟到回包、不完整页/错误提示，并重跑原Session队列39项；该阶段为199项相关测试及10项HTTP。本轮又加入原生文本发送和生命周期历史更新，当前计数见下节。逐token内容和正式激活仍未交付。

## 原生文本发送与草稿

ctx.ui.BackendComposer复用ComposerEditor、createComposerEditor、原生草稿状态/持久化及createComposerSubmission，输入经插件的公共send回调传入原始Ref，不伪造Session或模型provider。Enter投递queue、Shift+Enter换行；无本地shell/命令/文件上下文/附件入口。草稿按server/backend/thread隔离，只保留一个待确认handoff；它没有自动执行/重投能力。发送时清原稿但保留快照，后续编辑不被旧回执抹掉。uncertain/网络失败需要用户明确核对，沿用原ID与正文，重开/刷新不自动send。视图切换不取消已派发接纳，迟到UI结果不串线。原生草稿存储故障或跨进程崩溃下不承诺exactly-once。

真实CLI确认notLoaded线程虽接受queue/add但不执行，明确新queue输入现在先原生resume再入队；仅发生在首次send的enqueue，不发生在浏览或reconcile。原只读场景增加真实恢复输入和native-reply-4断言，读取依然不增加模型请求。主界面在接纳后及原生完成活动后读取历史，旧消息阅读期间保留锚点并提示最新内容，不做逐token轮询。

当前237项相关测试（77原生＋160浏览器/组件）及10项HTTP通过，完整check通过；正式R3文件、桌面全链路/真人账号/权限验收仍缺。性能基准是既有输入的小样本，不是整应用性能完成证明。

## 控制回执与原轮次停止

control返回ControlResult：applied只表示后端确认操作，not-found表示待办目标已不在队列。Codex的withdraw根据deleted返回结果；不是从UI缺失猜测撤回成功。核心校验类型、剔除私有字段；异常/断线仍是未知，不能自动重试或恢复成待发送正文。HTTP和真实CLI检查第一次withdraw为applied，第二次为not-found，其他队列项未受影响。

Stop仅在原生thread/turn均running时提供，携带点击时的原始turn ID，底层拒绝过期ID而不是停止后来的turn。真实CLI证明旧turn ID停止请求被拒绝且原任务仍在运行，再以正确ID中断；浏览器覆盖慢回执期间轮次变化、未知结果/人工核对、成功回执不伪造空闲，以及同thread ID跨backend的迟到回包隔离。已派发控制不使用视图的AbortSignal，读取/订阅照常清理，旧UI结果丢弃。队列编辑/确认撤回后恢复已接入，尚未实现直接文本Steer，不以这些控制回执宣称完整交互完成。

## 队列编辑与确认撤回恢复

公共BackendComposer可接execution/busy/control，由宿主复用原生队列面板和编辑器；插件只持有观察及通用RPC回调。共用queue-draft.ts的捕获/模式→正文→retry恢复和追加规则，原Session仍保留其Inbox控制器。Codex编辑只update原native ID，不撤回再接纳。保存时若又打字，旧回执不清新编辑；已消费条目不变成新任务。编辑ID和stash随完整Ref草稿持久化，刷新/加载不自动发送。

撤回到输入框只接受明确applied；合并到等待期间的最新草稿，not-found不恢复。未知结果保留原文/编辑未确认状态供核对，不凭队列缺失恢复，不自动重试。取消编辑和Dismiss只管理本地草稿记录，不能声称回滚native操作。未完整显示的输入不能通过文本编辑/恢复丢掉附件。草稿沿用原生异步持久化，恢复测试等实际IndexedDB提交后刷新，不保证突然关闭前未提交数据或跨进程exactly-once。

两项生产keeper覆盖此交互，并重跑完整原Session队列/编辑器/标签和插件宿主。草稿恢复的故意reset变异被新keeper拒绝，恢复字节后重新完整验收；不是静态源码检查或仅挂假按钮。

## 真实验证

`python -m tools.codex_native_smoke`调用锁定工具链，执行模块类型检查、13个真实Codex场景、19个核心/RPC/KV单测、3个服务端权限/错误回归、42个原生标签/路由/持久化单测、129个生产构建设置/历史/完整标签/完整队列/原生编辑器浏览器回归、10项真实原生应用HTTP/SQLite检查及完整canonical check。所有模型调用在新建隔离profile、本地合成Responses服务中执行，没有真实上游账号或模型请求。原始模块场景包括：

- 原生队列自动启动、忙碌时编辑/排序/撤回、FIFO 和历史分页；额外确认重复 clientUserMessageId 并不去重。
- 进程退出后的 native pending/历史恢复，原生 ID 和只读账号结果保持，不补发已交付输入。
- 原生 expectedTurnId 防止过期调整，中断状态来自原生事件。
- 强制未开放工具调用在原生 dispatcher 被拒绝。
- 原生本地压缩后重启，下一次真实模型输入使用压缩上下文，不再带旧 assistant 回复。
- 非空 home 拒绝接管、同进程重复打开拒绝、配置篡改拒绝、文件输入和无效参数拒绝。

新增共享场景覆盖：断开一个客户端后原请求继续、独立进程同PID竞争与客户端崩溃、显式停止/恢复历史、持久待办重连后消费一次、策略或令牌不匹配拒绝、以及共享执行器中同样强制调用五类禁用工具。六项stdio用例只作隔离基线，不能作为产品入口；共享路径没有降低原文件工具边界。

HTTP验证现使用共享native profile，证明发送/调整共用接纳ID与turn前提、8份并发只产生一个队列项、丢失回执后查队列、消费后查历史、SQLite重启返回原回执、OpenCode Session/Inbox不重复接纳，以及native断开后真实RPC清单自动撤下。此HTTP样本4次合成模型请求，未调用真实账号。故障单测另覆盖中断后不盲目重发、SQLite回执更新失败不虚报成功、ID冲突及旧注册收尾不误删替代实例。

设置页原6个场景覆盖离线选择保留、离开页面停止订阅、无轮询、原生浏览器完成通知、按login ID取消、切换后端时的迟到快照、完成事件早于login回包、失败后不自动重试。另3项覆盖原生列表/历史分页、跨turn相同item ID、来源顺序、重复边界条目、阅读锚点、切换后的迟到历史、读取失败/重试/部分内容提示和关闭后的无额外读取。HTTP另证明真实CLI的账号投影/取消与读取不二次接纳、不增加模型请求。浏览器认证只使用合成夹具，不冒充真人认证通过。execution场景和核心通知归属/旧注册回归保留；HTTP实际验证空待办但仍在运行、待办分页和编辑/排序/撤回只作用同一原生队列，模型仍4次。前一轮50项浏览器回归包含完整标签keeper和原9项设置，新增主标签用例证明两个backend与普通Session共享同一ID时不串线、刷新恢复、关闭重开、离线不改绑且无发送/续接请求；31项插件宿主回归另重跑通过。性能基准前后各3次仅为小样本描述，不能宣称整个应用性能已验收。

证据只标partial_verified，不能代替正式R3整体验收；直接调整、逐token内容、真实账号和正式宿主激活未验收，正式tests/rebase/test_r3_01.py仍未实现。累计产品补丁152个文件，源码最终摘要与台账保存。未改变Protocol/HttpApi，使用现有通用RPC，不手改生成客户端。助手权限仍仅放行此RPC的11个固定方法；任意RPC、MCP、文件和shell入口继续禁用。单独typecheck:e2e仍有原14条诊断，不标通过；既有client全套计时失败仍留R5处理。

## 下一步实施边界

公共整套后端位置、Windows/Bun共享实例、设置/登录状态、主会话标签和文本发送已实现。下一步接直接调整及逐token内容交互，完善主会话列表的整套后端选择，再做正式宿主激活与真人账号验证；不直接读取或复制旧Codex凭据。保持OpenCode原Session/Inbox不变，不能在设置弹窗长出第二套会话运行层。使用createSharedProfile/loadProfile和nativeBackend，不能回退stdio或把KV首写当成执行锁。遵守窗口关闭只断连、明确停止才终止整实例的区分。设置页选择是检查对象；只有明确Open as tab才打开原始Ref，并不更换默认执行器。

前端可以复用原生展示与交互组件，但不能为复用而向 OpenCode Inbox 再插入 Codex 待执行消息。恢复/重复投递的接纳策略、同 profile 生命周期和 native UI 契约须真实验证，再添加正式 R3 运行验收并考虑开放。QQ 仍是可选转发层，不能解决这些公共框架缺口或成为执行入口所有者。

主标签及队列公共展示契约已补齐，原生编辑器已通过公共BackendComposer适配；不使用要求Session.prompt/ServerSDK的旧adapter。队列编辑/恢复已共用原生草稿暂存与恢复，接下来完善直接调整/实时内容，不能复制控制器、伪造Session或从插件导入app私有模块。原生线程输入经send，队列经control，运行/历史从execution/history读取；不因打开、切换、收到完成通知而自行调度下一条。原生编辑器已经接入，不能另加临时表单或本地可执行队列。
