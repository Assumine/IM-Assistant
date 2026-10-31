# Codex 原生会话后端切片

这是完整Codex App Server的适配器，不是OpenCode模型provider。线程、历史、队列、上下文、压缩和账号仍由Codex原生系统拥有，没有自己的任务库、执行循环或输入自动重放。已验证公共后端位置、HTTP调用及Windows/Bun下的跨进程共享实例；已有通用后端设置页、主会话标签和有限队列交互，当前publication=disabled，默认不注册或启动Codex。

支持原生创建/续接、历史分页、入站队列的查看/修改/排序/撤回、显式引导、带 turn ID 前提的调整、中断、压缩以及只读账号/模型查询。可选authentication域投影账号状态、启动原生浏览器登录及按login ID取消；凭据保存和刷新仍归native home。结果和通知保留原生 ID。发送仅接收文本，不接收文件路径、任意配置、原始 RPC、动态工具或用户指定工作目录。

公共后端使用`createSharedProfile`创建独立native home，后续经`loadProfile`读取；均不采用旧home。它生成固定的loopback端点和随机握手令牌，令牌不进URL、命令行正文或公开RPC。打开时核对配置摘要、CLI版本、native home及实际生效的禁用配置，再复用同一个原生服务。仅验证Windows、锁定Bun及codex-cli 0.166.0-alpha.5.1，不自动更新CLI。旧createProfile保留为stdio隔离验证；nativeBackend拒绝将它注册为产品后端。

共享连接的`close()`只断开客户端，不中断native任务或停止其他客户端。受信任宿主可显式调用`stopSharedService`，经鉴权及身份/策略核对后停止整个自有实例；这不在模型或GUI RPC中。没有PID文件锁、过期抢锁或第二个守护服务，排他依靠原生监听器的OS端口绑定。重连不重发输入，停止/重启也保留native历史和未消费队列。

从仓库根目录运行隔离验证：

```sh
python -m tools.codex_native_smoke
```

需要已安装的 Codex CLI 和仓库锁定的 Bun/TypeScript 工具链。测试使用本机合成 Responses 服务和新建临时 native home，不调用付费模型、不使用真实登录态、不接管旧进程。配置篡改及版本不匹配时拒绝打开，子进程退出或响应超时时返回结果未知，不盲目重发。

`nativeBackend(adapter)` 通过公共后端定义接入。原生应用的 `experimental.conversation` RPC负责注册、路由及原生KV接纳回执，发送和调整都经send，不经过OpenCode Inbox。8份并发HTTP输入只接纳一份；丢失回执时查原生队列/历史，重启后复用原回执。回执只存目标、请求摘要和native ID，不保存消息正文或调度任务。

可选execution域提供主交互需要的运行/队列投影：原生线程状态、最新turn ID/结果、按来源顺序的pending页和不透明游标。执行中的输入不混入待办，空页不代表没有执行中的turn，翻页结果不是总队列计数。读取不resume或生成，多个原生读取也不冒充原子快照；调整仍以原生expectedTurnID为最终校验。activity事件仅通知execution/history失效，不包含正文，不是可重放的任务日志；按原生生命周期事件触发，不按文本delta反复拉取。所有线程查询、续接、发送、回执核对及控制先核对profile工作区。

通用设置页由原生SettingsPage贡献位置加载，不按Codex业务ID硬编码。它检查连接及登录，并可打开只读原生会话浏览器，不改变会话归属、默认执行器或队列。浏览器按需读取列表和历史分页，保留native thread/turn/item ID及来源顺序；向前加载保留阅读位置，切换和关闭后丢弃迟到回包。Codex读取使用thread/read(includeTurns=false)和thread/items/list，不resume或生成；只能读取本profile工作区。当前仅展示文本，未支持的内容保留为未完整展示的活动记录，不伪造回复或读取文件。后端离线后保留原选择；状态只在页面激活、连接变化、后端事件和用户刷新时读取，不后台轮询。浏览器登录URL仅经显式按钮打开；远程页面不提供依赖本机回调的登录入口，取消只影响指定登录尝试。

已确认的限制：裸原生queue/add不按clientUserMessageId去重，必须使用公共send。未知交付且native也查不到时保留uncertain，不自动重发；这不是跨系统exactly-once保证。共享WebSocket在官方仍属实验性，人工提问、真人认证及正式宿主激活未完成；多用户ACL和其他OS未验收。只读浏览器不是原生主会话页的正式接入。设置页浏览器登录交互只用合成夹具验证，真实CLI仅验证无凭据账号状态和不存在登录ID的取消，不把它算真人登录验收。受控助手模式继续禁用任意SDK插件，不为此放宽通用插件加载或真实系统权限。

详细证据、发布门槛和下一步见 [Codex 原生接入边界](../../docs/handoff/Codex原生接入边界.md)。

GUI通过公共BackendView承载整套后端。原生标签存server＋原始Ref和标题，沿用shell的持久化/切换/排序/关闭/重开，不创建OpenCode Session或Inbox。从设置历史预览选择“Open as tab”进入主区域；它与预览共用同一只读历史读取器。主区域增加execution观察和显式guide/withdraw/reorder；经公共ctx.ui.QueuePanel复用Session原队列界面，插件不导入私有控制器。读取只在视图激活、连接/注册变化、匹配Ref的activity及手动刷新时触发，同一时刻最多一个execution读取，有新失效时读完再核对。

队列操作不乐观删除/挪动行、不在前端自动消费；响应之后仍读取native队列。失败视作结果未知，保留提示和禁用态，人工刷新核对后才允许下一操作，不自动重试控制。只展示第一页时禁用排序，不把不完整顺序写回；空队列不冒充空闲。guide仅在观察到running线程及running turn时显示；没有实现停放队列的Send，不渲染假按钮。原位编辑经原ID update；撤回到输入框只根据明确applied合并到最新草稿。主区域已接原生文本编辑、公共send、按完整Ref保留草稿和一个待确认输入；历史随原生生命周期快照更新，查看旧消息时不跳位置。发送/核对只能由用户明确触发；回执未知时保留原ID，不自动重投。活跃连接的逐段文本已接入，仍不把局部交互算作正式R3完成。后端不可用时保留引用并提示读取错误，不把它改绑到普通Session；关闭或重开标签不启动/停止/续接任务。

显式queue发送在notLoaded时先由原生resume恢复原线程，再调用原生queue/add；只读浏览和回执核对不resume。视图切换不取消已派发的接纳HTTP请求，迟到回包不更新另一视图。输入界面复用原生编辑器/草稿/提交捕获，非临时textarea；不开第二个Session/Inbox或执行循环。

公共control返回applied/not-found，撤回缺失不视作可以恢复正文；异常仍是结果未知，不自动重试。原生Stop只向观察到的running turn发送interrupt，旧turn ID在CLI侧拒绝，不误停新轮次。停止回执后仍读execution，不乐观标空闲。已派发控制不随导航取消，迟到UI结果不进入其他视图。

原生队列交互由公共BackendComposer承载，复用SessionQueuePanel和共用的原生草稿暂存/恢复；编辑身份和不确定撤回原文随草稿异步保存。已开始执行或unknown的消息不自动变成新任务，不盲目恢复/重试。刷新恢复验收以原生存储提交为前提，不保证进程崩溃时同步落盘。

直接引导走公共send并固定expectedTurnID；明确结构化拒绝保存rejected事实，未知错误仍不自动重试。content投影每轮核对工作区，以新streamID及UTF-16偏移发送快照/增量；只暂存活跃assistant文本，完成/退订即清理，最终历史仍归Codex。中途附着缺失起点时不编造前缀，保留完成历史对齐。所有服务端host提问/工具请求仍未接通，不自动批准。
