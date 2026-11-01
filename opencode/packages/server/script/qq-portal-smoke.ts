// Isolated SDK/HTTP/SQLite acceptance. No QQ connection, login, or external message is made.
import assert from "node:assert/strict"
import { mkdtemp, mkdir } from "node:fs/promises"
import path from "node:path"
import { create } from "../../sdk/src/opencode"
import type { StorageDomain } from "../../plugin/src/promise/storage"
import { isConflictError } from "@opencode/client"
import { createPortal, type Message, type Scope } from "../../../../modules/qq-portal/src"
import { scopeKey } from "../../../../modules/qq-portal/src/routing"

const root = process.env.IM_QQ_TEST_ROOT
if (!root) throw new Error("Use tools.qq_portal_smoke with an isolated root")
const home = await mkdtemp(path.join(root, "qq-portal-"))
const directory = path.join(home, "location")
await mkdir(directory)
const checks: string[] = []
const requests: unknown[] = []
let ordinaryActivated = false
const entered = Promise.withResolvers<void>()
const release = Promise.withResolvers<void>()
const followupEntered = Promise.withResolvers<void>()
const followupRelease = Promise.withResolvers<void>()
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [] })
    requests.push(await request.json())
    const serial = requests.length
    if (serial === 1) {
      entered.resolve()
      await release.promise
    }
    if (serial === 6) {
      followupEntered.resolve()
      await followupRelease.promise
    }
    const chunks = [
      {
        choices: [
          { index: 0, delta: { role: "assistant", content: `QQ fixture response ${serial}` }, finish_reason: null },
        ],
      },
      {
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      },
    ]
    return new Response(
      chunks
        .map(
          (chunk) =>
            `data: ${JSON.stringify({ id: `qq-fixture-${serial}`, object: "chat.completion.chunk", model: "baseline", created: 0, ...chunk })}\n\n`,
        )
        .join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
const config = {
  model: "baseline/baseline",
  update: "disable",
  share: "disabled",
  providers: {
    baseline: {
      name: "Local QQ acceptance model",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "synthetic" },
      models: {
        baseline: {
          name: "Local model",
          limit: { context: 32000, output: 1024 },
          capabilities: { tools: false, input: ["text"], output: ["text"] },
        },
      },
    },
  },
}
const policy = { botID: "10001", allowedUsers: ["20001", "20002"], allowedGroups: ["30001"] }
const peer: Scope = { botID: policy.botID, kind: "private", peerID: "20001" }
const group: Scope = { botID: policy.botID, kind: "group", peerID: "30001" }
function message(id: string, text: string, quote?: string) {
  return {
    post_type: "message",
    message_type: "private",
    self_id: policy.botID,
    user_id: "20001",
    message_id: id,
    message: [...(quote ? [{ type: "reply", data: { id: quote } }] : []), { type: "text", data: { text } }],
  }
}
function recall(id: string, actor = "20001") {
  return { post_type: "notice", notice_type: "friend_recall", self_id: policy.botID, user_id: actor, message_id: id }
}
async function boot(plugins = true) {
  const ready = Promise.withResolvers<StorageDomain>()
  const other = Promise.withResolvers<StorageDomain>()
  const app = await create({
    database: { path: path.join(home, "application.sqlite") },
    models: { fetch: false },
    runtime: { managedDirectory: directory },
    config: { directory: path.join(home, "config"), project: false, claude: false, content: JSON.stringify(config) },
    fs: { filewatcher: false },
    log: { level: "error", emit: () => {} },
    plugins: [
      {
        id: "must-remain-blocked",
        setup: () => {
          ordinaryActivated = true
        },
      },
    ],
    trustedPlugins: plugins
      ? [
          {
            id: "qq-portal",
            setup: (context) => {
              ready.resolve(context.storage)
            },
          },
          {
            id: "unrelated-plugin",
            setup: (context) => {
              other.resolve(context.storage)
            },
          },
        ]
      : [],
  })
  return { app, storage: ready.promise, other: other.promise }
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 30_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Native QQ observation deadline")
    await Bun.sleep(20)
  }
}
async function bounded<T>(value: Promise<T>) {
  let timer: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([
      value,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("QQ fixture event deadline")), 30_000)
      }),
    ])
  } finally {
    clearTimeout(timer!)
  }
}

let host: Awaited<ReturnType<typeof boot>> | undefined
try {
  host = await boot()
  let app = host.app
  const first = await app.session.create({
    title: "QQ first",
    location: { directory },
    model: { providerID: "baseline", id: "baseline" },
  })
  const second = await app.session.create({
    title: "QQ second",
    location: { directory },
    model: { providerID: "baseline", id: "baseline" },
  })
  // Like the original SDK's instance tests, this initializes the actual Session instance; read-only agent lists do not load plugins.
  await app.permission.list({ sessionID: first.id })
  let storage = await bounded(host.storage)
  assert.equal(ordinaryActivated, false)
  const won = await Promise.all(Array.from({ length: 8 }, (_, i) => storage.insert("atomic-test", { i })))
  assert.equal(won.filter(Boolean).length, 1)
  assert.equal(await (await bounded(host.other)).get("atomic-test"), undefined)
  checks.push("public Promise SDK storage exposes atomic first-writer metadata and keeps plugin namespaces isolated")
  let portal = createPortal({ policy, storage, session: app.session })
  await portal.bind(peer, first.id)
  await portal.bind(group, second.id)
  const active = await app.session.prompt({ sessionID: first.id, text: "Desktop active input", delivery: "queue" })
  await bounded(entered.promise)
  assert.deepEqual(await portal.receive(message("command", "/CODEX LIST")), {
    status: "command",
    action: "list",
    arguments: "",
  })
  assert.deepEqual(await app.session.inbox.list({ sessionID: first.id }), [])
  checks.push(
    "recognized commands bypass AI admission while an actual native model request is held before its first token",
  )
  const controlled = () =>
    createPortal({ policy, storage, session: app.session, controls: { allowedUsers: ["20001"] } })
  const catalog = await controlled().receive(message("controls-list", "/CODEX LIST"))
  assert(catalog.status === "control" && catalog.result.kind === "conversations")
  assert(catalog.result.items.some((item) => item.target.kind === "session" && item.target.sessionID === first.id))
  assert(catalog.result.items.some((item) => item.target.kind === "session" && item.target.sessionID === second.id))
  assert.equal(requests.length, 1)
  checks.push(
    "authorized control list reads the original Session catalog while the real model is busy without admitting AI input",
  )
  const bindCommand = message("controls-bind", "/bind session " + first.id)
  const bindingCopies = await Promise.all(Array.from({ length: 8 }, () => controlled().receive(bindCommand)))
  assert(bindingCopies.some((row) => row.status === "control" && row.result.kind === "bound"))
  await controlled().receive(message("controls-move", "/bind " + second.id))
  const oldBind = await controlled().receive(bindCommand)
  assert(oldBind.status === "control" && oldBind.duplicate && oldBind.result.kind === "bound")
  assert.deepEqual(await storage.get("binding:" + scopeKey(peer)), { kind: "session", sessionID: second.id })
  await controlled().receive(message("controls-restore", "/bind " + first.id))
  checks.push(
    "concurrent control binding has one durable intent and replaying its historical receipt cannot overwrite a later binding",
  )
  await app.session.prompt({
    sessionID: first.id,
    id: "msg_controls_remove",
    text: "Must not run withdrawn control input",
    delivery: "queue",
  })
  const queueView = await controlled().receive(message("controls-queue", "/queue"))
  assert(queueView.status === "control" && queueView.result.kind === "queue")
  assert.deepEqual(
    queueView.result.items.map((row) => row.inputID),
    ["msg_controls_remove"],
  )
  assert.equal(queueView.result.state, undefined)
  const cancelCommand = message("controls-remove", "/UNQUEUE msg_controls_remove")
  const controlCancelResult = await controlled().receive(cancelCommand)
  assert(controlCancelResult.status === "control" && controlCancelResult.result.kind === "withdraw-requested")
  assert.deepEqual(await app.session.inbox.list({ sessionID: first.id }), [])
  assert.equal((await controlled().receive(cancelCommand)).status, "control")
  assert.equal(requests.length, 1)
  checks.push(
    "queue controls inspect and withdraw the exact pending native input without interrupting the active model or persisting a queue copy",
  )
  let lostBindingWrites = 0
  const lostBindCommand = message("controls-lost-bind", "/bind " + second.id)
  const lostControl = createPortal({
    policy,
    session: app.session,
    controls: { allowedUsers: ["20001"] },
    storage: {
      ...storage,
      set: async (key, value) => {
        await storage.set(key, value)
        if (key === "binding:" + scopeKey(peer)) {
          lostBindingWrites++
          throw new Error("Lost actual SQLite binding acknowledgment")
        }
      },
    },
  })
  const lostBindingResult = await lostControl.receive(lostBindCommand)
  assert(lostBindingResult.status === "control" && lostBindingResult.result.kind === "uncertain")
  await controlled().receive(message("controls-restore-lost", "/bind " + first.id))
  const lostBindAgain = await controlled().receive(lostBindCommand)
  assert(lostBindAgain.status === "control" && lostBindAgain.result.kind === "uncertain")
  assert.equal(lostBindingWrites, 1)
  assert.deepEqual(await storage.get("binding:" + scopeKey(peer)), { kind: "session", sessionID: first.id })
  checks.push(
    "an actual SQLite binding write with a lost acknowledgment retains uncertainty and cannot reapply after another binding",
  )
  const deniedControl = createPortal({ policy, storage, session: app.session, controls: { allowedUsers: [] } })
  const deniedResult = await deniedControl.receive(message("controls-denied", "/list"))
  assert(deniedResult.status === "control" && deniedResult.result.kind === "forbidden")
  const unsupportedControl = await controlled().receive(message("controls-unsupported", "/queue must-not-run"))
  assert(unsupportedControl.status === "control" && unsupportedControl.result.kind === "unsupported")
  assert.equal(requests.length, 1)
  assert.deepEqual(await app.session.inbox.list({ sessionID: first.id }), [])
  checks.push(
    "control grants are separate from task allowlisting and unsupported control variants do not fall through to the model",
  )
  const queued = message("queued", "Unique QQ queued body")
  const copies = await Promise.all(Array.from({ length: 8 }, () => portal.receive(queued)))
  assert(copies.some((result) => result.status === "accepted"))
  const pending = await app.session.inbox.list({ sessionID: first.id })
  assert.equal(pending.length, 1)
  assert.equal(pending[0].type, "user")
  if (pending[0].type !== "user") throw new Error("User input expected")
  assert.equal(pending[0].payload.text, "Unique QQ queued body")
  assert.equal(pending[0].payload.metadata?.qq && typeof pending[0].payload.metadata.qq === "object", true)
  const taskTarget = { kind: "session" as const, sessionID: first.id }
  const taskSource = { scope: peer, messageID: "queued", actorID: "20001" }
  assert.deepEqual(await portal.sourceFor(taskTarget, pending[0].id), { status: "found", source: taskSource })
  assert.deepEqual(await portal.sourceFor({ kind: "session", sessionID: second.id }, pending[0].id), {
    status: "missing",
  })
  assert.equal((await storage.scan({ prefix: "input-origin:" })).entries.length, 1)
  checks.push(
    "real plugin SQLite stores and reverses the original QQ envelope without inferring recipients from another Session",
  )
  assert.equal(
    (
      await app.session.inbox.amendment({
        sessionID: first.id,
        inboxID: pending[0].id,
        amendmentID: "msg_never_appended",
      })
    ).status,
    "unknown",
  )
  assert.equal((await app.session.inbox.list({ sessionID: first.id }))[0].id, pending[0].id)
  checks.push("unknown amendment receipt reads never append text, admit work or replace the pending input")
  const desktop = await app.session.prompt({ sessionID: first.id, text: "Desktop pending input", delivery: "queue" })
  assert.deepEqual(
    (await app.session.inbox.list({ sessionID: first.id })).map((input) => input.id),
    [pending[0].id, desktop.id],
  )
  assert(!JSON.stringify(await storage.scan({ prefix: "origin:" })).includes("Unique QQ queued body"))
  checks.push(
    "eight QQ deliveries admit one original input beside desktop input in the same real Inbox, with metadata outside visible text",
  )
  assert.equal((await portal.receive(message("withdraw", "Must never reach the model"))).status, "accepted")
  assert.equal((await portal.receive(recall("withdraw"))).status, "withdrawn")
  assert.equal((await portal.receive(message("withdraw", "Must never reach the model"))).status, "recalled")
  await portal.receive(recall("before-arrival"))
  assert.equal((await portal.receive(message("before-arrival", "Late offline recalled input"))).status, "recalled")
  assert.equal(
    (await portal.receive({ ...recall("queued", "20002"), notice_type: "group_recall", group_id: "30001" })).status,
    "unchanged",
  )
  assert.equal((await app.session.inbox.list({ sessionID: first.id })).length, 2)
  checks.push(
    "queued recall and recall-before-offline-delivery suppress only the matching native pending input and never interrupt a running request",
  )
  let attempts = 0
  const unknown = createPortal({
    policy,
    storage,
    session: {
      ...app.session,
      prompt: async () => {
        attempts++
        throw new Error("No native evidence")
      },
    },
  })
  assert.equal((await unknown.receive(message("unknown", "Unknown must not replay"))).status, "uncertain")
  assert.equal((await unknown.receive(message("unknown", "Unknown must not replay"))).status, "uncertain")
  assert.equal(attempts, 1)
  const lost = createPortal({
    policy,
    storage,
    session: {
      ...app.session,
      prompt: async (input) => {
        await app.session.prompt(input)
        throw new Error("Lost HTTP acknowledgment")
      },
    },
  })
  assert.equal((await lost.receive(message("lost", "QQ recovered acknowledgment"))).status, "accepted")
  assert.equal((await lost.receive(message("lost", "QQ recovered acknowledgment"))).status, "accepted")
  assert.equal((await app.session.inbox.list({ sessionID: first.id })).length, 3)
  const interruptedIndex = createPortal({
    policy,
    session: app.session,
    storage: {
      ...storage,
      insert: async (key, value) => {
        if (key.startsWith("input-origin:")) throw new Error("Reverse-index fixture failure")
        return storage.insert(key, value)
      },
    },
  })
  await assert.rejects(
    () => interruptedIndex.receive(message("index-interrupted", "Must not submit incomplete routing metadata")),
    /Reverse-index/,
  )
  assert.equal(
    (await portal.receive(message("index-interrupted", "Must not submit incomplete routing metadata"))).status,
    "uncertain",
  )
  assert.equal((await app.session.inbox.list({ sessionID: first.id })).length, 3)
  checks.push(
    "a persisted origin with a failed reverse-index write repairs only routing metadata on redelivery, never admitting new work",
  )
  checks.push(
    "unknown handoff is not replayed; a lost HTTP acknowledgment is reconciled from actual native pending evidence",
  )
  const decoded = (await import("../../../../modules/qq-portal/src/routing")).decode(queued, policy)
  if (decoded.kind !== "message") throw new Error("Message expected")
  await portal.linkReply(decoded.message as Message, "reply-to-queued")
  const adjustment = message("adjust", "Add more", "reply-to-queued")
  assert.equal((await portal.receive(adjustment)).status, "amended")
  assert.equal((await portal.receive(adjustment)).status, "amended")
  const lostAppend = createPortal({
    policy,
    storage,
    session: {
      ...app.session,
      inbox: {
        ...app.session.inbox,
        append: async (input) => {
          await app.session.inbox.append(input)
          throw new Error("Lost append acknowledgment")
        },
      },
    },
  })
  const recoveredAppend = message("lost-append", "Lost append acknowledgment recovered", "reply-to-queued")
  assert.equal((await lostAppend.receive(recoveredAppend)).status, "amended")
  assert.equal((await portal.receive(recoveredAppend)).status, "amended")
  assert.equal((await portal.receive(recall("adjust"))).status, "unchanged")
  assert.equal((await app.session.inbox.list({ sessionID: first.id })).length, 3)
  await portal.bind(peer, second.id)
  const duplicate = await portal.receive(queued)
  assert(duplicate.status === "accepted" && duplicate.sessionID === first.id)
  const cross = message("cross", "Other conversation", "reply-to-queued")
  const confirmation = await portal.receive(cross)
  assert(
    confirmation.status === "confirmation-required" &&
      confirmation.target.kind === "session" &&
      confirmation.target.sessionID === first.id,
  )
  const approval = {
    confirmationID: confirmation.confirmationID,
    scope: peer,
    actorID: "20001",
    choice: "approve" as const,
  }
  assert.equal((await portal.confirm(cross, approval)).status, "amended")
  assert.equal((await portal.confirm(cross, approval)).status, "amended")
  assert.deepEqual(await storage.get("binding:" + scopeKey(peer)), { kind: "session", sessionID: second.id })
  checks.push(
    "explicit cross-session consent appends to the original pending input once without changing the current binding",
  )
  assert.equal((await portal.receive(message("queued", "Changed body"))).status, "conflict")
  checks.push(
    "quoted pending input appends once in place, including lost acknowledgments; source and reply IDs retain their frozen target through rebinding",
  )
  const failedStorage = createPortal({
    policy,
    session: app.session,
    storage: {
      ...storage,
      insert: async () => {
        throw new Error("Metadata persistence failure")
      },
    },
  })
  assert.deepEqual(await failedStorage.receive(message("store-failure", "Must not claim acceptance")), {
    status: "uncertain",
  })
  assert.equal((await app.session.inbox.list({ sessionID: first.id })).length, 3)
  const groupMessage = {
    ...message("group", "Group input"),
    message_type: "group",
    group_id: "30001",
    message: [{ type: "at", data: { qq: policy.botID } }, ...message("group", "Group input").message],
  }
  assert.equal(
    (await portal.receive({ ...groupMessage, message: message("group", "Group input").message })).status,
    "ignored",
  )
  assert.equal((await portal.receive({ ...groupMessage, self_id: "10002" })).status, "ignored")
  assert.equal((await portal.receive(groupMessage)).status, "accepted")
  checks.push(
    "failed metadata writes do not admit input; group at/actor rules and other bot separation remain before all admission",
  )
  release.resolve()
  await until(async () => {
    const running = await app.session.active()
    return !running[first.id] && !running[second.id]
  })
  assert.equal(requests.length, 5)
  assert.equal(ordinaryActivated, false)
  const history = await app.session.context({ sessionID: first.id })
  assert.deepEqual(
    history.filter((item) => item.type === "user").map((item) => item.text),
    [
      "Desktop active input",
      "Unique QQ queued body\n\nAdd more\n\nLost append acknowledgment recovered\n\nOther conversation",
      "Desktop pending input",
      "QQ recovered acknowledgment",
    ],
  )
  assert.equal(history.filter((item) => item.id === active.id).length, 1)
  assert(!JSON.stringify(requests).includes("Must never reach the model"))
  assert(!JSON.stringify(requests).includes("Unknown must not replay"))
  checks.push("the original native drain owns FIFO and completion independently of QQ bindings, metadata or replies")
  await app.close()
  host = await boot()
  app = host.app
  await app.permission.list({ sessionID: first.id })
  storage = await bounded(host.storage)
  portal = createPortal({ policy, storage, session: app.session })
  const restartedControl = await controlled().receive(bindCommand)
  assert(
    restartedControl.status === "control" && restartedControl.duplicate && restartedControl.result.kind === "bound",
  )
  const restartedUnknownControl = await controlled().receive(lostBindCommand)
  assert(restartedUnknownControl.status === "control" && restartedUnknownControl.result.kind === "uncertain")
  const restartedWithdrawal = await controlled().receive(cancelCommand)
  assert(
    restartedWithdrawal.status === "control" &&
      restartedWithdrawal.duplicate &&
      restartedWithdrawal.result.kind === "withdraw-requested",
  )
  assert.deepEqual(await storage.get("binding:" + scopeKey(peer)), { kind: "session", sessionID: second.id })
  checks.push(
    "SQLite reopen restores control facts without rewriting a newer binding, retrying an uncertain control or sending withdrawn model input",
  )
  const restored = await portal.receive(queued)
  assert(restored.status === "accepted" && restored.sessionID === first.id && restored.duplicate)
  const recoveredSource = await portal.sourceFor(taskTarget, pending[0].id)
  assert.deepEqual(recoveredSource, { status: "found", source: taskSource })
  if (recoveredSource.status !== "found") throw new Error("Original QQ source expected")
  await portal.linkReply(recoveredSource.source, "restored-final-reply")
  assert.deepEqual(await portal.sourceFor(taskTarget, pending[0].id), recoveredSource)
  assert.equal(requests.length, 5)
  checks.push(
    "SQLite reopen restores the task starting message for first/final references after amendments and rebinding without model replay",
  )
  assert.equal((await portal.receive(adjustment)).status, "amended")
  assert.equal((await portal.receive(recoveredAppend)).status, "amended")
  const decodedAdjustment = (await import("../../../../modules/qq-portal/src/routing")).decode(adjustment, policy)
  if (decodedAdjustment.kind !== "message") throw new Error("Adjustment expected")
  const amendmentID = (await import("../../../../modules/qq-portal/src/routing")).inputID(decodedAdjustment.message)
  assert.equal(
    (await app.session.inbox.append({ sessionID: first.id, inboxID: pending[0].id, amendmentID, text: "Add more" }))
      .status,
    "applied",
  )
  await assert.rejects(
    () =>
      app.session.inbox.append({
        sessionID: first.id,
        inboxID: pending[0].id,
        amendmentID: "msg_too_late",
        text: "Must not alter delivered history",
      }),
    isConflictError,
  )
  assert.equal(requests.length, 5)
  checks.push(
    "SQLite restart restores append receipts; consumed parents reject new amendments without creating a follow-up task",
  )
  assert.equal((await portal.receive(message("unknown", "Unknown must not replay"))).status, "uncertain")
  assert.equal(
    (await portal.receive(message("cross-restart", "Keep frozen target", "reply-to-queued"))).status,
    "confirmation-required",
  )
  assert.equal((await portal.confirm(cross, approval)).status, "amended")
  assert.equal(requests.length, 5)
  checks.push(
    "SQLite reopen retains consent and the native amendment receipt; repeated confirmation never resends or changes binding",
  )
  assert.equal((await portal.receive(recall("queued"))).status, "unchanged")
  assert.equal(requests.length, 5)
  checks.push(
    "SQLite restart restores bindings, origin aliases and unknown handoffs without replay; delivered input recall leaves execution unchanged",
  )
  const parentPosition = await app.session.input.position({ sessionID: first.id, inputID: pending[0].id })
  assert(parentPosition.status === "closed" && parentPosition.rootID === pending[0].id)
  assert.equal(
    (await app.session.input.position({ sessionID: first.id, inputID: "msg_missing_parent" })).status,
    "unknown",
  )
  await assert.rejects(
    () =>
      app.session.input.followup({
        sessionID: first.id,
        expectedInputID: pending[0].id,
        expectedRootID: "msg_wrong_root",
        inboxID: "msg_no_false_followup",
        text: "Must not follow missing ownership",
      }),
    isConflictError,
  )
  assert.equal(requests.length, 5)
  checks.push(
    "fresh native close evidence survives SQLite reopen; missing history and wrong-root follow-ups do not admit work",
  )
  const linked = message("linked-followup", "Follow the earlier result", "restored-final-reply")
  const linkedProposal = await portal.receive(linked)
  assert(linkedProposal.status === "confirmation-required")
  const linkedApproval = {
    confirmationID: linkedProposal.confirmationID,
    scope: peer,
    actorID: "20001",
    choice: "approve" as const,
  }
  const linkedResult = await portal.confirm(linked, linkedApproval)
  assert(
    linkedResult.status === "followup" &&
      linkedResult.parentInputID === pending[0].id &&
      linkedResult.inputID !== pending[0].id,
  )
  await bounded(followupEntered.promise)
  assert.deepEqual(await storage.get("binding:" + scopeKey(peer)), { kind: "session", sessionID: second.id })
  const linkedSource = { scope: peer, messageID: "linked-followup", actorID: "20001" }
  assert.deepEqual(await portal.sourceFor(taskTarget, linkedResult.inputID), { status: "found", source: linkedSource })
  assert.deepEqual(await portal.sourceFor(taskTarget, pending[0].id), { status: "found", source: taskSource })
  checks.push(
    "a confirmed historical quote creates its own native input and source while preserving parent history and current binding",
  )
  const cancelLinked = message("cancel-linked", "Must not execute withdrawn follow-up", "restored-final-reply")
  const cancelProposal = await portal.receive(cancelLinked)
  assert(cancelProposal.status === "confirmation-required")
  const cancelResult = await portal.confirm(cancelLinked, {
    ...linkedApproval,
    confirmationID: cancelProposal.confirmationID,
  })
  assert(cancelResult.status === "followup")
  assert.equal((await portal.receive(recall("cancel-linked"))).status, "withdrawn")
  assert.equal(
    (
      await app.session.input.followupReceipt({
        sessionID: first.id,
        expectedInputID: pending[0].id,
        inboxID: cancelResult.inputID,
      })
    ).status,
    "cancelled",
  )
  const lostLinked = message("lost-linked", "Linked native acknowledgment recovered", "restored-final-reply")
  const lostLinkedPortal = createPortal({
    policy,
    storage,
    session: {
      ...app.session,
      input: {
        ...app.session.input,
        followup: async (input) => {
          await app.session.input.followup(input)
          throw new Error("Synthetic follow-up acknowledgment loss")
        },
      },
    },
  })
  const lostProposal = await lostLinkedPortal.receive(lostLinked)
  assert(lostProposal.status === "confirmation-required")
  const lostResult = await lostLinkedPortal.confirm(lostLinked, {
    ...linkedApproval,
    confirmationID: lostProposal.confirmationID,
  })
  assert(lostResult.status === "followup" && lostResult.delivery === "pending")
  assert.equal((await portal.receive(lostLinked)).status, "followup")
  assert.equal((await app.session.inbox.list({ sessionID: first.id })).length, 1)
  checks.push(
    "linked queued recall cancels only the new task; lost handoff acknowledgments reconcile without a duplicate input",
  )
  followupRelease.resolve()
  await until(async () => {
    const active = await app.session.active()
    return !active[first.id] && !active[second.id]
  })
  assert.equal(requests.length, 7)
  assert(!JSON.stringify(requests).includes("Must not execute withdrawn follow-up"))
  const linkedMessage = (await app.session.context({ sessionID: first.id })).find(
    (row) => row.id === linkedResult.inputID,
  )
  assert(linkedMessage?.type === "user" && linkedMessage.text === "Follow the earlier result")
  assert.deepEqual(linkedMessage.metadata?.inputRelation, {
    kind: "followup",
    inputID: pending[0].id,
    rootID: pending[0].id,
  })
  await app.close()
  host = await boot()
  app = host.app
  await app.permission.list({ sessionID: first.id })
  storage = await bounded(host.storage)
  portal = createPortal({ policy, storage, session: app.session })
  assert.equal((await portal.confirm(linked, linkedApproval)).status, "followup")
  assert.equal((await portal.receive(lostLinked)).status, "followup")
  assert.equal((await portal.receive(recall("linked-followup"))).status, "unchanged")
  assert.equal(requests.length, 7)
  assert.deepEqual(await portal.sourceFor(taskTarget, linkedResult.inputID), { status: "found", source: linkedSource })
  checks.push(
    "linked follow-up receipts and original sources survive SQLite restart; delivered history is not replayed or appended",
  )
  await app.close()
  host = await boot(false)
  assert.equal((await host.app.session.get({ sessionID: first.id })).id, first.id)
  assert.equal((await host.app.session.inbox.list({ sessionID: first.id })).length, 0)
  assert.equal(requests.length, 7)
  checks.push("the original core and its stored conversations reopen with no QQ plugin, transport or login")
  console.log(
    JSON.stringify({
      status: "passed",
      checks,
      model_requests: requests.length,
      actual_qq_connection: false,
      external_messages_sent: 0,
    }),
  )
} finally {
  release.resolve()
  followupRelease.resolve()
  await host?.app.close()
  upstream.stop(true)
}
