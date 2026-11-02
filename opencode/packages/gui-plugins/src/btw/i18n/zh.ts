import en from "./en"

export default {
  "command.title": "询问旁支问题",
  "command.description": "获取一次性回答，不加入当前会话上下文",
  "tab.title": "/btw",
  "question.required": "请在 /btw 后添加问题",
  error: "无法回答这个问题",
  retry: "重试",
  copy: "复制回答",
} satisfies Record<keyof typeof en, string>
