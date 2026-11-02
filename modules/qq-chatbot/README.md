# QQ 聊天附属插件

独立ApplicationModule、原生会话、人格指令和成员归属由Q1-02接入；Q1-03增加认证QQ通道、独立参与策略、回复开关、结构化@及受控图片。Q1-04通过产品Capabilities.load、CLI和原生模块设置接入实际装配，默认关闭，可独立于任务转发运行。没有导入旧小羊人格、私人历史或真实账号，也没有切换生产启动入口。

## 产品配置

模块文件位于助手独立数据根目录的modules/qq-chatbot/channels.json，与任务转发分开。模块管理中的Configure按钮通过原生公共能力RPC读取和保存真实配置；关闭或故障的服务也可读取合法配置。保存核对revision并原子替换，并发编辑冲突会拒绝覆盖。格式错误或含原始凭据的文件不会直接展示。配置单独保存为下次启动期望状态，不把保存成功当作当前已上线。

开发入口与工具链见[助手入口](../../docs/handoff/助手入口与隔离.md)。从本仓库根目录使用已锁定的Bun：

```text
.\runtime\tools\bun-1.4.4\bun-windows-x64-baseline\bun.exe --cwd opencode/packages/im-assistant run cli chat qq init
.\runtime\tools\bun-1.4.4\bun-windows-x64-baseline\bun.exe --cwd opencode/packages/im-assistant run cli chat qq configure C:/absolute/channels.json
.\runtime\tools\bun-1.4.4\bun-windows-x64-baseline\bun.exe --cwd opencode/packages/im-assistant run cli chat qq status
```

CLI还提供enable/disable [botID]、status [botID]与reset <botID>；修改均在下次服务启动生效。空或未知账号不会退回成全局操作。模块管理里的Stop service只停止本次资源，保留配置、原生会话与已交给原生的工作。

首次配置示例使用合成账号和占位模型，保持关闭：

```json
{
  "version": 1,
  "enabled": false,
  "accounts": [{
    "enabled": true,
    "botID": "10002",
    "url": "ws://127.0.0.1:3001/",
    "tokenEnv": "IM_QQ_CHAT_TOKEN_SHEEP",
    "model": { "providerID": "your-provider", "id": "your-model", "variant": "default" },
    "persona": { "name": "Sheep", "prompt": "Replace with the explicitly selected persona." },
    "contextGeneration": 0,
    "policy": { "privateUsers": ["20001"], "groups": ["30001"], "groupReplies": "auto", "repliesEnabled": true }
  }]
}
```

模型/API使用原生Provider设置和模型目录；本文件仅引用providerID/id/variant。启动进程通过tokenEnv对应的环境变量取得QQ令牌，不将令牌值放入配置。聊天令牌名使用IM_QQ_CHAT_TOKEN_前缀，与任务转发的IM_QQ_TOKEN_分开。配置合计最多512KiB UTF8，媒体资产也计入此上限。

修改模型、Agent或人格时，在同一次保存中增加该账号的contextGeneration，显式开启新的原生历史代际；reset命令用于保留当前模型/人格的独立上下文重置。重置影响该机器人账号的私聊和群聊，旧原生历史保留，已有QQ消息去重不清除，旧代际待发回复不补发。已经交给原生的执行仍归原生所有，不隐式取消或回滚任务。策略和账号开关变化不要求重置人格历史。

## 原生所有权

公开入口src/index.ts提供createQQChatbot、createChatbotModule、createChatSessions和类型。createQQChatbot在同一原生应用Scope中拥有本插件的QQ连接、观察与发送资源；createChatbotModule提供原生ApplicationModule和receive/observe端口，可用于其他明确授权的结构化输入。两者异步检查原生模型目录和Agent；ready只表示首次初始化结果，当前状态以原生模块目录为准。一个账号的模型或Agent无效时只停用该账号；其余账号可用时整体health为degraded。

配置显式提供受管理的绝对Location、账号、原生model引用、可选agentID以及persona.name/prompt。缺省Agent为原生build，缺省模型variant按原生Session.Info约定固定为default。人格使用原生API-managed instruction entry，不修改全局Agent、Provider或其他会话。模型、上下文限制、历史、压缩及用量全部由原生实现持有。

会话按“插件＋机器人账号＋私聊对象／群号”隔离。群成员共用该群的原生Session，每条模型输入是qq-message JSON，包含实际sender.id、可选显示名及正文；显示名仅作标签，不改变身份。私聊、不同群及不同机器人账号使用不同原生会话。配置或已保留会话的身份、模型、Agent、权限发生不一致时拒绝静默接管。

默认Session权限deny-all，不继承任务控制、研究派发、Codex绑定或通用操作能力。receive接收的是经本插件入口授权后的结构化消息；它不解析任务命令，也不承担任务转发的绑定逻辑。公开的结构化端口不是原始QQ授权器；QQ来源必须经过createQQChatbot的认证连接和本插件策略。

## QQ策略与回复

ChannelAccount显式配置独立OneBot连接、私聊白名单、可读取群号、可选忽略成员及回复开关。群内可读取所有未排除成员，群间上下文隔离，不继承任务转发的白名单/@命令规则；其他已配置机器人和自身消息被排除。默认groupReplies为auto，由人格模型决定是否参与，可返回空messages；还可显式选择directed或off。群中已有待回复输入时，新的非定向闲聊只作为观察上下文，不为每句闲聊排推理。私聊、@本机器人、叫人格名字或引用自身已确认回复可作为定向输入。

setReplies(botID, enabled)立即改变本账号的发送门槛，并持久化开关和版本。关闭后继续读取本群消息，但不排入Inbox、唤醒模型或公开发送。推理期间关闭再开启也不会补发旧轮次。观察消息通过通用experimental.session.observation.append写入原生Synthetic历史；原生prompt(resume:false)仍然是待办，因此不用于只读观察。相同观察ID及内容幂等，内容/跨会话/已有待办冲突拒绝写入，开启回复不重放旧观察。

模型使用严格内部JSON协议，可选择零至三条短气泡；整体计划先验证，再逐条发送。结构化@只能指向本群已实际观察到的成员号，不能使用昵称猜测或@all。第一条回复引用其原始QQ消息，后续气泡不重复引用；CQ文本作为普通文本发送。未知或格式错误的输出通过不含正文/凭据的onIssue反馈，不直接泄露内部JSON。该回调本身不自动向QQ发通知。

## 图片与表情

图片仅允许认证OneBot的get_image按NapCat内容标识返回base64字节，校验内容哈希、图片签名及本账号字节限额。返回的本地路径和URL不打开。模型必须支持图片输入且账号显式启用images才交给原生受控附件；无模型能力、无字节或哈希不符时整条消息作为not-interpreted观察，不用仅有的文本触发一次似乎已看图的回复。关闭回复时也只保留未理解标记，不声称图片已理解。

QQ内置face保留表情ID文本。发送表情包仅使用配置明确提供的命名inline图片资产，单项最多2MiB，不从任意路径/URL加载，也不默认继承旧DSH市场资源。共享qq-protocol执行一次内容校验和结构化发送，任务转发仍使用同一个公共实现。

## 重复消息与生命周期

插件KV只保存身份、会话映射、不可变消息指纹、开关版本和发送意图/回执，不保存消息正文、模型上下文或第二套执行队列。首次需要回复的输入交给原生prompt/Inbox。同一消息的并发转交只合并正在进行的接纳请求，不等待AI完成；请求结束立即释放。按房间串行的短接纳操作只负责保持入站顺序，不执行或调度AI。

已有指纹的重投只核对原生Inbox或历史，绝不重新发送prompt。原生普通prompt允许同ID撤回后再次入队，所以不能把再次提交当作重复消息核对。消息已撤回、原生结果不存在或未知时返回uncertain，不能声称已执行，也不会自动重放。显示名变化不修改旧输入或转移成员身份。

已有绑定的原生Session被删除后不自动创建替代会话；人格/模型发生冲突时也不覆盖历史。只有显式增加contextGeneration才为后续新输入选择新Session。未遵守显式配置迁移的直接文件修改仍会被原生身份核对拒绝，不静默接管历史。模块停止后拒绝新输入、结束自身接纳资源；已交给原生的推理和待办继续由原生负责。

公开发送先保存意图再发QQ，确认回执单独保存。只有与原生关闭输入、正确rootID/Session及原始来源对应的已定稿输出可发送；未知发送结果不盲重试。原生事件流驱动检查，没有后台轮询。停止完成后本插件不继续收发；显式重启可恢复仅含来源/输入ID的结果通知观察，不重新提交模型。已确认发送和未知回执均不会重复发送。自动重连和跨进程账号租约尚未实现。

## 验收范围

当前阶段运行python tools/run_runtime_checks.py --task Q1-04；此前Q1-01/02/03证据固定在原提交。当前验收使用真实产品CLI/服务、原生Scope/SQLite、认证loopback和合成模型，覆盖只聊天、只转发、双插件、配置/故障/启停/重启及显式上下文重置，并回归原聊天内核、媒体和任务转发链路。原生GUI以真实Chromium验证Configure、保存反馈、停用、通知和按需监控；合成模型不代表真实小羊角色效果评价。

API-managed JSON会话指令条目作为通用原生能力接入宿主，文件和URL标记按字面文本处理；不打开项目指令发现、文件路径、Shell、MCP或外部插件。原文件边界和受控附件另跑真实产品回归。日志和合成数据库留在忽略目录，公开证据只有源码指纹和验收结果。
