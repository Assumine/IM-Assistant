# QQ 可选转发入口：隔离接回中

`createPortal({ storage, session, backend?, policy })`处理结构化事件；新增`openQQChannel`通过认证OneBot通道转交它。普通会话调用原生Promise客户端的Session/Inbox接口，Codex整套后端调用同一应用的ConversationBackend公共RPC；不直接导入Codex模块。它不登录QQ、不监听网络端口、不轮询、不创建会话/任务库，不负责挑选或执行下一条任务。产品启动已装配这个可选入口，默认关闭；当前已支持控制回执自动发送，普通Session和提供原生输出归属的Codex首轮/最终公开回复也已接入，也没有使用旧账号、绑定或历史。

当前支持：

- 分离机器人、群/私聊、实际成员和消息ID；群必须同时满足允许群、允许成员和@任务机器人。其他机器人（包括小羊）、机器人自己及发出事件不进入任务链。
- 只消费明确支持的text/at/reply分段和受控image分段，保留正文空白和用户字面标记。图片须显式配置NapCat能力；普通文件、语音、视频和未支持表情仍整体拒绝，不丢附件后只转文字，也不解析字符串中的CQ代码。
- `/list`、`/codex list`及大小写形式先分类为控制请求，返回给控制分发层；不因会话忙碌而作为AI任务。默认只做分类；可信宿主显式提供controls后才执行已支持的控制命令。未实现命令返回unsupported，不作为AI任务。
- `bind`为可信宿主控制函数，目标显式分为`{ kind: "session", sessionID }`和`{ kind: "backend", ref: { backendID, threadID } }`。先只读核对Session或后端线程归属，再保存绑定；后端不可用不回退普通会话。新建但无首条消息的Codex线程只核对read，不为绑定读取尚不存在的执行记录或调用resume。它不承担远程身份认证；传输必须先验证机器人身份，命令仍须通过独立controls授权。旧字符串绑定和sessionID来源记录继续只读兼容，不自动改写。绑定变化不移动既有输入。
- 普通消息用稳定原生输入ID调用对应目标的公共接纳入口：Session.prompt(queue)或ConversationBackend.send。Codex不会产生影子Session/Inbox记录，也不由QQ维护原生连接。公共插件KV的原子insert只冻结来源/目标/摘要元数据，不保存正文、执行状态或模型上下文。
- 新来源记录包含不可变的原QQ信封（机器人、群/私聊、接收范围、发送成员、起始消息ID），并按完整Target＋原生inputID保存反查索引。`sourceFor(target, inputID)`仅在双向元数据一致、现行权限允许且原生接纳已确认时返回原始来源；不读当前绑定、不枚举会话、不轮询执行、不发送消息。重启、取消绑定、重新绑定和待办补充均不会更换任务起始引用。整套后端同样可反查，不需要影子Session。
- 原生接纳回执不表示正在运行或已完成。来源反查也不是完成通知；后续发送端仍须核对原生输出/完成事实，并在实际发送时重新检查权限。查不到来源或通知发送未知时不能重跑AI任务。
- 来源与索引是公共插件KV的两个不可变键，不声称跨键事务。两者写完并核对后才允许首次原生提交；中间写入失败不得报已接纳，重投只允许从已冻结信封补齐索引并核对原生事实，不重发正文。旧记录缺信封/索引时返回missing，不从当前QQ事件、回复别名或Session metadata猜造历史收件人。损坏或冲突保留uncertain/报错，不能覆盖；权限收回后返回forbidden，且不再查原生执行器。
- 重复消息查原生pending或已交付user记录；内容冲突拒绝。首次交付结果未知且无原生证据时保留uncertain，不重新发送。重新绑定和重启后仍查原目标，不误投当前会话。
- 整套后端的重复消息只调用ConversationBackend.reconcile，不再次调用send。这个RPC不创建接纳事实、不调用enqueue/resume，已缓存的历史接纳或确定拒绝可以离线核对；未决结果仅查原生reconcile，证实后可以补记回执缓存。没有接纳记录仍是uncertain；中途替换的后端连接不能确认旧查询。它不代表任务仍在运行，待办状态另查原生execution。
- 引用普通Session的待执行用户输入时，调用原生`inbox.append`追加补充，不取消/重建队列。新消息的稳定ID作为amendmentID，来源仍指向原任务；追加正文和只含目标ID/正文摘要的去重回执由原生事件事务一起提交。任务若恰好已被消费则冲突，不改投下一项；同一补充的重复/失回执只用`inbox.amendment`核对，重绑与重启不移动目标。首次追加失败且无回执时保留uncertain，不重试写入。撤回补充不会取消原任务，也不自动回退已经追加的正文。
- 引用普通Session当前已交付的输入时，通过`session.input.continue`提交有归属护栏的原生steer。原生Inbox在交付queue用户输入时打开边界，普通steer属于同一边界；引用可以指向该边界内较早的用户输入，不按最近一条消息猜测。录入和消费在原生事务内校验同一归属，并核对所引用户及根输入仍存在于原生历史；旧索引不能复活被回退的历史。QQ不使用忙碌状态作近似判断，也不调用无条件steer或interrupt。
- 新来源记录的continuationID是补充消息的稳定ID，inputID仍指向原任务，与待办amendmentID互斥。重复、失回执、重绑及重启只调用`session.input.continuation`核对。返回steered的delivery=pending表示接纳后等待安全节点，delivered表示已进入原生历史，不代表模型执行完成或实际修改已经成功。任务停止、失败或结束时，未消费的续接变为expired，不进入下一条任务；正常应用关闭保留原生意图，启动时由原生恢复消费一次。取消待消费续接为cancelled，回执均保留为历史事实。
- 原生pending用户数据带服务器赋值的continuationOf标记，普通prompt不能伪造此护栏。客户端沿用原生缓存和事件；终止时移除作废占位，较旧的Inbox响应不能把它复活，也不能删除较新任务的已知事件。界面不提供将护栏续接移到后续队列的操作，仍允许原生删除；服务端同样拒绝跨任务移动。没有新消息队列、轮询器或模型循环。
- 整套后端引用当前输入时，先经公共`ConversationBackend.input`读取原生inputID对应的实际用户记录和turnID；该只读观察不取代接纳回执，不写KV、不resume、不创建输入，也不声称轮次仍活动。QQ将expectedTurnID与本条continuationID一起冻结，再通过原公共send(steer)交给Codex原生轮次校验。原任务恰好结束或已进入下一轮时明确拒绝，不回退为queue。重复和重启只reconcile，不重新读取当前轮次来更换护栏。
- Codex的steered delivery=accepted仅确认原生接纳，不等于已进入模型上下文或实际修改成功；失回执修复为原生message时，还需用input接口核对同一nativeID和冻结turnID，才能返回delivered。引用补充的回复仍归原任务；撤回补充不撤销父任务。历史缓存的queued回执不能用来判断输入是否仍待办。原生队列只提供整条update，当前没有安全的原子追加/CAS接口，故Codex待办引用仍blocked，不做读后覆盖。
- 撤回只调用原生Inbox.cancel或后端withdraw，不调用interrupt或发送“停止修改”。后端按原生队列分页查inputID，使用匹配的nativeID撤回；分页异常、竞争或故障不伪报成功。撤回先到时保存同来源/作者墓碑；已交付输入保持不变。
- `linkReply(source, outgoingMessageID)`仅在外发实际收到消息ID后由可信宿主调用。它先核对完整原始来源、当前权限与原生接纳/追加回执，再将AI回复/回执关联到原始输入；不能用别名冒充原始消息，非法ID和冲突不可覆盖。`sourceFor`返回的Source可直接用于首轮/最终引用别名，原始Source不变。控制回执已使用可信宿主的结构化发送原语；原生输入已证明归属的AI首轮/最终已通过同一别名接口接入。协议联调使用本地测试端返回的ID，其余单元测试使用合成ID。不制造实际QQ发送成功或自动通知。
- 回复别名用于定位引用所属任务，不能视为原始用户输入。撤回前会比对来源消息计算的稳定inputID，撤回机器人回执/回复不会取消原任务；旧别名同样适用，不靠补写角色标记猜测。
- 跨会话引用返回`confirmation-required`、稳定confirmationID、原目标及duplicate标志。同一消息并发只建立一份提案，只有首次duplicate=false，后续传输应据此去重确认提示。提案只保存不可变来源、原绑定/目标、父输入ID和内容摘要，不存正文或等待执行任务。重绑或取消绑定后仍提示同一目标，不悄悄换目标。
- `confirm(originalRaw, { confirmationID, scope, actorID, choice })`为可信宿主控制API，必须由认证传输在用户明确同意或取消后调用；不能把普通AI工具或消息正文直接映射到它。需获取原消息并核对完整摘要，确认者必须为原成员、原范围，当前权限再次检查。产品交互仅在认证传输核对实际确认提示别名后调用，不将任意正文或模型输出视为人工同意。原消息不可读时不得从摘要重构或猜测正文。choice原子首写且持久，取消后不自动改同意。确认不会修改binding，已批准输入仍通过原发送/append/guarded steer路径去重和核对；确认成功不等于原生任务接纳成功。撤回待确认原消息后不能再确认。
- 确认状态不是模型/执行状态，也不创建第二套调度器。失回执、未知交付和重启重复确认仍只核对原生回执，不重复提交。产品已接引用式确认提示、指令及结果发送，并经本机协议端验证；任务外发仍需对应输入的来源与原生完成事实，不能因一次跨会话确认订阅整条会话的所有通知。
- 同意记录也不是接纳事实。若同意后中断且该消息尚无origin，收到同一原始消息时可沿来源原子首写路径完成一次移交；一旦origin存在，结果不明就只核对，不能根据“已经同意”重发。没有缓存正文并后台执行的路径。
- 普通Session的`input.position`只读原生pending、open、closed或unknown。closed来自原生输入关闭/终止事务的结束证据，还须原用户和根输入仍在历史中；不代表执行成功。shutdown保留open意图，不当作结束；旧记录缺结束证据或历史被回退移除时保持unknown，不猜测迁移。
- 引用已证明closed的普通输入时，用新消息的稳定ID调用`input.followup`，在原InboxEnqueued事务内重新核对父输入和expectedRootID，创建新的queue输入。新任务的inputID、起始消息和反查索引独立，followupOf保存父输入/根关系，不覆盖旧任务；正文不加索引提示。最终用户记录保留inputRelation元数据，权威依据仍是原生回执，不能拿普通消息可填写的metadata当接纳证据。
- 关联后续初次入队保留原生顺序，不打断正在执行的其他输入；后续编辑、引导、排序和撤回仍由原生机制处理。重复/失回执/重绑/重启只用`input.followupReceipt`，不再入队或wake；cancelled不能普通prompt换壳复活。读取与录入之间父记录被移除、root改变或有撤销预览时明确冲突，不回退新任务。撤回仍在排队的关联后续只撤回新输入，旧任务保持原样。关联不意味着复制或还原已被压缩的旧上下文。

目前支持普通Session待办追加、当前输入护栏续接和已结束输入的关联后续，整套后端当前输入的原生期望轮次续接与已结束输入的关联后续，以及可信控制层的跨会话确认。Codex待办追加仍blocked；确认不解除该限制。旧适配器缺少原生护栏、输入归属或结束证据时，不降级为无条件steer或普通新任务。原生历史不可读或身份不明时返回uncertain，不按错误文字推断任务已结束。后端ID和线程ID共同决定目标，不能因线程ID相同就视为同一会话。未知引用作为普通新输入时明确返回unresolved。受控图片输入已接通，普通文件及排队提示撤回仍待后续实现；已显式配置的NapCat通道支持登录时按断点补收历史；已登记任务可在启动或原生事件时只读核对补发最终通知；小羊的现有聊天规则不由此模块接管。

Codex历史关联后续经公共send的followupOf提交，父关系包含原inputID、native用户item ID和所属turn ID。新任务来源独立，跨会话确认保持原绑定；首次接纳前由native插件复查确切父轮次终态，再进入原生队列。重复/失回执/重启只reconcile，并核对原回执的同一父关系；缺失或错误的父关系返回uncertain，不能把普通接纳冒充关联成功。返回delivery=accepted只证明历史接纳，不宣称当前pending或running；撤回只影响仍排队的子输入。

锁定CLI缺少原子父条件，历史核对与queue/add之间可能被外部并发回退；这里只保证基于已观察终态的新独立输入，不宣称跨系统原子关联，也不设置native rootTurnId。普通Session的事务内父核对仍按原接口保留。未知历史/旧facade不能推断为closed，不能以409、busy或idle猜测结束。

## 跨会话确认交互

产品层的createConfirmationChannel围绕原portal装配，不更换路由器或执行器。引用属于其他会话时，确认提示引用原需求并显示目标名称；用户引用这条实际已确认发送的提示，回复/confirm或/cancel，也支持/codex前缀和大小写。没有“最近提示”指针；不同成员、群、私聊和机器人不能代选。确认自己的需求使用任务白名单，不附带绑定/撤回等管理权限；群仍须@。

确认时按原消息ID调用认证OneBot的get_msg，只接受匹配消息ID、发送成员、类型和结构化消息段；平台若提供群号也须匹配。标准get_msg不要求返回群号，因此接收范围来自已经保存的原信封，随后仍由原confirm接口核对全部正文/引用/@摘要。无法读取、内容变化、附件不支持或已撤回时不猜测执行。参见[OneBot 11公开接口](https://github.com/botuniverse/onebot-11/blob/master/api/public.md#get_msg-获取消息)。

同意与取消沿用原不可变选择；确认不会更改当前绑定，实际补充/关联后续仍交给原生输入接口。指令只在首次不可变ingress时可应用；重复投递只核对通知，不读到新内容后突然执行曾失败的旧确认。提示、指令回执复用delivery首写/发送回执；未知发送不重试，确认提示别名只在收到真实ACK后发布，发布失败只能补元数据。KV不保存原正文、会话标题、模型上下文或执行队列。

## 显式控制入口

可信宿主可传入controls: { allowedUsers, backendIDs? }。控制授权独立于任务白名单，仍须先通过机器人、群/私聊、成员和群@规则。后台后端ID由宿主明确授权；用户文本不能授予权限。没有controls时保持原分类结果，不自动开启远程控制。

当前支持帮助（codex或/codex）、/list、/bind session <id>（或原/bind <sessionID>）、/bind backend <backendID> <threadID>、/unbind、/queue、/status及/unqueue <inputID>。/unqueue无参数时可引用当前绑定下的原任务消息；引用补充消息或其他会话会拒绝。命令仍兼容/codex前缀和大小写，参数ID保留大小写。序号选择需引用已确认发布的清单；未引用时不猜“最近清单”。/queue正文、/stop、模型/账号/权限等其余命令尚未接入，不用位置猜目标，也不降级成AI输入。裸词LIST/Status仍按原分类视为普通文本。

list与queue展示公共原生接口的一页观察，保留incomplete；不伪造总量。可选后端离线仅标记该后端unavailable，不阻断普通会话目录。普通Session缺可证明的当前执行状态时不猜running/idle；Codex线程无历史导致执行读取失败时，返回unavailable及仍有效的目标，不冒充空队列。list/queue的同一原消息重复交付保留首份编号映射，只投影当前仍观察到的行标签；缺失行保留序号、空标签并标observed=false，不推断已删除/完成。改绑后不把另一会话的正文或状态拼入旧清单。status仍读取新观察，不建立序号清单；没有列表/队列正文缓存或后台轮询。

所有新消息共用插件KV内不可变的ingress指纹/输入种类；同一消息不能在AI输入和控制命令之间重解释。写命令只允许首次ingress创建不可变control意图，固定完整目标和输入ID，再调用原公共bind或原生withdraw。重复、重绑、应用重启只读已有历史回执；曾分类未执行、被拒绝或在意图写入前中断的旧写命令不会因日后启用功能/增加权限自动执行。

写意图与操作回执仍是原插件KV的路由元数据，不保存正文、模型上下文或可执行任务。记录/通知失败不伪报成功，失回执保留uncertain，不重试副作用；历史bound/unbound回执不代表此刻绑定。unqueue固定原输入，不按变化后的序号删除、不interrupt；withdraw-requested只证明已向原生接口发出撤回并收到响应，不保证竞争中输入一定未被消费，尤其Session cancel无条件回执不能当作取消成功证据。

认证传输和应用级资源装配已通过本地协议端及真实产品入口验证；控制回执外发已接持久发送意图和回执；未引用清单的序号快选及其余命令仍待实现。清单回复的可信别名接口已隔离验证。控制结果不作为AI回复，不替代原生执行器；无第二套调度器、任务库或持久化正文。

## 稳定的清单序号

list/queue返回viewID与从1开始的index。快照仅在原插件KV保存来源、完整目标、按原顺序的输入/native ID和分页标记，不保存标题、正文或执行状态；既不是任务库，也不驱动原生队列。viewID含来源和映射内容摘要，修改目标、顺序、地址或来源会导致核对失败。

可信传输必须在实际清单回复发送成功、拿到QQ消息ID后调用linkControlView(source, viewID, outgoingMessageID)。接口核对原控制来源、当前授权、完整清单和实际出站ID，原子首写原命令与回复别名，最后写发布事实；多键不是跨键事务，中途失败没有发布事实就不能选择。对已确认发送的同一消息重调可修复元数据，不发消息、不恢复任务、不执行旧选择。

用户引用已发布清单的回复或原命令，再发送/bind 1或/unqueue 2。可以在同群显式引用另一授权成员共享的清单；不能跨群/私聊/机器人取清单。类型不符、越界、未发布或缺引用时拒绝；没有可变的“最近清单”指针。目录选择保留backendID与threadID整体；执行绑定仍经原生归属核验。队列选择要求仍绑定同一完整目标，改绑后不隐式操作另一会话。

数字撤回同时冻结inputID和nativeID，Codex直接撤回原生submission ID；同一client ID后来出现新submission也不能重映射到它。普通Session沿原cancel语义，只确认撤回请求响应，不保证竞争中任务未消费。重复、重绑、重启和丢回执仍只读原控制回执，不再选一次序号。未发布/被拒绝的旧写命令不会在发布后自动生效，需要新的用户消息。

别名是控制清单的显示引用，不冒充AI任务来源；控制发布接口不发送QQ消息。产品控制回执发送端已接入，普通Session及提供原生归属证明的整套后端输出均已连接；本地OneBot夹具可以返回发送ID并发布映射，其余用例使用明确的合成ID，均不能记为实际QQ交付验收。

## 可选认证通道与生命周期

`openQQChannel({ portal, policy, connection, onResult, onIssue?, onState? })`由可信调用方显式创建。connection仅接受OneBot-11正向通用WebSocket根路径：远端wss或本机ws，必须使用Authorization Bearer头；不接受URL凭据、查询token或无认证降级。锁定Bun客户端的重定向拒绝行为有独立验证。连接先核对get_login_info的机器人ID，再检查get_status的online/good；验证前事件不进入portal。协议依据为[官方认证规则](https://github.com/botuniverse/onebot-11/blob/master/communication/authorization.md)、[WebSocket通信](https://github.com/botuniverse/onebot-11/blob/master/communication/ws.md)和[公共API](https://github.com/botuniverse/onebot-11/blob/master/api/public.md)。

它不是新的ConversationBackend，也不在按Location调用的Plugin.setup内建立连接。产品层现在通过通用ApplicationModule在原应用Scope拥有此资源，在释放公共Session/Storage客户端之前await channel.close()。ServerProcess和ServerFetch均已接入，初始化/清理失败隔离，关闭后公共客户端与存储不可再调用；仍不代表任意SDK app.close自动管理外部资源，也不提供跨进程单实例锁。真实SDK的显式Scope夹具继续保留。close发起socket关闭并隔离晚到事件，不承诺等待底层OS关闭确认。

同机器人/群或私聊范围只排序入口接纳，让bind与紧随的输入按到达顺序交给portal；不同范围不互相等待。它不消费原生执行队列，不等待AI完成。onResult可完成短暂的接纳/通知处理，不能等待模型结束。原生接纳未知或处理异常时只阻塞并报告该范围；其他范围继续。阻塞状态只属于当前资源，重新创建通道前需由所有者核对未知结果，不能靠重连猜测恢复。

入口仅有默认128、最大512条的有界内存等待，不保存正文或离线任务队列，也不把它当作已接收成功。过载关闭通道并报告；关闭时未开始的输入丢弃并报告，已开始的接纳等待结算，不interrupt/cancel/resume原生任务。自动重连、定时状态轮询、登录和未知操作自动重投仍未启用；登录历史补收仅在显式history配置与已记录断点下运行。ready只确认首次验证结果；后续状态由state/onState读取。

channel.send(source, text)仅是可信宿主原语：重新检查机器人/成员/范围白名单，以reply＋text分段发出，不解释字面CQ码。并发API用echo关联，只有确认ok且返回有效message_id才是sent；失败为rejected，超时/断线/异步或缺ID为uncertain，未提交为unavailable。未知发送不自动重试；拿到确认ID后才可调用linkReply/linkControlView。控制回执已在其上记录持久通知身份并只读核对已有回执；平台侧未知结果恢复与提示撤回仍未实现，没有后台通知执行循环。

## 登录历史补收

每账号可显式设置`history: { provider: "napcat", pageSize: 100, maxPages: 10 }`；缺省关闭，不能把所有OneBot实现当作兼容历史源。pageSize为2–100、maxPages为1–20，乘积最多1000，最多4个并发历史读取。协议依据是[NapCat好友历史](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/action/go-cqhttp/GetFriendMsgHistory.ts)、[群历史](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/action/go-cqhttp/GetGroupMsgHistory.ts)和[消息投影](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/api/msg.ts)；检查过的文件blob摘要在qq-checkpoint中。没有登录旧账号或读取真实历史。

第一次仅用有效实时观测建立断点，不扫更早旧聊天。连接验证online后读取已保存且仍有权限的QQ范围，按real_seq的大整数序号排序；message_id和message_seq只作不透明分页锚点，不能按它们大小排序。完整分页找到原消息ID/序号/时间边界后才移交；缺口、重复页、混入其他范围或超限时报告history-unavailable，不能先执行最新一页。实时序号跳跃不推进未经证明的断点，首次迟到的实时消息仍可正常接纳。

只复用原portal和Session/Inbox或整套后端接纳。同一范围补收完再放行缓冲的新消息；其他范围独立继续。补收页包含刚到的实时消息时保留实时正文与身份，不误标历史或再次提交。补收等待期间的撤回通过原portal先记入原生撤回事实，只取消还在排队的对应输入，不interrupt前一任务。先前未绑定的拒收由原portal保存不可变接纳回执，改绑不会使旧消息复活；旧观测缺接纳/提案/拒收证据时报告未知，不猜新的目标。

历史任务附原发送/补收时间注记，提醒按原时间解释相对日期、过期或不明意图先判断询问；结构化metadata及跨会话提案也保留这两个时间，不加消息索引协议，原用户指纹不变。断点只在原生交接与持久结果订阅成功后提交；订阅确认不等待AI完成或通知读取。回调/存储失败不推进断点，重启靠原输入ID核对，不再执行模型。KV只保存每范围断点、来源和回执，不保存历史正文、第二份模型上下文或离线执行队列。

`onRecovery`与channel.state提供补收状态/观测条数；这不是新增或完成任务数。只有启动/显式重建已验证通道时查询，不后台轮询，不自动重连；图片按下述显式能力接纳，其他未支持附件仍整体拒绝并报告，不能丢附件后转发部分文字。

## 原生会话与整套后端的公开回复

核心在原生Step.Started投影中为Assistant记录inputRootID，不新增持久事件，也不改变Session/Inbox/压缩所有权。实验性只读接口experimental.session.input.output按真实输入边界读取首条和末条公开文字，沿用原History的分页、parts和blob读取；旧步骤缺归属时不按最近用户猜测。未结束的响应体、推理、工具参数/输出及压缩内容不转发；root关闭只说明输入边界已结束，不冒充任务成功。

openTaskReplies订阅原公开事件，先等当前OneBot身份验证，再读取来源和输出。实际收件人和引用始终来自原任务起始信封；引导、下一任务开始和改绑都不改变它。只选首轮与最终；二者是同一原生消息时共用一次发送意图，避免双发；晚恢复只发最终，不补发过时首轮。已确认ID才登记原linkReply别名，引用该真实AI回复仍能找到原任务。

任务与控制共用delivery.ts的回执边界。原插件KV只保存来源/目标、root、原生消息ID、阶段选择、正文hash和发送结果，不存模型正文或执行状态。被动订阅只含目标及输入ID，在启动/原生事件时只读核对，确认最终且别名登记完成后移除；没有轮询、第二执行队列或补跑AI。未知发送只读核对；已确认但别名发布失败仅修复元数据。关闭先停入口/发送并结算观察，再释放公共客户端及KV。

普通Session及提供原生output证明的整套后端均支持。Codex按确切input/root/turn读取公开agentMessage；未结束文字不转发，推理和工具不转发。failed/interrupted或完成但无公开文字时，发送一次明确终态提示，通知身份含实际turnID及terminal类型，不伪造AI消息ID。旧Session订阅和发送意图格式不变。传输自动重连及普通Session无完整文字时的失败通知仍未接。不能将隔离测试写成真实账号已交付。

## 产品配置与运行边界

本机产品CLI提供`portal qq init|enable|disable|status`。初始化只创建本产品根目录`modules/qq-portal/channels.json`，默认关闭、无账号，不接管旧设置；重复init拒绝覆盖。enable/disable只影响下次服务启动，不打断现有原生任务。status显示配置的期望状态、账号数量、connectionVerified=false、controlRepliesSupported=true、automaticTaskReplies=true和taskReplyTargets=["session","backend"]；这些是能力范围，不冒充在线状态。当前真实连接状态仅来自通道onState/服务日志，运行状态页面和单账号管理界面仍待接入。

配置为`{ version: 1, enabled: false, accounts: [...] }`。每项仅允许url、tokenEnv、policy及可选controls；policy含botID、allowedUsers、allowedGroups，controls用户须是任务白名单的子集。最多8账号，机器人ID和tokenEnv不得重复，文件须为普通文件且不超过512KiB。配置不能指定插件路径、代码、明文令牌或URL查询凭据。令牌以专用`IM_QQ_TOKEN_...`环境变量引用；装配启用账号时读入内存并从当前进程环境移除，防止后续子进程继承。禁用配置不消费令牌变量，不连接网络。

产品Portals只装配已知qq-portal包；框架ApplicationModules不知道QQ规则。资源使用同一原生公共客户端和按模块ID隔离的原插件KV；通过原HTTP策略进入Session/Inbox或整套后端，不直接读核心表或Codex私有文件。open同步交回资源，认证与登录不延迟核心启动。每账号独立通道，一项认证失败不挡另一项；配置损坏时QQ不可用，核心仍启动。正常关闭先停入口并结算已开始接纳，再释放客户端/SQLite。模块工厂若在交回资源前失败，必须自行清理已获取的私有资源。

当前支持控制回执自动发送，普通Session首轮/最终公开输出已接入；Codex首轮/最终公开输出及终态提示也已接入；仍未实现平台侧未知发送恢复、运行状态UI或跨进程单实例租约。未实测新QQ设置的第二Windows用户权限与真实账号，不启用生产账号；不要把可写配置或显式enable当作生产交付验收。

## 控制回执与未知结果

createControlReplies只处理可信入口给出的控制响应，核对已解码消息、命令ID/动作和原不可变ingress指纹；发送时再次检查机器人、群/私聊、实际成员和权限。任务授权不能伪造管理内容；群仍需@。控制回执始终引用原命令，既不作为AI任务来源，也不创建会话执行器。

原插件KV原子首写通知意图后，才允许一次wire尝试。意图只含来源、动作、原消息指纹、正文摘要及可选viewID，不存正文、模型上下文或执行状态。另一个不可变键保存与意图hash一致的发送结果。收到ok且有效数字message_id才确认sent；数据库写入未知只读回执，网络未知/异步、拒绝或未提交均不自动重试。已有回执但意图记录缺失时同样保留未知，不能当新通知发送。重启或重复投递只能核对通知，不能重跑命令或AI任务。inspect是只读操作，不发消息、发布清单或调用执行器。

只有确认消息ID后才调用原linkControlView。发布失败保留sent但标为unlinked；重复可用原确认ID修复元数据，不重发内容或改用新的清单。已发送内容不会随重复读取的新标签改变；需要新观察时发送一条新的/list或/queue。过长清单发有限提示并不发布序号，不能隐藏部分行后仍开放全部映射。状态文案保留未知/分页事实，撤回回执只说明请求响应，不谎报竞争中的取消成功。

关闭时在途发送先归为未知，记录通知结果后才释放原生KV/客户端；重启后仍不盲发。这里没有平台侧结果恢复或通用通知补发器；仅凭正文相似、当前绑定或“没有回执”无法证明未发送，须保留待核对。排队提示撤回仍属于后续工作。已登记任务的最终通知可以在重启或原生后端重新注册时核对；这不恢复任务或重发未知发送；登录历史补收是独立的上游历史读取与原生接纳链。

验证：

```sh
python -m tools.qq_portal_smoke
```

226项QQ规则/协议/通知/图片用例＋8项SDK＋96项原生Session＋290项执行/Runner/压缩＋10项客户端竞争＋20项后端契约＋7项原生身份＋20项服务生命周期＝677项，零失败零跳过；135项链路检查通过。图片夹具额外覆盖真实Session/SQLite及锁定Codex服务的8项链路检查：文字与图片同一输入、撤回、读取失败回执、队列编辑保护、图片原生传递、当前轮次补充、已结束任务续接和重启不重投。6次合成模型请求、6次图片读取、2次回环连接，无真实QQ或生产凭据。

13项图片规则重复10次共130次通过，8项真实链路重复3次共24项通过，单独作为稳定性证据，不叠加主计数。另跑Codex原生模块30项通过，其中7项与677项重叠，不能简单相加。canonical check 36工作区及16个改动TS文件lint通过。公共整套后端输入新增可选inline图片契约，已运行锁定客户端生成器，生成文件无需改动；没有修改前端，不重复无关浏览器检查。旧完整R3-01证据仍固定在825f05f/5705a69，旧历史补收稳定性和失败复现证据固定在1b6566f。原14条E2E类型诊断及R5附件草稿恢复问题未解决。

框架的新增点是通用原生Inbox追加及输入归属护栏、POST continue/GET continuation接口和可重放的输入关闭事件；HTTP客户端由锁定生成器同步更新。归属及去重元数据在核心原KV内投影，不是QQ任务状态或第二份会话正文。Solid数据层只复用原生pending缓存、读期间的事件合并和串行重校验，不另存一套消息状态或手工改队列顺序。待办append保留原ID/序位/附件/metadata/投递方式；当前续接使用新的原生steer输入，归属固定于原输入边界。运行、恢复、上下文和队列仍由原生执行器拥有。

助手模式继续禁止普通SDK插件、实例插件、配置目录扫描和任意路径加载。新增的SDK `trustedPlugins`只由可信程序代码显式贡献，通过原生插件生命周期加载；不能放在用户消息、模型工具或项目JSON中。公共storage.insert按插件命名空间原子首写，Promise和Effect接口一致。不要在每个会话实例的setup里重复登录同一个机器人；正式产品的传输资源生命周期已接入，SDK显式Scope验证仍保留；具备原生输出证明的整套后端已接任务自动出站；运行状态UI仍未实现。

`upstream/qq-checkpoint.json`仅记录partial_verified，publication=disabled。正式`tests/rebase/test_r3_02.py`尚未实现，A23–A26不计完成；本阶段不代表真实机器人已连接或可发布。

## 受控图片输入

账号的 `images: { "provider": "napcat", "maxBytes": 20971520 }` 为显式能力；省略即关闭。还须由部署者在NapCat开启返回图片base64的 `enableLocalFile2Url`，助手不会改上游设置。每条最多4张、合计20 MiB，可把maxBytes调小；最多2个消息同时取图，不新增后台轮询。

只接受结构化image段中32位内容摘要加图片扩展名的received file标识；经当前账号白名单、群号及@规则校验后，通过认证OneBot的get_image读取base64。检查字节数、规范编码、原图片摘要和PNG/JPEG/GIF/WebP/BMP签名。平台返回的路径、URL及用户文字中的CQ码均不打开。缺字节、校验失败或能力关闭时拒绝整条消息，原始拒收事实及单次引用回执防止重送时改绑复活或反复下载。

普通Session将data URI交给已有prompt附件接口，由原生SQLite/blob、Inbox和Runner保存及执行。整套后端通过通用可选images能力接收inline数据；Codex转换为原生image输入，支持纯图片、排队、期望轮次内补充和终结后续接，仍没有影子Session。重复正文不再获取附件，QQ KV只留摘要/身份/回执。普通Session引用补充接口仍只支持文本，因此含图补充会明确拒绝并提示；不能去掉图片后只追加文字。原生Codex未完整预览的带图队列禁止文字替换，撤回仍沿原生队列。Codex附件历史缩略图和前端图片入口属于未完成UI范围。
