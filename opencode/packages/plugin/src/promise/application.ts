import type { OpenCodeClient } from "@opencode/client"
import type { StorageDomain } from "./storage.js"
import type { Capability } from "@opencode/schema/capability"

/** Trusted declarative configuration, available even when the service is disabled or failed. No live task mutation. */
export interface ApplicationModuleSettings {
  /** Return validated non-secret settings and their current revision; reject when they cannot be read safely. */
  readonly read: (signal: AbortSignal) => Promise<Capability.Settings>
  /** Validate and atomically replace the expected revision. Undefined means a concurrent change; never silently overwrite. */
  readonly write: (input: { readonly revision: string; readonly text: string }, signal: AbortSignal) => Promise<Capability.Settings | undefined>
}

/** Capabilities owned by one compiled application module. Notifications never change native tasks. */
export interface ApplicationCapability {
  /** Report connection/health independently of whether this resource has opened. Never include credentials. */
  readonly report: (value: Capability.Health) => void
  /** Publish one immutable, idempotent notice in this module's namespace. A conflicting id rejects. */
  readonly notify: (value: Capability.NoticeInput) => Promise<void>
  /** Resolve this module's notice; this does not mark it as read. Unknown ids reject. */
  readonly resolve: (id: string) => Promise<void>
}

/** Trusted compiled application capability, acquired once per application, never per Location or from project config. */
export interface ApplicationModule {
  readonly id: string
  /** Display name supplied by the capability, never inferred from dependencies. Defaults to the id. */
  readonly title?: string
  /** Optional module-owned declarative settings; writes apply on the next service start, independently of resource stop. */
  readonly settings?: ApplicationModuleSettings
  /** Return the owned resource synchronously; asynchronous startup belongs to that resource and must not delay core boot. */
  readonly open: (context: {
    readonly client: OpenCodeClient
    readonly storage: StorageDomain
    readonly capability: ApplicationCapability
  }) => {
    /** Stop new ingress, settle begun handoffs and release this connection before the native clients/database go away. */
    readonly close: () => Promise<void>
    /** Optional on-demand snapshot, called at most once per second while requested; honor the abort signal. */
    readonly metrics?: (signal: AbortSignal) => Promise<readonly Capability.Metric[]>
  }
}

/** A trusted installed capability whose configuration is loaded without blocking the core. Not request-supplied code. */
export interface ApplicationModuleLoader {
  /** Stable id; the loaded module must return the same id. */
  readonly id: string
  /** Display name for disabled, loading and failed configurations. Defaults to the id. */
  readonly title?: string
  /** Optional trusted settings owner, usable without opening the service or its network connection. */
  readonly settings?: ApplicationModuleSettings
  /** Return undefined when configured off. Abort prevents a late module from opening after stop/shutdown. */
  readonly load: (signal: AbortSignal) => Promise<ApplicationModule | undefined>
}

/** Direct resources and deferred, trusted configuration loaders share the original application scope. */
export type ApplicationModuleEntry = ApplicationModule | ApplicationModuleLoader
