import type { Schema } from "effect"
import type { StorageScanOptions, StorageScanResult } from "../storage.js"

export interface StorageDomain {
  readonly get: (key: string) => Promise<Schema.Json | undefined>
  readonly set: (key: string, value: Schema.Json) => Promise<void>
  /** Atomically create metadata if absent. Does not claim or schedule executable work. */
  readonly insert: (key: string, value: Schema.Json) => Promise<boolean>
  readonly remove: (key: string) => Promise<void>
  readonly scan: (options: StorageScanOptions) => Promise<StorageScanResult>
}
