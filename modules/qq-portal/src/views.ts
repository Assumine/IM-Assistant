import type { StorageDomain } from "../../../opencode/packages/plugin/src/promise/storage"
import { createHash } from "node:crypto"
import { fingerprint, originKey, scopeKey, type Message, type Policy } from "./routing"
import { target, type Target } from "./target"
import type { Source } from "./sources"

type Storage = Pick<StorageDomain, "get" | "insert">
export type QueueAddress = { inputID: string; nativeID: string }
type Common = { id: string; fingerprint: string; source: Source; incomplete: boolean }
type Content = Omit<Common, "id"> & ({ kind: "conversations"; items: Target[] } | { kind: "queue"; target: Target; items: QueueAddress[] })
export type View = Content & { id: string }
export type Selection = { kind: "selected"; view: View; target: Target; address?: QueueAddress } | { kind: "selection-required" | "invalid" | "conflict" }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const messageID = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value)
const qq = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value)
export const isViewID = (value: unknown): value is string => typeof value === "string" && /^view_qq_[a-f0-9]{64}_[a-f0-9]{64}$/.test(value)
const targetIdentity = (value: Target) => value.kind === "session" ? ["session", value.sessionID] : ["backend", value.ref.backendID, value.ref.threadID]
const viewID = (value: Content) => {
  const sourceKey = originKey(value.source.scope, value.source.messageID)
  const identity = [sourceKey, value.source.actorID, value.fingerprint, value.kind, value.incomplete,
    value.kind === "conversations" ? value.items.map(targetIdentity) : [targetIdentity(value.target), value.items.map((item) => [item.inputID, item.nativeID])]]
  return "view_qq_" + sourceKey + "_" + createHash("sha256").update(JSON.stringify(identity)).digest("hex")
}
const sameSource = (a: Source, b: Source) => scopeKey(a.scope) === scopeKey(b.scope) && a.actorID === b.actorID && a.messageID === b.messageID
const source = (value: unknown): Source => {
  if (!record(value) || Object.keys(value).length !== 3 || !messageID(value.messageID) || !qq(value.actorID) || !record(value.scope) ||
    Object.keys(value.scope).length !== 3 || !qq(value.scope.botID) || !qq(value.scope.peerID) || value.scope.kind !== "private" && value.scope.kind !== "group" ||
    value.scope.kind === "private" && value.scope.peerID !== value.actorID) throw new Error("Invalid view source")
  return value as Source
}
const parse = (value: unknown): View => {
  if (!record(value) || !isViewID(value.id) || typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
    typeof value.incomplete !== "boolean" || !Array.isArray(value.items) || value.items.length > 10_000 ||
    value.kind !== "conversations" && value.kind !== "queue" ||
    Object.keys(value).some((key) => !["id", "fingerprint", "source", "kind", "items", "incomplete", "target"].includes(key))) throw new Error("Invalid control view")
  const owner = source(value.source)
  if (value.kind === "conversations") {
    if (value.target !== undefined) throw new Error("Invalid catalog target")
    const items = value.items.map(target)
    if (new Set(items.map((item) => JSON.stringify(item))).size !== items.length) throw new Error("Duplicate view target")
    const content: Content = { fingerprint: value.fingerprint, source: owner, incomplete: value.incomplete, kind: "conversations", items }
    if (value.id !== viewID(content)) throw new Error("Wrong view identity")
    return { id: value.id, ...content }
  }
  const destination = target(value.target)
  const items = value.items.map((item) => {
    if (!record(item) || Object.keys(item).length !== 2 || !id(item.inputID) || !id(item.nativeID) ||
      destination.kind === "session" && item.inputID !== item.nativeID) throw new Error("Invalid queue address")
    return { inputID: item.inputID, nativeID: item.nativeID }
  })
  if (new Set(items.map((item) => item.inputID)).size !== items.length || new Set(items.map((item) => item.nativeID)).size !== items.length) throw new Error("Duplicate queue address")
  const content: Content = { fingerprint: value.fingerprint, source: owner, incomplete: value.incomplete, kind: "queue", target: destination, items }
  if (value.id !== viewID(content)) throw new Error("Wrong view identity")
  return { id: value.id, ...content }
}

/** Immutable display-to-ID maps in the original plugin KV; never a live queue, payload cache or scheduler. */
export function views(options: { storage: Storage; policy: Policy; canPublish: (source: Source) => boolean; allowedTarget: (target: Target) => boolean }) {
  const { storage, policy } = options
  const permitted = (owner: Source) => owner.scope.botID === policy.botID && policy.allowedUsers.includes(owner.actorID) &&
    (owner.scope.kind === "private" ? owner.scope.peerID === owner.actorID : policy.allowedGroups.includes(owner.scope.peerID))
  // The source half finds the first-writer row; the content half detects changed IDs, order, target or provenance.
  const key = (id: string) => "control-view:" + id.substring(8, 72)
  const aliasKey = (owner: Pick<Source, "scope" | "messageID">) => "control-view-alias:" + originKey(owner.scope, owner.messageID)
  const load = async (id: string) => {
    if (!isViewID(id)) throw new Error("Invalid view ID")
    const value = parse(await storage.get(key(id)))
    if (value.id !== id) throw new Error("Wrong stored view")
    return value
  }
  const alias = async (owner: Pick<Source, "scope" | "messageID">, id: string) => {
    const name = aliasKey(owner)
    if (!await storage.insert(name, { viewID: id })) {
      const found = await storage.get(name)
      if (!record(found) || Object.keys(found).length !== 1 || found.viewID !== id) throw new Error("Conflicting view alias")
    }
  }
  return {
    async prepare(input: Message, value: { kind: "conversations"; items: Target[]; incomplete: boolean } | { kind: "queue"; target: Target; items: QueueAddress[]; incomplete: boolean }): Promise<View> {
      const owner: Source = { scope: input.scope, actorID: input.actorID, messageID: input.messageID }
      const content: Content = { fingerprint: fingerprint(input), source: owner, ...value }
      const created = parse({ id: viewID(content), ...content })
      if (!permitted(owner) || !options.canPublish(owner)) throw new Error("View not authorized")
      if (await storage.insert(key(created.id), created)) return created
      const winner = parse(await storage.get(key(created.id)))
      if (!sameSource(winner.source, owner) || winner.fingerprint !== created.fingerprint || winner.kind !== created.kind) throw new Error("Conflicting view")
      return winner
    },
    /** Trusted transport only: call after its actual send returned an outgoing QQ message ID. No send occurs here. */
    async publish(ownerValue: Source, id: string, outgoingMessageID: string) {
      const owner = source(ownerValue)
      if (!messageID(outgoingMessageID) || owner.messageID === outgoingMessageID || !permitted(owner) || !options.canPublish(owner)) throw new Error("View publication not authorized")
      const view = await load(id)
      if (!sameSource(view.source, owner) || !(view.kind === "queue" ? options.allowedTarget(view.target) : view.items.every(options.allowedTarget))) throw new Error("Wrong publication source or grant")
      const ingress = await storage.get("ingress:" + originKey(owner.scope, owner.messageID))
      if (!record(ingress) || ingress.kind !== "control" || ingress.fingerprint !== view.fingerprint) throw new Error("Control source is not confirmed")
      const outgoingKey = originKey(owner.scope, outgoingMessageID)
      if (await storage.get("origin:" + outgoingKey) !== undefined || await storage.get("ingress:" + outgoingKey) !== undefined) throw new Error("Outgoing view aliases an incoming message")
      await alias({ scope: owner.scope, messageID: outgoingMessageID }, view.id)
      await alias(owner, view.id)
      const readyKey = "control-view-published:" + view.id
      const ready = { viewID: view.id, sourceKey: originKey(owner.scope, owner.messageID) }
      if (!await storage.insert(readyKey, ready)) {
        const found = await storage.get(readyKey)
        if (!record(found) || Object.keys(found).length !== 2 || found.viewID !== ready.viewID || found.sourceKey !== ready.sourceKey) throw new Error("Conflicting publication")
      }
    },
    async select(input: Message, kind: "conversations" | "queue", index: string): Promise<Selection> {
      if (!/^[1-9][0-9]{0,4}$/.test(index)) return { kind: "invalid" }
      if (!input.quoteID) return { kind: "selection-required" }
      const ref = await storage.get(aliasKey({ scope: input.scope, messageID: input.quoteID }))
      if (ref === undefined) return { kind: "selection-required" }
      if (!record(ref) || Object.keys(ref).length !== 1 || !isViewID(ref.viewID)) throw new Error("Invalid published view alias")
      const view = await load(ref.viewID)
      if (scopeKey(view.source.scope) !== scopeKey(input.scope) || !permitted(view.source) || view.kind !== kind) return { kind: "conflict" }
      const ready = await storage.get("control-view-published:" + view.id)
      if (ready === undefined) return { kind: "selection-required" }
      if (!record(ready) || Object.keys(ready).length !== 2 || ready.viewID !== view.id || ready.sourceKey !== originKey(view.source.scope, view.source.messageID)) throw new Error("Invalid publication fact")
      const position = Number(index) - 1
      if (position >= view.items.length) return { kind: "invalid" }
      return view.kind === "conversations" ? { kind: "selected", view, target: view.items[position]! }
        : { kind: "selected", view, target: view.target, address: view.items[position]! }
    },
  }
}
