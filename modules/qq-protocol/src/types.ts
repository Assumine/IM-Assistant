/** Protocol addressing only. Authorization, bindings and native task IDs belong to each consumer. */
export type Scope = { botID: string; kind: "private" | "group"; peerID: string }
export type Source = { scope: Scope; messageID: string; actorID: string }
