import type { OpenCodeClient } from "@opencode/client"
import type { StorageDomain } from "./storage.js"

/** Trusted compiled application capability, acquired once per application, never per Location or from project config. */
export interface ApplicationModule {
  readonly id: string
  /** Return the owned resource synchronously; asynchronous startup belongs to that resource and must not delay core boot. */
  readonly open: (context: { readonly client: OpenCodeClient; readonly storage: StorageDomain }) => {
    /** Stop new ingress, settle begun handoffs and release this connection before the native clients/database go away. */
    readonly close: () => Promise<void>
  }
}
