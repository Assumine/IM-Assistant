export * as Profile from "./profile.js"

// Product identity only. Session execution, Inbox, history and compression stay native.
export const id = "tools.assumine.im-assistant"
export const name = "IM-Assistant"
export const serviceFile = "service-im-assistant.json"
export const servicePort = 28716

export function active() {
  return process.env.IM_ASSISTANT_PROFILE === "personal"
}
