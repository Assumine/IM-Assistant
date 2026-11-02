import type { StorageDomain } from "../../../opencode/packages/plugin/src/promise/storage"

export type Data = Parameters<StorageDomain["set"]>[1]

export type Outcome =
  /** A verified finding, including an explicit negative finding such as { found: false }. */
  | { status: "success"; value: Data }
  /** An execution error, not an ordinary negative finding. The script confirms retry is safe. */
  | { status: "failure"; reason: string }
  | { status: "blocked"; reason: string }
  /** The external result is unknown. Review it before doing anything again. */
  | { status: "uncertain"; reason: string }

/** A trusted, replaceable function (a complete path or a real branch), never arbitrary request-supplied code. */
export interface ResearchPath {
  id: string
  revision: string
  category: string
  action: string
  title: string
  accepts: (input: Data) => boolean
  validates: (output: Data) => boolean
  /** Only host-proven read-only functions may recollect an expired checkpoint. */
  readOnly?: boolean
  /** Omit for validity within the owning native input. */
  validForMs?: number
  run: (input: Data, context: { signal: AbortSignal; roundID: string; attempt: number }) => Promise<Outcome>
}

/** Proven by the host's native input API, never accepted in model arguments. */
export interface ResearchInput {
  backendID: string
  threadID: string
  inputID: string
}

export interface Checkpoint {
  id: string
  category: string
  action: string
  input: Data
  output: Data
  pathID: string
  revision: string
  parents: string[]
  createdAt: number
  expiresAt?: number
  readOnly: boolean
}

export interface CollectionRequest extends Request { after?: string[] }

export interface CollectionReport extends Report {
  checkpoint?: string
  reused?: boolean
  recovery?: { reason: string; checkpoints: Checkpoint[] }
  assistance?: Data
}

export interface Scoring {
  initial: number
  failurePenalty: number
  successReward: number
  historicalFailurePenalty: number
}

export interface Request {
  roundID: string
  category: string
  action: string
  input: Data
  signal?: AbortSignal
}

export interface PathHistory {
  id: string
  revision: string
  score: number
  rounds: number
  successes: number
  failures: number
}

export interface PathSummary {
  id: string
  revision: string
  initialScore: number
  score: number
  attempts: number
  successes: number
  failures: number
  historicalDelta: number
}

export interface Attempt {
  pathID: string
  revision: string
  scoreBefore: number
  scoreAfter: number
  status: Outcome["status"] | "cancelled"
  reason?: string
}

export interface Report {
  schemaVersion: 1
  roundID: string
  status: "success" | "exhausted" | "blocked" | "uncertain" | "cancelled" | "no-path"
  reason?: string
  output?: Data
  attempts: Attempt[]
  paths: PathSummary[]
}
