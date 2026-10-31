// Deliberately not registered in the application until the whole-backend host slot is verified.
export { CodexSessionAdapter } from "./session-adapter"
export { nativeBackend } from "./backend"
export type { Thread, Submission, Page, ItemEntry } from "./session-adapter"
export { createProfile, createSharedProfile, loadProfile, verifiedVersion } from "./profile"
export { stopSharedService } from "./shared"
export type { Profile, Connection } from "./profile"
export { NativeError, OutcomeUnknown } from "./transport"
export type { Launch, Notification } from "./transport"
