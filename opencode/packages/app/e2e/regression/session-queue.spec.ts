import { expect, test, type Page } from "@playwright/test"
import type { OpenCodeEvent, SessionInboxInfo, SessionMessageInfo, ShellInfo } from "@opencode/client/promise"
import { PromptInput } from "@opencode/schema/prompt-input"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { SessionMessage } from "@opencode/schema/session-message"
import { Schema } from "effect"
import { holdRoute, provider, SERVER } from "../utils/app"
import type { MockServerConfig } from "../utils/mock-server"
import { openSession } from "../utils/workspace"
import { mockWorkspace } from "../utils/workspace"
import { backendEvent, backendHref, backendRpc, backendTabs } from "../utils/backends"
import type { ConversationBackend } from "@opencode/schema/conversation-backend"
import { readBackendDraft } from "../utils/drafts"

const sessionID = "ses_session_queue_regression"

test("whole backend: native editor preserves scoped drafts and reconciles a lost reply with the original input", async ({
  page,
}) => {
  const alpha: ConversationBackend.Thread = {
    ref: { backendID: "alpha", threadID: "same-thread" },
    title: "Draft Alpha",
    state: "idle",
  }

  const beta: ConversationBackend.Thread = { ...alpha, ref: { ...alpha.ref, backendID: "beta" }, title: "Draft Beta" }
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const calls: ConversationBackend.Input[] = []
  const records: ConversationBackend.Entry[] = []
  const receipts = new Map<string, ConversationBackend.Admission>()
  const sessions: string[] = []
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname

    if (request.method() === "POST" && (path === "/api/session" || path.endsWith("/prompt"))) sessions.push(path)
  })
  await mockWorkspace(page, {
    name: "NativeEditor",
    workspace: false,
    sessions: [],
    seed: backendTabs([], [alpha, beta]),
    rpc: backendRpc({
      list: () => [alpha, beta].map((thread) => ({ id: thread.ref.backendID, label: thread.title, execution: true })),
      status: () => ({ authentication: null }),
      history: ({ ref }) => ({
        thread: ref.backendID === "alpha" ? alpha : beta,
        items: ref.backendID === "alpha" ? records : [],
      }),
      execution: ({ ref }) => ({ thread: ref.backendID === "alpha" ? alpha : beta, queue: [] }),
      send: async (input) => {
        calls.push(input)
        const previous = receipts.get(input.inputID)

        if (previous) return previous

        const admission: ConversationBackend.Admission = {
          status: "accepted",
          ref: input.ref,
          inputID: input.inputID,
          receipt: { nativeID: input.inputID, kind: "queued" },
        }

        receipts.set(input.inputID, admission)
        records.push({ id: input.inputID, turnID: "original-turn", kind: "user", text: input.text, partial: false })
        entered.resolve()
        await release.promise

        return admission
      },
    }),
  })
  await page.goto(backendHref(alpha.ref))
  const editor = page.locator('[data-component="composer-editor"]')
  const composer = page.getByRole("region", { name: "Backend message input" })
  await expect(editor).toBeEditable()
  await expect(page.locator('[data-action="composer-attach"]')).toHaveCount(0)
  expect(
    await editor.evaluate((element) => {
      const clipboard = new DataTransfer()
      clipboard.items.add(new File(["fixture"], "image.png", { type: "image/png" }))

      return element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }),
      )
    }),
  ).toBe(false)
  await expect(editor).toHaveText("")
  await editor.fill("First line")
  await editor.press("End")
  await editor.press("Shift+Enter")
  await editor.pressSequentially("Second line")
  const firstReply = page.waitForResponse(/\/api\/rpc\/experimental\.conversation\/send$/)
  await editor.press("Enter")
  await entered.promise
  await expect(editor).toHaveText("")
  await expect(composer.getByText("Sending message", { exact: true })).toBeVisible()
  await editor.fill("Alpha follow-up draft")
  await expect(composer.getByRole("button", { name: "Send", exact: true })).toBeDisabled()
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ ref: alpha.ref, text: "First line\nSecond line", delivery: "queue" })
  await expect
    .poll(() => readBackendDraft(page, SERVER, alpha.ref))
    .toMatchObject({ text: "Alpha follow-up draft", handoff: calls[0] })
  await page.screenshot({ path: test.info().outputPath("native-composer-pending.png"), fullPage: true })
  await page.locator("[data-titlebar-tab-title]", { hasText: beta.title }).click()
  await expect(editor).toHaveText("")
  await editor.fill("Beta draft")
  release.resolve()
  expect((await firstReply).ok()).toBe(true)
  await page.locator("[data-titlebar-tab-title]", { hasText: alpha.title }).click()
  await expect(editor).toHaveText("Alpha follow-up draft")
  await expect(composer.getByRole("button", { name: "Retry or check delivery" })).toBeEnabled()
  expect(calls).toHaveLength(1)
  await composer.getByRole("button", { name: "Retry or check delivery" }).click()
  await expect(composer.getByRole("status")).toHaveCount(0)
  await expect(
    page.getByRole("region", { name: "Conversation history" }).getByText("First line\nSecond line", { exact: true }),
  ).toBeVisible()
  await expect(editor).toHaveText("Alpha follow-up draft")
  expect(calls).toEqual([calls[0], calls[0]])
  expect(records).toHaveLength(1)
  await expect
    .poll(() => readBackendDraft(page, SERVER, alpha.ref))
    .toEqual({ text: "Alpha follow-up draft", handoff: undefined })
  await page.reload()
  await expect(editor).toHaveText("Alpha follow-up draft")
  await expect(composer.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
  expect(calls).toHaveLength(2)
  await page.locator("[data-titlebar-tab-title]", { hasText: beta.title }).click()
  await expect(editor).toHaveText("Beta draft")
  expect(sessions).toEqual([])
})

test("whole backend: direct guidance retains its turn guard and rejected text returns to the draft", async ({
  page,
}) => {
  const thread: ConversationBackend.Thread = {
    ref: { backendID: "native", threadID: "guided" },
    title: "Guided native task",
    state: "running",
  }

  let value: ConversationBackend.Execution = { thread, turn: { id: "first-turn", state: "running" }, queue: [] }
  const calls: ConversationBackend.Input[] = []
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const seen = new Set<string>()

  const workspace = await mockWorkspace(page, {
    name: "NativeGuidance",
    workspace: false,
    sessions: [],
    seed: backendTabs([], [thread]),
    rpc: backendRpc({
      list: () => [{ id: "native", label: thread.title, execution: true }],
      status: () => ({ authentication: null }),
      history: () => ({ thread, items: [] }),
      execution: () => value,
      send: async (input) => {
        calls.push(input)

        if (calls.length === 1) {
          entered.resolve()
          await released.promise

          return { status: "rejected", reason: "not-accepted", ref: input.ref, inputID: input.inputID }
        }

        if (input.delivery === "steer" && !seen.has(input.inputID)) {
          seen.add(input.inputID)

          return { status: "uncertain", ref: input.ref, inputID: input.inputID }
        }

        return {
          status: "accepted",
          ref: input.ref,
          inputID: input.inputID,
          receipt: {
            nativeID: input.delivery === "steer" ? "native-turn" : "native-queue",
            kind: input.delivery === "steer" ? "steered" : "queued",
          },
        }
      },
    }),
  })

  await page.goto(backendHref(thread.ref))
  const editor = page.locator('[data-component="composer-editor"]')
  const composer = page.getByRole("region", { name: "Backend message input" })
  await expect(editor).toBeEditable()
  await editor.fill("Adjust this task")
  await composer.locator('[data-action="composer-alternate-delivery"]').click()
  await entered.promise
  expect(calls[0]).toMatchObject({
    delivery: "steer",
    expectedTurnID: "first-turn",
    text: "Adjust this task",
    ref: thread.ref,
  })
  await editor.fill("Keep my next draft")
  released.resolve()
  await expect(editor).toHaveText("Adjust this task\n\nKeep my next draft")
  await expect(composer.getByRole("alert")).toContainText("did not accept this input")
  await expect(composer.getByRole("button", { name: "Retry or check delivery" })).toHaveCount(0)
  value = { ...value, turn: { id: "second-turn", state: "running" } }
  await workspace.push([backendEvent("activity", { ref: thread.ref, change: "execution" }, workspace.directory)])
  await editor.fill("Guide the next turn")
  await expect(composer.locator('[data-action="composer-alternate-delivery"]')).toBeEnabled()
  await editor.press("ControlOrMeta+Enter")
  await expect(composer.getByRole("button", { name: "Retry or check delivery" })).toBeEnabled()
  expect(calls[1]).toMatchObject({ delivery: "steer", expectedTurnID: "second-turn", text: "Guide the next turn" })
  await expect.poll(() => readBackendDraft(page, SERVER, thread.ref)).toMatchObject({ handoff: calls[1] })
  value = { ...value, turn: { id: "later-turn", state: "running" } }
  await page.reload()
  await expect(composer.getByRole("button", { name: "Retry or check delivery" })).toBeEnabled()
  expect(calls).toHaveLength(2)
  await composer.getByRole("button", { name: "Retry or check delivery" }).click()
  await expect(composer.getByRole("button", { name: "Retry or check delivery" })).toHaveCount(0)
  expect(calls[2]).toEqual(calls[1])
  value = { ...value, turn: { id: "later-turn", state: "completed" } }
  await workspace.push([backendEvent("activity", { ref: thread.ref, change: "execution" }, workspace.directory)])
  await editor.fill("A separate queued task")
  await expect(composer.locator('[data-action="composer-alternate-delivery"]')).toHaveCount(0)
  await editor.press("ControlOrMeta+Enter")
  await expect(composer.getByRole("alert")).toContainText("no available running turn")
  expect(calls).toHaveLength(3)
  await editor.press("Enter")
  await expect.poll(() => calls.length).toBe(4)
  expect(calls[3]).toMatchObject({ delivery: "queue", text: "A separate queued task" })
  expect(calls[3]).not.toHaveProperty("expectedTurnID")
})

test("whole backend: uncertain admission survives reload without automatic resend", async ({ page }) => {
  const thread: ConversationBackend.Thread = {
    ref: { backendID: "native", threadID: "uncertain-thread" },
    title: "Unconfirmed input",
    state: "idle",
  }

  const calls: ConversationBackend.Input[] = []
  let connected = true

  const workspace = await mockWorkspace(page, {
    name: "NativeUnknown",
    workspace: false,
    sessions: [],
    seed: backendTabs([], [thread]),
    rpc: backendRpc({
      list: () => (connected ? [{ id: thread.ref.backendID, label: thread.title, execution: true }] : []),
      status: () => ({ authentication: null }),
      history: () => ({ thread, items: [] }),
      execution: () => ({ thread, queue: [] }),
      send: (input) => {
        calls.push(input)

        return { status: "uncertain", ref: input.ref, inputID: input.inputID }
      },
    }),
  })

  await page.goto(backendHref(thread.ref))
  const editor = page.locator('[data-component="composer-editor"]')
  const composer = page.getByRole("region", { name: "Backend message input" })
  await expect(editor).toBeEditable()
  await editor.fill("A single native input")
  await editor.press("Enter")
  await expect(composer.getByRole("button", { name: "Retry or check delivery" })).toBeEnabled()
  await editor.fill("Keep this next draft")
  await expect
    .poll(() => readBackendDraft(page, SERVER, thread.ref))
    .toMatchObject({ text: "Keep this next draft", handoff: calls[0] })
  await page.reload()
  await expect(editor).toHaveText("Keep this next draft")
  await expect(composer.getByRole("button", { name: "Retry or check delivery" })).toBeEnabled()
  expect(calls).toHaveLength(1)
  connected = false
  await workspace.push([backendEvent("changed", {}, workspace.directory)])
  await expect(composer).toHaveCount(0)
  connected = true
  await workspace.push([backendEvent("changed", {}, workspace.directory)])
  await expect(editor).toHaveText("Keep this next draft")
  await expect(composer.getByRole("button", { name: "Retry or check delivery" })).toBeEnabled()
  expect(calls).toHaveLength(1)
  await composer.getByRole("button", { name: "Retry or check delivery" }).click()
  await expect(composer.getByRole("button", { name: "Retry or check delivery" })).toBeEnabled()
  expect(calls).toEqual([calls[0], calls[0]])
  await expect(composer.getByRole("button", { name: "Send", exact: true })).toBeDisabled()
  await expect(editor).toHaveText("Keep this next draft")
})

test("whole backend: native queue actions reconcile observations without Session admission", async ({ page }) => {
  const thread: ConversationBackend.Thread = {
    ref: { backendID: "native", threadID: "queue-thread" },
    title: "Native queue",
    state: "running",
  }

  let value: ConversationBackend.Execution = {
    thread,
    turn: { id: "active-turn", state: "running" },
    queue: ["First", "Second", "Third"].map((text) => ({ nativeID: text, inputID: text, text, partial: false })),
  }

  const controls: ConversationBackend.Control[] = []
  const admissions: string[] = []
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname

    if (request.method() === "POST" && (path === "/api/session" || /\/(prompt|send|create)$/.test(path)))
      admissions.push(path)
  })

  const workspace = await mockWorkspace(page, {
    name: "NativeQueue",
    workspace: false,
    sessions: [],
    seed: backendTabs([], [thread]),
    rpc: backendRpc({
      list: () => [{ id: thread.ref.backendID, label: "Native", execution: true }],
      status: () => ({ authentication: null }),
      history: () => ({ thread, items: [] }),
      execution: () => value,
      control: (backendID, action) => {
        expect(backendID).toBe(thread.ref.backendID)
        expect(action.threadID).toBe(thread.ref.threadID)
        controls.push(action)

        if (action.action === "reorder")
          value = {
            ...value,
            queue: action.nativeIDs.flatMap((id) => value.queue.filter((item) => item.nativeID === id)),
          }

        if (action.action === "guide" || action.action === "withdraw")
          value = { ...value, queue: value.queue.filter((item) => item.nativeID !== action.nativeID) }

        if (action.action === "withdraw") throw new Error("Response lost after native withdrawal")

        return { status: "applied" }
      },
    }),
  })

  await page.goto(backendHref(thread.ref))
  const panel = page.getByRole("region", { name: "Native execution and queue" })
  const rows = panel.locator('[data-component="session-queue-row"]')
  const texts = rows.locator('[data-action="session-queue-edit"]')
  await expect(texts).toHaveText(["First", "Second", "Third"])
  await expect(texts.filter({ hasText: "First" })).toBeEnabled()
  await expect(panel.locator('[data-action="session-queue-undo"]')).toHaveCount(3)
  await page.screenshot({ path: test.info().outputPath("whole-backend-pending.png"), fullPage: true })
  const first = rows.filter({ hasText: "First" })
  await first.getByRole("button", { name: "Reorder queued prompt" }).hover()
  await page.mouse.down()
  const target = await rows.filter({ hasText: "Third" }).boundingBox()

  if (!target) throw new Error("Native queue target is not visible")
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 })
  await page.mouse.up()
  await expect(texts).toHaveText(["Second", "Third", "First"])
  await rows.filter({ hasText: "Second" }).hover()
  await rows.filter({ hasText: "Second" }).locator('[data-action="session-queue-steer"]').click()
  await expect(texts).toHaveText(["Third", "First"])
  await rows.filter({ hasText: "Third" }).hover()
  await rows.filter({ hasText: "Third" }).locator('[data-action="session-queue-remove"]').click()
  await expect(texts).toHaveText(["First"])
  await expect(panel.getByRole("alert")).toContainText("Could not confirm the action")
  await expect(rows.getByRole("button", { name: "Reorder queued prompt" })).toBeDisabled()
  await panel.getByRole("button", { name: "Refresh execution" }).click()
  await expect(panel.getByRole("alert")).toHaveCount(0)
  await expect(rows.getByRole("button", { name: "Reorder queued prompt" })).toBeEnabled()
  expect(controls).toEqual([
    { action: "reorder", threadID: thread.ref.threadID, nativeIDs: ["Second", "Third", "First"] },
    { action: "guide", threadID: thread.ref.threadID, nativeID: "Second" },
    { action: "withdraw", threadID: thread.ref.threadID, nativeID: "Third" },
  ])
  value = { ...value, queue: [] }
  await workspace.push([backendEvent("activity", { ref: thread.ref, change: "execution" }, workspace.directory)])
  await expect(rows).toHaveCount(0)
  await expect(panel.getByText("Running", { exact: true })).toBeVisible()
  value = { thread: { ...thread, state: "idle" }, turn: { id: "active-turn", state: "completed" }, queue: [] }
  await workspace.push([backendEvent("activity", { ref: thread.ref, change: "execution" }, workspace.directory)])
  await expect(panel.getByText("Idle", { exact: true })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("whole-backend-queue.png"), fullPage: true })
  expect(admissions).toEqual([])
})

test("whole backend: queue edits preserve native IDs, draft stashes and unconfirmed edits across reload", async ({
  page,
}) => {
  const thread: ConversationBackend.Thread = {
    ref: { backendID: "native", threadID: "editable" },
    title: "Editable queue",
    state: "running",
  }

  let value: ConversationBackend.Execution = {
    thread,
    turn: { id: "active-turn", state: "running" },
    queue: ["First", "Second"].map((text) => ({ nativeID: text, inputID: text, text, partial: false })),
  }

  const actions: ConversationBackend.Control[] = []
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  let mode: "normal" | "held" | "unknown" = "normal"
  let sends = 0

  const workspace = await mockWorkspace(page, {
    name: "NativeQueueEdit",
    workspace: false,
    sessions: [],
    seed: backendTabs([], [thread]),
    rpc: backendRpc({
      list: () => [{ id: "native", label: thread.title, execution: true }],
      status: () => ({ authentication: null }),
      history: () => ({ thread, items: [] }),
      execution: () => value,
      send: (input) => {
        sends++

        return { status: "uncertain", ref: input.ref, inputID: input.inputID }
      },
      control: async (_, action) => {
        actions.push(action)

        if (action.action !== "update") throw new Error("Edit must update the original native input")

        if (mode === "held") {
          entered.resolve()
          await released.promise
        }

        value = {
          ...value,
          queue: value.queue.map((item) => (item.nativeID === action.nativeID ? { ...item, text: action.text } : item)),
        }

        if (mode === "unknown") throw new Error("Updated, but response lost")

        return { status: "applied" }
      },
    }),
  })

  await page.goto(backendHref(thread.ref))
  const panel = page.getByRole("region", { name: "Native execution and queue" })
  const editor = panel.locator('[data-component="composer-editor"]')
  const rows = panel.locator('[data-component="session-queue-row"]')
  await expect(editor).toBeEditable()
  await editor.fill("Keep the original draft")
  await rows.filter({ hasText: "First" }).locator('[data-action="session-queue-edit"]').click()
  await expect(editor).toHaveText("First")
  await editor.fill("First edited")
  await expect
    .poll(() => readBackendDraft(page, SERVER, thread.ref))
    .toMatchObject({
      text: "First edited",
      editing: { nativeID: "First", stash: { prompt: [{ content: "Keep the original draft" }] } },
    })
  await page.reload()
  await expect(editor).toHaveText("First edited")
  await expect(panel.getByText("Editing queued message", { exact: true })).toBeVisible()
  await editor.press("Escape")
  await expect(editor).toHaveText("Keep the original draft")
  await rows.filter({ hasText: "First" }).locator('[data-action="session-queue-edit"]').click()
  await editor.fill("First saved")
  await panel.getByRole("button", { name: "Save changes", exact: true }).click()
  await expect(editor).toHaveText("Keep the original draft")
  await expect(rows.locator('[data-action="session-queue-edit"]')).toHaveText(["First saved", "Second"])
  expect(value.queue.map((item) => item.nativeID)).toEqual(["First", "Second"])
  mode = "held"
  await rows.filter({ hasText: "First saved" }).locator('[data-action="session-queue-edit"]').click()
  await editor.fill("First second save")
  await editor.press("Enter")
  await entered.promise
  await editor.fill("A newer edit typed during saving")
  released.resolve()
  await expect(panel.getByRole("button", { name: "Save changes", exact: true })).toBeEnabled()
  await expect(editor).toHaveText("A newer edit typed during saving")
  await panel.getByRole("button", { name: "Cancel edit" }).click()
  await expect(editor).toHaveText("Keep the original draft")
  mode = "unknown"
  await rows.filter({ hasText: "First second save" }).locator('[data-action="session-queue-edit"]').click()
  await editor.fill("An uncertain saved edit")
  await editor.press("Enter")
  await expect(panel.getByText("Update unconfirmed.", { exact: false })).toBeVisible()
  await expect
    .poll(() => readBackendDraft(page, SERVER, thread.ref))
    .toMatchObject({ text: "An uncertain saved edit", editing: { nativeID: "First", unconfirmed: true } })
  await page.reload()
  await expect(editor).toHaveText("An uncertain saved edit")
  await expect(panel.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled()
  expect(actions).toHaveLength(3)
  await panel.getByRole("button", { name: "Cancel edit" }).click()
  await rows.filter({ hasText: "An uncertain saved edit" }).locator('[data-action="session-queue-edit"]').click()
  await editor.fill("Do not turn this into a new task")
  value = { ...value, queue: value.queue.filter((item) => item.nativeID !== "First") }
  await workspace.push([backendEvent("activity", { ref: thread.ref, change: "execution" }, workspace.directory)])
  await expect(rows.locator('[data-action="session-queue-edit"]')).toHaveText(["Second"])
  await editor.press("Enter")
  await expect(panel.getByRole("alert")).toContainText("no longer in the visible queue")
  await expect(editor).toHaveText("Do not turn this into a new task")
  expect(actions).toHaveLength(3)
  expect(sends).toBe(0)
  await page.screenshot({ path: test.info().outputPath("whole-backend-edit.png"), fullPage: true })
})

test("whole backend: undo restores only confirmed withdrawals and preserves unknown source text", async ({ page }) => {
  const alpha: ConversationBackend.Thread = {
    ref: { backendID: "alpha", threadID: "same-thread" },
    title: "Undo Alpha",
    state: "running",
  }

  const beta: ConversationBackend.Thread = { ...alpha, ref: { ...alpha.ref, backendID: "beta" }, title: "Undo Beta" }

  let value: ConversationBackend.Execution = {
    thread: alpha,
    turn: { id: "active-turn", state: "running" },
    queue: ["Restore", "Already consumed", "Unknown withdrawal", "Partial"].map((text) => ({
      nativeID: text.replaceAll(" ", "-"),
      inputID: text.replaceAll(" ", "-"),
      text,
      partial: text === "Partial",
    })),
  }

  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const actions: ConversationBackend.Control[] = []

  const workspace = await mockWorkspace(page, {
    name: "NativeQueueUndo",
    workspace: false,
    sessions: [],
    seed: backendTabs([], [alpha, beta]),
    rpc: backendRpc({
      list: () => [alpha, beta].map((thread) => ({ id: thread.ref.backendID, label: thread.title, execution: true })),
      status: () => ({ authentication: null }),
      history: ({ ref }) => ({ thread: ref.backendID === "alpha" ? alpha : beta, items: [] }),
      execution: ({ ref }) => (ref.backendID === "alpha" ? value : { thread: beta, queue: [] }),
      control: async (backendID, action) => {
        expect(backendID).toBe("alpha")
        actions.push(action)

        if (action.action !== "withdraw") throw new Error("Undo must withdraw exactly one native input")

        if (action.nativeID === "Restore") {
          entered.resolve()
          await released.promise
        }

        value = { ...value, queue: value.queue.filter((item) => item.nativeID !== action.nativeID) }

        if (action.nativeID === "Unknown-withdrawal") throw new Error("Native withdrawal response lost")

        return { status: action.nativeID === "Already-consumed" ? "not-found" : "applied" }
      },
    }),
  })

  await page.goto(backendHref(alpha.ref))
  const panel = page.getByRole("region", { name: "Native execution and queue" })
  const editor = panel.locator('[data-component="composer-editor"]')
  const rows = panel.locator('[data-component="session-queue-row"]')
  await expect(editor).toBeEditable()
  await editor.fill("Original draft")
  await rows.filter({ hasText: "Restore" }).hover()
  await rows.filter({ hasText: "Restore" }).locator('[data-action="session-queue-undo"]').click()
  await entered.promise
  await editor.fill("New draft while withdrawing")
  released.resolve()
  await expect(editor).toHaveText("New draft while withdrawing\n\nRestore")
  await rows.filter({ hasText: "Already consumed" }).hover()
  await rows.filter({ hasText: "Already consumed" }).locator('[data-action="session-queue-undo"]').click()
  await expect(panel.getByRole("alert")).toContainText("already left the queue")
  await expect(editor).toHaveText("New draft while withdrawing\n\nRestore")
  await rows.filter({ hasText: "Partial" }).locator('[data-action="session-queue-edit"]').click()
  await expect(panel.getByRole("alert")).toContainText("text editor cannot restore")
  expect(actions).toHaveLength(2)
  await rows.filter({ hasText: "Unknown withdrawal" }).hover()
  await rows.filter({ hasText: "Unknown withdrawal" }).locator('[data-action="session-queue-undo"]').click()
  await expect(panel.getByText("Withdrawal unconfirmed.", { exact: false })).toBeVisible()
  await expect(editor).toHaveText("New draft while withdrawing\n\nRestore")
  await expect
    .poll(() => readBackendDraft(page, SERVER, alpha.ref))
    .toMatchObject({
      text: "New draft while withdrawing\n\nRestore",
      withdrawal: { nativeID: "Unknown-withdrawal", text: "Unknown withdrawal" },
    })
  await page.reload()
  await expect(panel.getByText("Withdrawal unconfirmed.", { exact: false })).toBeVisible()
  await expect(panel.getByRole("button", { name: "Send", exact: true })).toBeDisabled()
  expect(actions).toHaveLength(3)
  await page
    .locator("[data-titlebar-tab-slot]")
    .filter({ has: page.locator("[data-titlebar-tab-title]", { hasText: "Undo Beta" }) })
    .locator("[data-titlebar-tab-link]")
    .click()
  await expect(editor).toHaveText("")
  await expect(panel.getByText("Withdrawal unconfirmed.", { exact: false })).toHaveCount(0)
  await page
    .locator("[data-titlebar-tab-slot]")
    .filter({ has: page.locator("[data-titlebar-tab-title]", { hasText: "Undo Alpha" }) })
    .locator("[data-titlebar-tab-link]")
    .click()
  await expect(editor).toHaveText("New draft while withdrawing\n\nRestore")
  await expect(panel.getByText("Withdrawal unconfirmed.", { exact: false })).toBeVisible()
  await panel.getByRole("button", { name: "Dismiss withdrawal record" }).click()
  await expect(panel.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
  expect(actions).toHaveLength(3)
  await workspace.push([backendEvent("activity", { ref: alpha.ref, change: "execution" }, workspace.directory)])
})

test("whole backend: stop targets the observed turn and late controls cannot cross native tabs", async ({ page }) => {
  const alpha: ConversationBackend.Thread = {
    ref: { backendID: "alpha", threadID: "same-thread" },
    title: "Stop Alpha",
    state: "running",
  }

  const beta: ConversationBackend.Thread = { ...alpha, ref: { ...alpha.ref, backendID: "beta" }, title: "Stop Beta" }
  let value: ConversationBackend.Execution = { thread: alpha, turn: { id: "first-turn", state: "running" }, queue: [] }
  const actions: { backendID: string; control: ConversationBackend.Control }[] = []

  let pending:
    | {
        entered: ReturnType<typeof Promise.withResolvers<void>>
        release: ReturnType<typeof Promise.withResolvers<void>>
      }
    | undefined = {
    entered: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
  }

  const workspace = await mockWorkspace(page, {
    name: "NativeStop",
    workspace: false,
    sessions: [],
    seed: backendTabs([], [alpha, beta]),
    rpc: backendRpc({
      list: () => [alpha, beta].map((thread) => ({ id: thread.ref.backendID, label: thread.title, execution: true })),
      status: () => ({ authentication: null }),
      history: ({ ref }) => ({ thread: ref.backendID === "alpha" ? alpha : beta, items: [] }),
      execution: ({ ref }) =>
        ref.backendID === "alpha" ? value : { thread: beta, turn: { id: "first-turn", state: "running" }, queue: [] },
      control: async (backendID, control) => {
        actions.push({ backendID, control })
        const held = pending

        if (held) {
          held.entered.resolve()
          await held.release.promise
          throw new Error("Native response not confirmed")
        }

        return { status: "applied" }
      },
    }),
  })

  await page.goto(backendHref(alpha.ref))
  const panel = page.getByRole("region", { name: "Native execution and queue" })
  const stop = panel.getByRole("button", { name: "Stop", exact: true })
  await expect(stop).toBeEnabled()
  await stop.click()
  await pending.entered.promise
  await expect(stop).toBeDisabled()
  value = { ...value, turn: { id: "next-turn", state: "running" } }
  await workspace.push([backendEvent("activity", { ref: alpha.ref, change: "execution" }, workspace.directory)])
  pending.release.resolve()
  await expect(panel.getByRole("alert")).toContainText("Could not confirm the action")
  await expect(stop).toBeDisabled()
  expect(actions).toEqual([
    { backendID: "alpha", control: { action: "interrupt", threadID: "same-thread", turnID: "first-turn" } },
  ])
  pending = undefined
  await panel.getByRole("button", { name: "Refresh execution" }).click()
  await expect(stop).toBeEnabled()
  await stop.click()
  await expect(stop).toBeEnabled()
  // The acknowledgement alone does not mark the backend idle or erase its native queue.
  await expect(panel.getByText("Running", { exact: true })).toBeVisible()
  expect(actions.at(-1)).toEqual({
    backendID: "alpha",
    control: { action: "interrupt", threadID: "same-thread", turnID: "next-turn" },
  })
  value = { thread: { ...alpha, state: "idle" }, turn: { id: "next-turn", state: "interrupted" }, queue: [] }
  await workspace.push([backendEvent("activity", { ref: alpha.ref, change: "execution" }, workspace.directory)])
  await expect(stop).toHaveCount(0)
  value = { thread: alpha, turn: { id: "last-turn", state: "running" }, queue: [] }
  await workspace.push([backendEvent("activity", { ref: alpha.ref, change: "execution" }, workspace.directory)])
  await expect(stop).toBeEnabled()
  pending = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
  await stop.click()
  await pending.entered.promise
  await page
    .locator("[data-titlebar-tab-slot]")
    .filter({ has: page.locator("[data-titlebar-tab-title]", { hasText: "Stop Beta" }) })
    .locator("[data-titlebar-tab-link]")
    .click()
  await expect(stop).toBeEnabled()
  pending.release.resolve()
  await workspace.push([backendEvent("activity", { ref: beta.ref, change: "execution" }, workspace.directory)])
  await expect(panel.getByRole("button", { name: "Refresh execution" })).toBeEnabled()
  await expect(panel.getByRole("alert")).toHaveCount(0)
  await expect(stop).toBeEnabled()
  expect(actions).toHaveLength(3)
  expect(actions.at(-1)).toEqual({
    backendID: "alpha",
    control: { action: "interrupt", threadID: "same-thread", turnID: "last-turn" },
  })
  await page.screenshot({ path: test.info().outputPath("whole-backend-stop.png"), fullPage: true })
})

test("whole backend: incomplete queues cannot reorder and late reads cannot cross native tabs", async ({ page }) => {
  const alpha: ConversationBackend.Thread = {
    ref: { backendID: "alpha", threadID: "same-thread" },
    title: "Alpha",
    state: "idle",
  }

  const beta: ConversationBackend.Thread = { ...alpha, ref: { ...alpha.ref, backendID: "beta" }, title: "Beta" }
  const arrived = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  let hold = false
  let reads = 0

  const workspace = await mockWorkspace(page, {
    name: "NativeQueueLifetime",
    workspace: false,
    sessions: [],
    seed: backendTabs([], [alpha, beta]),
    rpc: backendRpc({
      list: () => [alpha, beta].map((thread) => ({ id: thread.ref.backendID, label: thread.title, execution: true })),
      status: () => ({ authentication: null }),
      history: ({ ref }) => ({ thread: ref.backendID === "alpha" ? alpha : beta, items: [] }),
      execution: async ({ ref }) => {
        reads += 1

        if (ref.backendID === "alpha" && hold) {
          arrived.resolve()
          await released.promise
        }

        const thread = ref.backendID === "alpha" ? alpha : beta

        return {
          thread,
          queue: [{ nativeID: "same-input", inputID: "same-input", text: `${thread.title} pending`, partial: false }],
          nextCursor: "remaining",
        }
      },
    }),
  })

  await page.goto(backendHref(alpha.ref))
  const panel = page.getByRole("region", { name: "Native execution and queue" })
  await expect(panel.getByText("Alpha pending", { exact: true })).toBeVisible()
  await expect(panel.getByRole("button", { name: "Reorder queued prompt" })).toBeDisabled()
  await expect(panel.locator('[data-action="session-queue-steer"]')).toHaveCount(0)
  await expect(
    panel.getByText(
      "Only the first page of pending inputs is shown. Reordering is unavailable for an incomplete queue.",
    ),
  ).toBeVisible()
  hold = true
  await panel.getByRole("button", { name: "Refresh execution" }).click()
  await arrived.promise
  await page
    .locator("[data-titlebar-tab-slot]")
    .filter({ has: page.locator("[data-titlebar-tab-title]", { hasText: "Beta" }) })
    .locator("[data-titlebar-tab-link]")
    .click()
  await expect(panel.getByText("Beta pending", { exact: true })).toBeVisible()
  released.resolve()
  const before = reads
  await workspace.push([backendEvent("activity", { ref: alpha.ref, change: "execution" }, workspace.directory)])
  await workspace.push([backendEvent("activity", { ref: beta.ref, change: "execution" }, workspace.directory)])
  await expect.poll(() => reads).toBe(before + 1)
  await expect(panel.getByRole("button", { name: "Refresh execution" })).toBeEnabled()
  await expect(panel.getByText("Alpha pending", { exact: true })).toHaveCount(0)
  await expect(panel.getByText("Beta pending", { exact: true })).toBeVisible()
})

// The session.prompt payload, as the server's endpoint validates it.
const PromptBody = Schema.Struct({
  id: SessionMessage.ID.pipe(Schema.optional),
  ...PromptInput.Prompt.fields,
  metadata: SessionInbox.UserPayload.fields.metadata,
  delivery: SessionInbox.Delivery.pipe(Schema.optional),
  resume: Schema.Boolean.pipe(Schema.optional),
})

const decodePromptBody = Schema.decodeUnknownSync(PromptBody)

type InboxRow = {
  id: string
  sessionID: string
  time: { created: number }
  type: "user"
  payload: {
    text: string
    metadata?: typeof PromptBody.Type.metadata
    files?: Extract<SessionInboxInfo, { type: "user" }>["payload"]["files"]
    agents?: Extract<SessionInboxInfo, { type: "user" }>["payload"]["agents"]
  }
  delivery: SessionInbox.Delivery
}

function storedFile(file: NonNullable<typeof PromptBody.Type.files>[number]) {
  const inline = file.uri.startsWith("data:")

  const stored: NonNullable<InboxRow["payload"]["files"]>[number] = {
    data: inline ? file.uri.slice(file.uri.indexOf(",") + 1) : "",
    mime: inline ? file.uri.slice("data:".length, file.uri.indexOf(";")) : "text/plain",
    source: inline ? { type: "inline" } : { type: "uri", uri: file.uri },
    name: file.name,
    description: file.description,
    mention: file.mention,
  }

  return stored
}

function createQueueMock(seed: string[], messages: SessionMessageInfo[] = []) {
  const rows: InboxRow[] = seed.map((text, index) => ({
    id: `inb_seed_${index + 1}`,
    sessionID,
    time: { created: 1700000000000 + index },
    type: "user",
    payload: { text },
    delivery: "queue",
  }))

  const events: OpenCodeEvent[] = []
  const prompts: (typeof PromptBody.Type)[] = []
  const compactions: SessionInboxInfo[] = []
  const changes: { inboxID: string; action: "cancel" | "steer" | "queue" }[] = []
  const log: string[] = []
  // Live background shell commands (`GET /api/shell`).
  const shells: ShellInfo[] = []
  let sequence = 0

  const emit = <Type extends OpenCodeEvent["type"]>(
    type: Type,
    data: Extract<OpenCodeEvent, { type: Type }>["data"],
  ) => {
    sequence += 1
    // SAFETY: `type` selects `data` from the same OpenCodeEvent member, so the pair is that member.
    events.push({
      id: `evt_queue_${sequence}`,
      type,
      created: Date.now(),
      durable: { aggregateID: sessionID, seq: sequence, version: type === "session.tool.success" ? 2 : 1 },
      data,
    } as OpenCodeEvent)
  }

  return {
    rows,
    compactions,
    prompts,
    changes,
    log,
    messages,
    shells,
    emit,
    events: () => events.splice(0),
    onPrompt: (input: Parameters<NonNullable<MockServerConfig["onPrompt"]>>[0]) => {
      const body = decodePromptBody(input.body)
      prompts.push(body)
      log.push(`prompt:${body.delivery ?? "steer"}`)

      const row: InboxRow = {
        id: body.id ?? `inb_mock_${sequence}`,
        sessionID: input.sessionID,
        time: { created: Date.now() },
        type: "user",
        payload: { text: body.text },
        delivery: body.delivery ?? "steer",
      }

      if (body.metadata !== undefined) row.payload.metadata = body.metadata

      // Store attachments the way the server materializes them, so re-admissions round-trip.
      if (body.files !== undefined) row.payload.files = body.files.map(storedFile)

      if (body.agents !== undefined)
        row.payload.agents = body.agents.map((agent) => ({ name: agent.name, mention: agent.mention }))
      rows.push(row)
      emit("session.inbox.enqueued", {
        sessionID: input.sessionID,
        inboxID: row.id,
        item: { type: "user", payload: row.payload, delivery: row.delivery },
      })
    },
    onCompact: (input: Parameters<NonNullable<MockServerConfig["onCompact"]>>[0]) => {
      log.push("compact")
      compactions.push({
        id: Schema.decodeUnknownSync(SessionMessage.ID)(input.body.id),
        sessionID: input.sessionID,
        time: { created: Date.now() },
        type: "compaction",
        payload: {},
        delivery: "steer",
      })
    },
    onBackground: () => {
      log.push("background")
    },
    onInboxChange: (input: { sessionID: string; inboxID: string; action: "cancel" | "steer" | "queue" }) => {
      changes.push({ inboxID: input.inboxID, action: input.action })
      log.push(`${input.action}:${input.inboxID}`)
      const index = rows.findIndex((row) => row.id === input.inboxID)
      const row = rows[index]

      if (!row) return

      if (input.action === "cancel") {
        rows.splice(index, 1)
        emit("session.inbox.cancelled", { sessionID: input.sessionID, inboxID: input.inboxID })

        return
      }

      row.delivery = input.action
      emit("session.inbox.delivery.changed", {
        sessionID: input.sessionID,
        inboxID: input.inboxID,
        delivery: input.action,
      })
    },
  }
}

async function openQueue(
  page: Page,
  mock: ReturnType<typeof createQueueMock>,
  followUpBehavior?: "queue" | "steer",
  revert?: string,
  status: "idle" | "running" = "running",
  model = { id: "queue-model", name: "Queue Model" },
  workspace = true,
  extraSessions: { id: string; title: string }[] = [],
) {
  const options: Parameters<typeof openSession>[1] = {
    name: "SessionQueueRegression",
    workspace,
    sessions: [
      {
        id: sessionID,
        title: "Session queue regression",
        model: { id: model.id, providerID: "opencode" },
        revert: revert ? { messageID: revert } : undefined,
      },
      ...extraSessions,
    ],
    provider: provider(model),
    pageMessages: (id) => ({ items: id === sessionID ? mock.messages : [] }),
    sessionStatus: () => ({ [sessionID]: { type: status } }),
    inbox: () => [...mock.rows.map((row) => ({ ...row, payload: { ...row.payload } })), ...mock.compactions],
    onPrompt: mock.onPrompt,
    onCompact: mock.onCompact,
    onInboxChange: mock.onInboxChange,
    onBackground: mock.onBackground,
    shellCommands: () => mock.shells,
    events: mock.events,
  }

  if (followUpBehavior) options.seed = { settings: { general: { followUpBehavior } } }
  await openSession(page, options)
  const composer = page.locator('[data-component="composer"]')

  return {
    composer,
    input: composer.locator('[data-component="composer-editor"]'),
    rows: page.locator('[data-component="session-queue-row"]'),
  }
}

async function runSlash(page: Page, input: Awaited<ReturnType<typeof openQueue>>["input"], name: string) {
  await input.pressSequentially(`/${name}`)
  await expect(page.locator('[data-component="composer-suggestions"] [data-suggestion-id][data-active]')).toContainText(
    `/${name}`,
  )
  await input.press("Enter")
}

function userRow(page: Page, messageID: string) {
  return page.locator(
    `[data-timeline-virtual-content] [data-timeline-row="UserMessage"][data-message-id="${messageID}"]`,
  )
}

test("follow-up preference controls Enter while Mod+Enter uses the alternate delivery", async ({ page }) => {
  const mock = createQueueMock([])
  const view = await openQueue(page, mock, "queue")

  await view.input.fill("queue this follow-up")
  await expect(view.composer.locator('[data-action="composer-alternate-delivery"]')).toContainText("Steer")
  await view.input.press("Enter")
  await expect(view.rows.getByText("queue this follow-up", { exact: true })).toBeVisible()

  await view.input.fill("steer this correction")
  await view.input.press("ControlOrMeta+Enter")
  await expect.poll(() => mock.prompts.map((prompt) => prompt.delivery)).toEqual(["queue", "steer"])
  await expect(view.input).toHaveText("")
})

test("conversation host keeps an unacknowledged queued input in its own session across switching and reload", async ({
  page,
}) => {
  const mock = createQueueMock(
    [],
    [{ id: "msg_conversation_running", type: "user", text: "A request with no reply yet", time: { created: 1 } }],
  )

  const view = await openQueue(page, mock, "queue", undefined, "running", undefined, false, [
    { id: "ses_conversation_other", title: "Another conversation" },
  ])

  const held = await holdRoute(page, new RegExp(`/api/session/${sessionID}/prompt(\\?|$)`), { method: "POST" })

  try {
    await expect(userRow(page, "msg_conversation_running")).toBeVisible()
    await expect(view.rows).toHaveCount(0)
    await view.input.fill("Follow-up belongs to the first conversation")
    await view.input.press("Enter")
    await held.arrived
    await expect(view.input).toHaveText("")
    await expect(view.rows).toHaveCount(1)
    await expect(view.rows).toContainText("Follow-up belongs to the first conversation")
    // A queued submission never first masquerades as delivered transcript content.
    await expect(page.locator('[data-timeline-row="UserMessage"]', { hasText: "Follow-up belongs to" })).toHaveCount(0)
    expect(mock.prompts).toEqual([])

    await page.locator("[data-titlebar-tab-title]", { hasText: "Another conversation" }).click()
    await expect(view.input).toBeEditable()
    await expect(view.rows).toHaveCount(0)
    await view.input.fill("Unsent draft in the other conversation")
    held.release()
    await expect
      .poll(() => mock.prompts.map((prompt) => prompt.text))
      .toEqual(["Follow-up belongs to the first conversation"])
    await expect(view.input).toHaveText("Unsent draft in the other conversation")
    await expect(view.rows).toHaveCount(0)

    await page.locator("[data-titlebar-tab-title]", { hasText: "Session queue regression" }).click()
    await expect(view.input).toHaveText("")
    await expect(view.rows).toHaveCount(1)
    await expect(view.rows).toContainText("Follow-up belongs to the first conversation")
    await page.reload()
    await expect(view.input).toBeEditable()
    await expect(view.rows).toHaveCount(1)
    await expect(view.rows).toContainText("Follow-up belongs to the first conversation")
    expect(mock.prompts).toHaveLength(1)
    expect(mock.changes).toEqual([])
  } finally {
    held.release()
  }
})

test("conversation host shows an idle submission before admission without a phantom queue", async ({ page }) => {
  const mock = createQueueMock([])
  const view = await openQueue(page, mock, "queue", undefined, "idle", undefined, false)
  const held = await holdRoute(page, new RegExp(`/api/session/${sessionID}/prompt(\\?|$)`), { method: "POST" })

  try {
    await view.input.fill("Start a fresh conversation turn")
    await view.input.press("Enter")
    await held.arrived
    await expect(view.input).toHaveText("")
    const row = page.locator('[data-timeline-row="UserMessage"]', { hasText: "Start a fresh conversation turn" })
    await expect(row).toBeVisible()
    await expect(view.rows).toHaveCount(0)
    await expect(page.locator('[data-component="session-queue-panel"]')).toHaveCount(0)
    expect(mock.prompts).toEqual([])
    held.release()
    await expect.poll(() => mock.prompts.length).toBe(1)
    expect(mock.prompts[0].delivery).toBe("steer")
    await expect(row).toHaveCount(1)
    await expect(view.rows).toHaveCount(0)
  } finally {
    held.release()
  }
})

test("a steer shows as pending in the timeline as the composer clears, before the server admits it", async ({
  page,
}) => {
  // The running execution has delivered input, so a new steer waits behind its work.
  const mock = createQueueMock(
    [],
    [{ id: "msg_queue_delivered", type: "user", text: "First prompt", time: { created: 1 } }],
  )

  const view = await openQueue(page, mock, "steer")
  const commit = await holdRoute(page, (url) => url.pathname === `/api/session/${sessionID}/prompt`, { method: "POST" })

  const prompt = page.locator('[data-timeline-virtual-content] [data-timeline-row="UserMessage"]', {
    hasText: "steer while the model commits",
  })

  await expect(userRow(page, "msg_queue_delivered")).toContainText("First prompt")
  await view.input.fill("steer while the model commits")
  await view.input.press("Enter")
  await commit.arrived
  await expect(view.input).toHaveText("")
  await expect(prompt).toBeVisible()
  await expect(prompt.locator('[data-component="user-message"]')).toHaveAttribute("data-pending", "true")
  // It turns pending at once rather than fading from the delivered color it may have rendered with first.
  await expect(prompt.locator('[data-slot="user-message-text"]')).toHaveCSS("transition-duration", "0s")
  expect(mock.prompts).toEqual([])

  commit.release()
  await expect.poll(() => mock.prompts.map((item) => item.text)).toEqual(["steer while the model commits"])
  await expect(prompt).toHaveCount(1)
  await expect(prompt.locator('[data-component="user-message"]')).toHaveAttribute("data-pending", "true")
})

test("a steer into an idle session leaves the finished turn finished until delivery", async ({ page }) => {
  const mock = createQueueMock(
    [],
    [
      { id: "msg_queue_finished_user", type: "user", text: "Inspect the queue.", time: { created: 1700000000000 } },
      {
        id: "msg_queue_finished_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "queue-model", providerID: "opencode" },
        content: [{ type: "text", text: "The queue is fine." }],
        finish: "stop",
        time: { created: 1700000000001, completed: 1700000000002 },
      },
      { id: "msg_queue_finished_idle", type: "idle", outcome: "succeeded", time: { created: 1700000000003 } },
    ],
  )

  const view = await openQueue(page, mock, "steer", undefined, "idle")
  const finished = page.getByRole("button", { name: "Copy response" })
  await expect(finished).toHaveCount(1)

  await view.input.fill("start the next turn")
  await view.input.press("Enter")
  await expect.poll(() => mock.prompts.map((item) => item.text)).toEqual(["start the next turn"])
  await expect(
    page.locator('[data-timeline-virtual-content] [data-timeline-row="UserMessage"]', {
      hasText: "start the next turn",
    }),
  ).toBeVisible()
  // The admitted steer waits for delivery; the finished turn above it keeps its copy action and duration.
  await expect(finished).toHaveCount(1)
})

for (const count of [2, 6]) {
  test(`dragging reorders ${count} queued prompts without bouncing`, async ({ page }) => {
    const order = Array.from({ length: count }, (_, index) => `queued prompt ${index + 1}`)
    const mock = createQueueMock(order)
    mock.rows[0].payload.files = [
      { data: "aGk=", mime: "text/plain", source: { type: "uri", uri: "file:///repo/main.ts" }, name: "main.ts" },
    ]
    const view = await openQueue(page, mock)
    await expect(view.rows).toHaveCount(count)
    const texts = view.rows.locator('[data-action="session-queue-edit"]')
    const panel = page.locator('[data-component="session-queue-panel"]')
    const height = await panel.evaluate((el) => el.getBoundingClientRect().height)

    const geometry = await panel.evaluateHandle((el) => {
      const heights = [el.getBoundingClientRect().height]
      const observer = new ResizeObserver(() => heights.push(el.getBoundingClientRect().height))
      observer.observe(el)

      return { heights, stop: () => observer.disconnect() }
    })

    const admission = await holdRoute(page, new RegExp(`/api/session/${sessionID}/prompt(\\?|$)`), { method: "POST" })

    const cancellation = await holdRoute(page, new RegExp(`/api/session/${sessionID}/inbox/[^/?]+(\\?|$)`), {
      method: "DELETE",
    })

    const first = view.rows.filter({ hasText: order[0] })
    const targetIndex = Math.min(2, count - 1)
    const destination = view.rows.filter({ hasText: order[targetIndex] })
    await first.getByRole("button", { name: "Reorder queued prompt" }).hover()
    await page.mouse.down()
    const target = await destination.boundingBox()

    if (!target) throw new Error("The target queue row is not visible")
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 })
    await page.mouse.up()

    const reordered = [...order.slice(1, targetIndex + 1), order[0], ...order.slice(targetIndex + 1)]
    await admission.arrived
    await expect(texts).toHaveText(reordered)
    await expect(view.rows).toHaveCount(count)
    admission.release()

    // All replacements are admitted while the originals still exist. Neither copies nor extra height may leak out.
    await cancellation.arrived
    await expect(texts).toHaveText(reordered)
    await expect(view.rows).toHaveCount(count)

    const reconciliation = await holdRoute(page, new RegExp(`/api/session/${sessionID}/inbox(\\?|$)`), {
      method: "GET",
    })

    cancellation.release()
    await reconciliation.arrived
    await expect(texts).toHaveText(reordered)
    await expect(view.rows).toHaveCount(count)
    reconciliation.release()
    await expect(
      view.rows.filter({ hasText: order[1] }).getByRole("button", { name: "Remove", exact: true }),
    ).toBeEnabled()
    await expect(texts).toHaveText(reordered)
    expect(
      await geometry.evaluate((value) => {
        value.stop()

        return Math.max(...value.heights) - Math.min(...value.heights)
      }),
    ).toBeLessThanOrEqual(1)
    expect(await panel.evaluate((el) => el.getBoundingClientRect().height)).toBeCloseTo(height, 0)
    await geometry.dispose()
    expect(mock.prompts.map((prompt) => prompt.text)).toEqual(reordered)
    // A re-admitted file keeps the URI it came from instead of becoming an inline snapshot.
    expect(mock.prompts[targetIndex].files).toMatchObject([{ uri: "file:///repo/main.ts", name: "main.ts" }])
    expect(mock.changes).toEqual(order.map((_, index) => ({ inboxID: `inb_seed_${index + 1}`, action: "cancel" })))
    // The handoff must leave actions targeting the new inbox IDs, not the optimistic row keys.
    await view.rows.getByText(order[0], { exact: true }).click()
    await expect(view.input).toHaveText(order[0])
  })
}

test("a partially cancelled reorder reconciles the server's queue instead of restoring stale rows", async ({
  page,
}) => {
  const mock = createQueueMock(["first queued prompt", "second queued prompt"])
  const change = mock.onInboxChange
  mock.onInboxChange = (input) => {
    if (input.inboxID === "inb_seed_2") throw new Error("Cancellation failed")
    change(input)
  }

  const view = await openQueue(page, mock)
  await expect(view.rows).toHaveCount(2)
  const admission = await holdRoute(page, new RegExp(`/api/session/${sessionID}/prompt(\\?|$)`), { method: "POST" })
  const first = view.rows.filter({ hasText: "first queued prompt" })
  const second = view.rows.filter({ hasText: "second queued prompt" })
  await first.getByRole("button", { name: "Reorder queued prompt" }).hover()
  await page.mouse.down()
  const target = await second.boundingBox()

  if (!target) throw new Error("The target queue row is not visible")
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 })
  await page.mouse.up()
  await admission.arrived
  await expect(view.rows.locator('[data-action="session-queue-edit"]')).toHaveText([
    "second queued prompt",
    "first queued prompt",
  ])
  admission.release()

  // One original survived alongside the replacements: do not pretend the failed rewrite was rolled back.
  await expect(view.rows.locator('[data-action="session-queue-edit"]')).toHaveText([
    "second queued prompt",
    "second queued prompt",
    "first queued prompt",
  ])
  await expect(first.getByRole("button", { name: "Remove", exact: true })).toBeEnabled()
  await first.getByRole("button", { name: "Remove", exact: true }).click()
  await expect.poll(() => mock.changes.at(-1)).toEqual({ inboxID: mock.prompts[1].id, action: "cancel" })
})

for (const change of ["reorder", "edit"] as const) {
  test(`a ${change} that cannot re-admit a prompt leaves the queue unchanged`, async ({ page }) => {
    const order = ["first queued prompt", "second queued prompt", "third queued prompt"]
    const mock = createQueueMock(order)
    const admit = mock.onPrompt
    // The last prompt's re-admission fails after the server admitted it, so its response is lost.
    mock.onPrompt = (input) => {
      admit(input)

      if (input.body.text === order[2]) throw new Error("Connection lost after admission")
    }

    const view = await openQueue(page, mock)
    await expect(view.rows).toHaveCount(3)

    if (change === "reorder") {
      const first = view.rows.filter({ hasText: order[0] })
      const second = view.rows.filter({ hasText: order[1] })
      await first.getByRole("button", { name: "Reorder queued prompt" }).hover()
      await page.mouse.down()
      const target = await second.boundingBox()

      if (!target) throw new Error("The target queue row is not visible")
      await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 })
      await page.mouse.up()
    }

    if (change === "edit") {
      await view.rows.getByText(order[1], { exact: true }).click()
      await expect(view.input).toHaveText(order[1])
      await expect(view.input).toBeFocused()
      await view.input.press("End")
      await view.input.pressSequentially(", edited")
      await view.input.press("Enter")
    }

    // The replacements admitted before the failure are withdrawn; the originals stay in place.
    await expect.poll(() => mock.log.includes(`cancel:${mock.prompts.at(-1)?.id}`)).toBe(true)
    await expect.poll(() => mock.changes.length).toBe(mock.prompts.length)
    expect(mock.changes.every((entry) => entry.action === "cancel" && !entry.inboxID.startsWith("inb_seed_"))).toBe(
      true,
    )
    await expect(view.rows.locator('[data-action="session-queue-edit"]')).toHaveText(order)
    expect(mock.rows.map((row) => row.payload.text)).toEqual(order)
    await expect(
      view.rows.filter({ hasText: order[0] }).getByRole("button", { name: "Remove", exact: true }),
    ).toBeEnabled()

    // A failed edit keeps its draft in the composer so nothing typed is lost.
    if (change === "edit") await expect(view.input).toHaveText("second queued prompt, edited")
  })
}

test("editing restores the existing draft and replaces only the original queue position", async ({ page }) => {
  const mock = createQueueMock(["first queued prompt", "tighten the error copy", "third queued prompt"])
  const view = await openQueue(page, mock)
  const original = view.rows.getByText("tighten the error copy", { exact: true })
  await expect(original).toBeVisible()

  await view.input.fill("my in-progress draft")
  await original.click()
  await expect(view.input).toHaveText("tighten the error copy")
  await expect(view.input).toBeFocused()
  await view.input.press("Escape")
  await expect(view.input).toHaveText("my in-progress draft")

  await original.click()
  await expect(view.input).toHaveText("tighten the error copy")
  await expect(view.input).toBeFocused()
  // fill() on a composer that holds text can append, so extend the loaded text instead.
  await view.input.press("End")
  await view.input.pressSequentially(" and add a retry hint")
  await expect(view.input).toHaveText("tighten the error copy and add a retry hint")
  await view.input.press("Enter")

  await expect(view.rows.locator('[data-action="session-queue-edit"]')).toHaveText([
    "first queued prompt",
    "tighten the error copy and add a retry hint",
    "third queued prompt",
  ])
  await expect(view.input).toHaveText("my in-progress draft")
  // The strip shows the edit before the server confirms it; wait for the rewrite to finish.
  await expect.poll(() => mock.changes.length).toBe(2)
  // One rewrite from the edited position: the replacement, then the prompts after it.
  expect(mock.prompts.map((prompt) => prompt.text)).toEqual([
    "tighten the error copy and add a retry hint",
    "third queued prompt",
  ])
  expect(mock.prompts.every((prompt) => prompt.delivery === "queue" && prompt.resume === false)).toBe(true)
  expect(mock.changes).toEqual([
    { inboxID: "inb_seed_3", action: "cancel" },
    { inboxID: "inb_seed_2", action: "cancel" },
  ])
  expect(mock.log[0]).toBe("prompt:queue")
})

for (const delivery of ["queue", "steer"] as const) {
  test(`editing a prompt the server delivered meanwhile keeps the edit draft (${delivery})`, async ({ page }) => {
    const mock = createQueueMock(["first queued prompt", "second queued prompt"])
    const view = await openQueue(page, mock, "queue")
    await view.rows.getByText("second queued prompt", { exact: true }).click()
    await expect(view.input).toHaveText("second queued prompt")
    await expect(view.input).toBeFocused()
    await view.input.press("End")
    await view.input.pressSequentially(", edited")
    // The server delivers the original before the edit lands; this client has not heard yet.
    mock.rows.splice(1, 1)
    await view.input.press(delivery === "queue" ? "Enter" : "ControlOrMeta+Enter")

    await expect(page.getByText("Request failed")).toBeVisible()
    await expect(view.input).toHaveText("second queued prompt, edited")
    expect(mock.prompts).toEqual([])
    expect(mock.changes).toEqual([])
  })
}

for (const change of ["reorder", "edit"] as const) {
  test(`a staged revert refuses a queue ${change}, whose admission would commit it`, async ({ page }) => {
    const order = ["first queued prompt", "second queued prompt"]

    const mock = createQueueMock(order, [
      { id: "msg_queue_delivered", type: "user", text: "First prompt", time: { created: 1 } },
    ])

    const view = await openQueue(page, mock, undefined, "msg_queue_delivered")
    await expect(view.rows).toHaveCount(2)

    if (change === "reorder") {
      await view.rows.filter({ hasText: order[0] }).getByRole("button", { name: "Reorder queued prompt" }).hover()
      await page.mouse.down()
      const target = await view.rows.filter({ hasText: order[1] }).boundingBox()

      if (!target) throw new Error("The target queue row is not visible")
      await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 })
      await page.mouse.up()
    }

    if (change === "edit") await view.rows.getByText(order[1], { exact: true }).click()

    await expect(page.getByText("Redo the revert before you reorder or edit queued prompts")).toBeVisible()
    await expect(view.rows.locator('[data-action="session-queue-edit"]')).toHaveText(order)
    await expect(view.input).toHaveText("")
    expect(mock.prompts).toEqual([])
    expect(mock.changes).toEqual([])
  })
}

for (const delivery of ["steer", "queue"] as const) {
  test(`an edit sent as a ${delivery} stays interactive while the server is slow to confirm it`, async ({ page }) => {
    const mock = createQueueMock(["first queued prompt", "second queued prompt"])
    mock.rows[1].payload.files = [
      {
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==",
        mime: "image/png",
        source: { type: "inline" },
        name: "shot.png",
      },
    ]
    const view = await openQueue(page, mock)
    // A loaded server answers admissions and cancellations late; hold both until the strip is checked.
    const admission = await holdRoute(page, new RegExp(`/api/session/${sessionID}/prompt(\\?|$)`), { method: "POST" })

    const cancellation = await holdRoute(page, new RegExp(`/api/session/${sessionID}/inbox/[^/?]+(\\?|$)`), {
      method: "DELETE",
    })

    const texts = view.rows.locator('[data-action="session-queue-edit"]')

    await view.rows.getByText("second queued prompt", { exact: true }).click()
    await expect(view.input).toHaveText("second queued prompt")
    await expect(view.composer.getByRole("img", { name: "shot.png" })).toBeVisible()
    await expect(view.input).toBeFocused()
    await view.input.press("End")
    await view.input.pressSequentially(", edited")
    await view.input.press(delivery === "queue" ? "Enter" : "ControlOrMeta+Enter")
    await admission.arrived

    // The composer is free at once and the strip shows the edit, pending, in the original's place.
    const edited = view.rows.filter({ hasText: "second queued prompt, edited" })
    await expect(view.input).toHaveText("")
    await expect(texts).toHaveText(["first queued prompt", "second queued prompt, edited"])
    await expect(edited).toHaveAttribute("aria-busy", "true")

    // Clicking the pending row is ignored; another row still opens, and its edit waits its turn.
    await edited.locator('[data-action="session-queue-edit"]').click({ force: true })
    await expect(view.input).toHaveText("")
    await view.rows.getByText("first queued prompt", { exact: true }).click()
    await expect(view.input).toHaveText("first queued prompt")
    await expect(view.input).toBeFocused()
    await view.input.press("End")
    await view.input.pressSequentially(", edited too")
    await view.input.press("Enter")
    await expect(view.input).toHaveText("")
    // Until the server answers, a steered edit also waits in the strip.
    await expect(texts).toHaveText(["first queued prompt, edited too", "second queued prompt, edited"])

    const final =
      delivery === "queue"
        ? ["first queued prompt, edited too", "second queued prompt, edited"]
        : ["first queued prompt, edited too"]

    admission.release()
    await cancellation.arrived
    cancellation.release()

    await expect(texts).toHaveText(final)
    await expect(view.rows.and(page.locator('[aria-busy="true"]'))).toHaveCount(0)
    // The steered or queued edit was admitted once, with its attachment, and no original is left.
    expect(mock.prompts[0]).toMatchObject({ text: "second queued prompt, edited", delivery })
    expect(mock.prompts[0].files?.map((file) => file.uri.startsWith("data:image/png;"))).toEqual([true])
    await expect
      .poll(() => mock.rows.filter((row) => row.delivery === "queue").map((row) => row.payload.text))
      .toEqual(final)
    expect(mock.rows.filter((row) => row.delivery === "steer").map((row) => row.payload.text)).toEqual(
      delivery === "steer" ? ["second queued prompt, edited"] : [],
    )
    await expect(view.input).toHaveText("")
  })
}

test("editing drops a file whose mention was deleted and keeps unmentioned context", async ({ page }) => {
  const mock = createQueueMock(["inspect @main.ts here"])
  mock.rows[0].payload.files = [
    {
      data: "aGk=",
      mime: "text/plain",
      source: { type: "uri", uri: "file:///repo/main.ts" },
      name: "main.ts",
      mention: { start: 8, end: 16, text: "@main.ts" },
    },
    { data: "bm90ZXM=", mime: "text/plain", source: { type: "uri", uri: "file:///repo/notes.md" }, name: "notes.md" },
  ]
  const view = await openQueue(page, mock)
  await view.rows.getByText("inspect @main.ts here", { exact: true }).click()
  await expect(view.input).toHaveText("inspect @main.ts here")
  // The edit focuses the composer a frame after loading it; keys sent earlier miss it.
  await expect(view.input).toBeFocused()
  await view.input.press("ControlOrMeta+a")
  await view.input.pressSequentially("inspect here")
  await view.input.press("Enter")

  await expect.poll(() => mock.prompts.length).toBe(1)
  expect(mock.prompts[0].files?.map((file) => file.uri)).toEqual(["file:///repo/notes.md"])
})

test("editing a comment-only prompt keeps its notes once", async ({ page }) => {
  const note = "The user made the following comment regarding line 2 of /repo/app.ts: check the guard"
  const mock = createQueueMock([note])
  mock.rows[0].payload.files = [
    {
      data: "aGk=",
      mime: "text/plain",
      source: { type: "uri", uri: "file:///repo/app.ts?start=2&end=2" },
      name: "app.ts",
    },
  ]
  mock.rows[0].payload.metadata = {
    displayText: "",
    comments: [
      {
        path: "/repo/app.ts",
        comment: "check the guard",
        selection: { startLine: 2, startChar: 0, endLine: 2, endChar: 0 },
        origin: "review",
      },
    ],
  }
  const view = await openQueue(page, mock)
  // The queue counts the context file; the existing editor still loads its model-visible note as text.
  await view.rows.getByRole("button", { name: "1 attachment", exact: true }).click()
  await expect(view.input).toHaveText(note)
  await view.input.press("End")
  await view.input.pressSequentially(", please")
  await expect(view.input).toHaveText(`${note}, please`)
  await view.input.press("Enter")

  await expect.poll(() => mock.prompts.length).toBe(1)
  expect(mock.prompts[0].text).toBe(`${note}, please`)
  expect(mock.prompts[0].metadata).toMatchObject({ displayText: `${note}, please`, comments: [] })
})

test("Undo cancels only the selected queued prompt and focuses the restored input", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const text = "Review the detailed error report and check every step of the retry path ".repeat(4)
  const rest = ["first queued prompt", ...Array.from({ length: 5 }, (_, index) => `queued follow-up ${index + 1}`)]
  const mock = createQueueMock([...rest.slice(0, 1), text, ...rest.slice(1)])
  const view = await openQueue(page, mock)
  await expect(view.rows).toHaveCount(7)

  // A long prompt in a long queue on a narrow screen keeps its icon-only Undo usable.
  const undo = view.rows.filter({ hasText: text }).getByRole("button", { name: "Undo" })
  await expect(undo).toHaveText("")
  await undo.hover()
  await expect(page.getByRole("tooltip")).toHaveText("Undo")
  await undo.click()
  await expect(view.rows.locator('[data-action="session-queue-edit"]')).toHaveText(rest)
  await expect(view.input).toHaveText(text)
  await expect(view.input).toBeFocused()
  expect(mock.changes).toEqual([{ inboxID: "inb_seed_2", action: "cancel" }])
  expect(mock.prompts).toEqual([])
})

test("Undo appends to an existing draft and restores inline attachments", async ({ page }) => {
  const mock = createQueueMock(["queued with image"])
  mock.rows[0].payload.files = [
    {
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==",
      mime: "image/png",
      source: { type: "inline" },
      name: "shot.png",
    },
  ]
  const view = await openQueue(page, mock)
  await view.input.fill("my draft")
  await view.rows.getByRole("button", { name: "Undo" }).click()
  await expect(view.rows).toHaveCount(0)
  await expect(view.input).toHaveText("my draft\n\nqueued with image")
  await expect(view.input).toBeFocused()
  await expect(view.composer.getByRole("img", { name: "shot.png" })).toBeVisible()
  expect(mock.changes).toEqual([{ inboxID: "inb_seed_1", action: "cancel" }])
})

test("Undo of a comment-only prompt keeps the draft text and restores the comment once", async ({ page }) => {
  const comment = "check the guard"
  const mock = createQueueMock([`The user made the following comment regarding line 2 of /repo/app.ts: ${comment}`])
  mock.rows[0].payload.metadata = {
    displayText: "",
    comments: [
      {
        path: "/repo/app.ts",
        comment,
        selection: { startLine: 2, startChar: 0, endLine: 2, endChar: 0 },
        origin: "review",
      },
    ],
  }
  mock.rows[0].payload.files = [
    {
      data: "aGk=",
      mime: "text/plain",
      source: { type: "uri", uri: "file:///repo/app.ts?start=2&end=2" },
      name: "app.ts",
    },
  ]
  const view = await openQueue(page, mock)
  await view.input.fill("my draft")
  await view.rows.getByRole("button", { name: "Undo" }).click()

  await expect(view.rows).toHaveCount(0)
  await expect(view.input).toHaveText("my draft")
  const cards = view.composer.locator('[data-component="composer-attachments"] [data-component="attachment-card"]')
  await expect(cards).toHaveCount(1)
  await expect(cards).toContainText(comment)

  // The resubmission carries the draft text with no stray break and the comment's file exactly once.
  await view.input.press("Enter")
  await expect.poll(() => mock.prompts.length).toBe(1)
  expect(mock.prompts[0].text).toBe(
    `my draft\nThe user made the following comment regarding line 2 of /repo/app.ts: ${comment}`,
  )
  expect(mock.prompts[0].files?.map((file) => file.uri)).toEqual(["file:///repo/app.ts?start=2&end=2"])
})

test("Undo preserves mentioned file and agent references on resubmission", async ({ page }) => {
  const mock = createQueueMock(["inspect @main.ts with @build"])
  mock.rows[0].payload.files = [
    {
      data: "aGk=",
      mime: "text/plain",
      source: { type: "uri", uri: "file:///repo/main.ts" },
      name: "main.ts",
      mention: { start: 8, end: 16, text: "@main.ts" },
    },
  ]
  mock.rows[0].payload.agents = [{ name: "build", mention: { start: 22, end: 28, text: "@build" } }]
  const view = await openQueue(page, mock)
  await view.rows.getByRole("button", { name: "Undo" }).click()
  await expect(view.input).toHaveText("inspect @main.ts with @build")
  await view.input.press("Enter")
  await expect.poll(() => mock.prompts.length).toBe(1)
  // Like the TUI, a restored mention points at the file it named rather than a snapshot of it.
  expect(mock.prompts[0].files).toMatchObject([
    { uri: "file:///repo/main.ts", mention: { text: "@main.ts", start: 8, end: 16 } },
  ])
  expect(mock.prompts[0].agents).toMatchObject([{ name: "build", mention: { text: "@build" } }])
})

for (const delivery of ["queue", "steer"] as const) {
  test(`${delivery === "queue" ? "Undo" : "/undo of a pending steer"} keeps unmentioned file context`, async ({
    page,
  }) => {
    // Another client (for example ACP) can attach a file without mentioning it.
    const mock = createQueueMock(["inspect this file"])
    const inboxID = mock.rows[0].id
    mock.rows[0].delivery = delivery
    mock.rows[0].payload.files = [
      {
        data: "aGk=",
        mime: "text/plain",
        source: { type: "uri", uri: "file:///repo/main.ts" },
        name: "main.ts",
        description: "the failing version",
      },
    ]
    const view = await openQueue(page, mock)

    if (delivery === "queue") await view.rows.getByRole("button", { name: "Undo" }).click()

    if (delivery === "steer") {
      await expect(userRow(page, inboxID)).toContainText("inspect this file")
      await runSlash(page, view.input, "undo")
    }

    // Like the TUI, the file returns attached without a mention, as a chip rather than prompt text.
    const chip = view.composer.locator('[data-slot="composer-context-file"]')

    await expect(view.input).toHaveText("inspect this file")
    await expect(chip).toHaveCount(1)
    await expect(chip).toContainText("main.ts")
    expect(mock.changes).toEqual([{ inboxID, action: "cancel" }])

    // Like the TUI's blank Enter, a chip alone sends nothing: without text the draft reads as blank.
    await expect(view.input).toBeFocused()
    await view.input.press("ControlOrMeta+a")
    await view.input.press("Backspace")
    await expect(view.input).toHaveText("")
    await expect(view.composer.locator('[data-action="composer-submit"]')).toHaveAttribute("aria-label", "Stop")
    await expect(chip).toHaveCount(1)

    await view.input.pressSequentially("inspect this file")
    await view.input.press("Enter")
    await expect.poll(() => mock.prompts.length).toBe(1)
    expect(mock.prompts[0].files).toMatchObject([
      { uri: "file:///repo/main.ts", name: "main.ts", description: "the failing version" },
    ])
    expect(mock.prompts[0].files?.[0]?.mention).toBeUndefined()
    await expect(chip).toHaveCount(0)
  })
}

test("reverting to another prompt replaces the file chips of an earlier restore", async ({ page }) => {
  const mock = createQueueMock(
    [],
    [
      { id: "msg_queue_first", type: "user", text: "First prompt", time: { created: 1 } },
      {
        id: "msg_queue_second",
        type: "user",
        text: "Second prompt",
        files: [
          { data: "aGk=", mime: "text/plain", source: { type: "uri", uri: "file:///repo/main.ts" }, name: "main.ts" },
        ],
        time: { created: 2 },
      },
    ],
  )

  const view = await openQueue(page, mock)
  const chip = view.composer.locator('[data-slot="composer-context-file"]')

  for (const [id, text, chips] of [
    ["msg_queue_second", "Second prompt", 1],
    ["msg_queue_first", "First prompt", 0],
  ] as const) {
    const row = userRow(page, id)

    await row.hover()
    await row.getByRole("button", { name: "Rewind to here" }).click()
    await expect(view.input).toHaveText(text)
    await expect(chip).toHaveCount(chips)
  }
})

test("/undo withdraws a pending steer without interrupting the running session", async ({ page }) => {
  const mock = createQueueMock([])
  const view = await openQueue(page, mock, "steer")
  const stops: string[] = []
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname

    if (path.endsWith("/interrupt") || path.endsWith("/wait") || path.endsWith("/revert/stage")) stops.push(path)
  })
  const text = "U2: Also check the retry path."
  await view.input.fill(text)
  await view.input.press("Enter")
  await expect.poll(() => mock.rows.map((row) => row.delivery)).toEqual(["steer"])
  await expect(view.input).toHaveText("")

  const inboxID = mock.rows[0].id
  const pending = userRow(page, inboxID)

  await expect(pending).toContainText(text)
  await runSlash(page, view.input, "undo")

  await expect(pending).toHaveCount(0)
  await expect(view.input).toHaveText(text)
  expect(mock.changes).toEqual([{ inboxID, action: "cancel" }])
  expect(stops).toEqual([])
})

test("reverting a delivered prompt leaves queued prompts alone, as in the TUI", async ({ page }) => {
  const mock = createQueueMock(
    ["U2: queued follow-up"],
    [{ id: "msg_queue_delivered", type: "user", text: "First prompt", time: { created: 1 } }],
  )

  const view = await openQueue(page, mock)
  const delivered = userRow(page, "msg_queue_delivered")

  const staged = page.waitForResponse(
    (response) => new URL(response.url()).pathname === `/api/session/${sessionID}/revert/stage`,
  )

  await delivered.hover()
  await delivered.getByRole("button", { name: "Rewind to here" }).click()
  expect((await staged).ok()).toBe(true)

  await expect(view.input).toHaveText("First prompt")
  expect(mock.changes).toEqual([])
  await expect(view.rows).toHaveCount(1)
})

test("a shell command cannot wait in the queue, as in the TUI", async ({ page }) => {
  const mock = createQueueMock([])
  const view = await openQueue(page, mock, "queue")
  const shells: string[] = []
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith(`/${sessionID}/shell`)) shells.push(request.url())
  })

  await view.input.pressSequentially("!")
  await view.input.pressSequentially("git status")
  await view.input.press("Enter")

  await expect(page.getByText("This prompt cannot be queued")).toBeVisible()
  await expect(view.input).toHaveText("git status")
  expect(shells).toEqual([])
  expect(mock.prompts).toEqual([])
})

test("/compact runs with the composer model and shows a queued compaction, as in the TUI", async ({ page }) => {
  const mock = createQueueMock(
    [],
    [{ id: "msg_queue_delivered", type: "user", text: "First prompt", time: { created: 1 } }],
  )

  const view = await openQueue(page, mock)
  const models: unknown[] = []
  page.on("request", (request) => {
    if (new URL(request.url()).pathname !== `/api/session/${sessionID}/model`) return
    mock.log.push("model")
    models.push(request.postDataJSON())
  })

  await expect(userRow(page, "msg_queue_delivered")).toContainText("First prompt")
  await runSlash(page, view.input, "compact")

  await expect(page.locator('[data-timeline-row="CompactionQueued"]')).toHaveText("Session compaction queued")
  // The row is optimistic; the model switch still precedes the admission.
  await expect.poll(() => mock.log).toEqual(["model", "compact"])
  expect(models).toMatchObject([{ model: { id: "queue-model", providerID: "opencode" } }])
})

for (const [action, status] of [
  ["Move to queue", "steering"],
  ["Delete", "steering"],
  ["Move to queue", "starting"],
  ["Delete", "starting"],
] as const) {
  test(`${action} on a ${status} pending steer replaces Revert, as in the TUI`, async ({ page }) => {
    // A steer waits behind work only once the running execution delivered input; before that it is starting.
    const delivered: SessionMessageInfo[] =
      status === "steering"
        ? [{ id: "msg_queue_delivered", type: "user", text: "First prompt", time: { created: 1 } }]
        : []

    const mock = createQueueMock(["U2: Also check the retry path."], delivered)
    const inboxID = mock.rows[0].id
    mock.rows[0].delivery = "steer"
    const view = await openQueue(page, mock)
    const pending = userRow(page, inboxID)

    await expect(pending).toContainText("U2: Also check the retry path.")
    const message = pending.locator('[data-component="user-message"]')

    if (status === "steering") await expect(message).toHaveAttribute("data-pending", "true")
    else await expect(message).not.toHaveAttribute("data-pending")
    await pending.hover()
    await expect(pending.getByRole("button", { name: "Rewind to here" })).toHaveCount(0)
    await pending.getByRole("button", { name: action }).click()

    await expect(pending).toHaveCount(0)
    expect(mock.changes).toEqual([{ inboxID, action: action === "Delete" ? "cancel" : "queue" }])
    // Neither action returns the prompt to the composer; a moved steer waits in the queue.
    await expect(view.input).toHaveText("")
    await expect(view.rows).toHaveCount(action === "Delete" ? 0 : 1)

    if (action === "Move to queue") await expect(view.rows).toContainText("U2: Also check the retry path.")
  })
}

test("waiting steers group under one Pending line, each keeping its own actions beside its bubble", async ({
  page,
}) => {
  const mock = createQueueMock(
    ["U2: Also check the retry path.", "U3: And rebase on beta first."],
    [{ id: "msg_queue_delivered", type: "user", text: "First prompt", time: { created: 1 } }],
  )

  mock.rows.forEach((row) => (row.delivery = "steer"))
  await openQueue(page, mock)
  const first = userRow(page, mock.rows[0].id)
  const last = userRow(page, mock.rows[1].id)
  await expect(last).toContainText("U3: And rebase on beta first.")
  await expect(first.locator('[data-component="user-message"]')).toHaveAttribute("data-pending", "true")

  // The run's last steer carries the one Pending line; the first folds its line away.
  await expect(last.locator('[data-slot="user-message-meta"]')).toContainText("Pending", { useInnerText: true })
  await expect(first.locator('[data-slot="user-message-meta"]')).toBeHidden()

  await first.locator('[data-slot="user-message-text"]').hover()
  await expect(first.locator('[data-slot="user-message-run-actions"]')).toHaveCSS("opacity", "1")
  await first.getByRole("button", { name: "Move to queue" }).click()
  await expect.poll(() => mock.changes).toEqual([{ inboxID: mock.rows[0].id, action: "queue" }])
})

test("/undo returns a pending steer's review comment to the composer", async ({ page }) => {
  const display = "tighten this"
  const comment = "check the guard"

  const mock = createQueueMock([
    `${display}\nThe user made the following comment regarding line 2 of /repo/app.ts: ${comment}`,
  ])

  const row = mock.rows[0]
  row.delivery = "steer"
  row.payload.metadata = {
    displayText: display,
    comments: [
      {
        path: "/repo/app.ts",
        comment,
        selection: { startLine: 2, startChar: 0, endLine: 2, endChar: 0 },
        origin: "review",
      },
    ],
  }
  // The comment's context file, which a resubmission regenerates from the restored comment.
  row.payload.files = [
    {
      data: "aGk=",
      mime: "text/plain",
      source: { type: "uri", uri: "file:///repo/app.ts?start=2&end=2" },
      name: "app.ts",
    },
  ]
  const view = await openQueue(page, mock)

  const pending = userRow(page, row.id)

  await expect(pending).toContainText(display)
  await runSlash(page, view.input, "undo")

  await expect(pending).toHaveCount(0)
  await expect(view.input).toHaveText(display)
  // The comment card is the only card: its context file is regenerated from it, not restored twice.
  const cards = view.composer.locator('[data-component="composer-attachments"] [data-component="attachment-card"]')
  await expect(cards).toHaveCount(1)
  await expect(cards).toContainText(comment)
  expect(mock.changes).toEqual([{ inboxID: row.id, action: "cancel" }])
})

for (const delivery of ["steer", "queue"] as const) {
  test(`keeps finished tools above a pending ${delivery === "queue" ? "queue-to-steer" : "steer"} follow-up`, async ({
    page,
  }, testInfo) => {
    const model = { id: "queue-model", providerID: "opencode" }
    const userID = "msg_queue_initial_user"
    const assistantID = "msg_queue_continued_assistant"
    const followUp = "U2: Also check the retry path."

    const mock = createQueueMock(
      [],
      [
        { id: userID, type: "user", text: "U1: Inspect the queue ordering.", time: { created: 1700000000000 } },
        {
          id: "msg_queue_initial_assistant",
          type: "assistant",
          agent: "build",
          model,
          content: [{ type: "text", text: "A1: I will inspect the current implementation." }],
          finish: "tool-calls",
          time: { created: 1700000000001, completed: 1700000000002 },
        },
      ],
    )

    const view = await openQueue(page, mock, delivery)
    const transcript = page.locator("[data-timeline-virtual-content]")
    const thinking = transcript.locator('[data-timeline-row="Thinking"]')
    await expect(transcript.getByText("A1: I will inspect the current implementation.", { exact: true })).toBeVisible()
    await expect(thinking).toHaveCount(0)
    await expect(view.input).toBeEditable()
    await view.input.fill(followUp)
    await view.input.press("Enter")
    await expect.poll(() => mock.rows.map((row) => row.delivery)).toEqual([delivery])
    await expect(view.input).toHaveText("")

    const inboxID = mock.rows[0].id
    const pending = transcript.locator(`[data-timeline-row="UserMessage"][data-message-id="${inboxID}"]`)

    if (delivery === "queue") {
      const queued = view.rows.filter({ hasText: followUp })
      await expect(queued).toBeVisible()
      await expect(pending).toHaveCount(0)
      await expect(thinking).toHaveCount(0)
      await queued.hover()
      await queued.getByRole("button", { name: "Steer", exact: true }).click()
      await expect.poll(() => mock.changes).toEqual([{ inboxID, action: "steer" }])
    }

    await expect(view.rows).toHaveCount(0)
    await expect(pending).toContainText(followUp)
    await expect(thinking).toHaveCount(0)

    const bubble = pending.locator('[data-slot="user-message-text"]')

    const colors =
      delivery === "steer"
        ? {
            delivered: await userRow(page, userID)
              .locator('[data-slot="user-message-text"]')
              .evaluate((element) => ({
                background: getComputedStyle(element).backgroundColor,
                text: getComputedStyle(element).color,
              })),
            pending: await bubble.evaluate((element) => {
              const probe = document.createElement("span")
              probe.style.backgroundColor = "var(--v2-background-bg-layer-01)"
              probe.style.color = "var(--v2-text-text-muted)"
              element.appendChild(probe)

              const colors = {
                background: getComputedStyle(probe).backgroundColor,
                text: getComputedStyle(probe).color,
              }

              probe.remove()

              return colors
            }),
          }
        : undefined

    if (colors) {
      // A pending steer is grey, switches to it without a transition, and keeps its Pending row in view without hover.
      await expect(bubble).toHaveCSS("background-color", colors.pending.background)
      await expect(bubble).toHaveCSS("color", colors.pending.text)
      await expect(bubble).toHaveCSS("transition-duration", "0s")
      await expect(pending.locator('[data-slot="user-message-copy-wrapper"]')).toHaveCSS("opacity", "1")
      // The steer keeps U1's agent and model, so Pending is all its meta line says.
      await expect(pending.locator('[data-slot="user-message-meta"]')).toHaveText(/^Pending$/, { useInnerText: true })
      await bubble.evaluate((element) => (element.dataset.deliveryMarker = "pending"))
    }

    // The next assistant step still belongs to U1: U2 has been admitted, not delivered.
    mock.emit("session.step.started", {
      sessionID,
      assistantMessageID: assistantID,
      agent: "build",
      model,
      started: Date.now(),
    })

    for (const tool of [
      { id: "tool_queue_read", name: "read", input: { path: "src/queue.ts" } },
      { id: "tool_queue_grep", name: "grep", input: { pattern: "retry", path: "src" } },
    ]) {
      const ref = { sessionID, assistantMessageID: assistantID, id: tool.id }
      mock.emit("session.tool.input.started", { ...ref, name: tool.name })
      mock.emit("session.tool.input.ended", { ...ref, text: JSON.stringify(tool.input) })
      mock.emit("session.tool.called", { ...ref, input: tool.input, executed: true })
      mock.emit("session.tool.success", {
        ...ref,
        content: [{ type: "text", text: "Inspection complete." }],
        executed: true,
      })
    }

    mock.emit("session.step.ended", {
      sessionID,
      assistantMessageID: assistantID,
      finish: "tool-calls",
      cost: 0,
      tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const tools = page.locator('[data-timeline-part-ids="tool_queue_read,tool_queue_grep"]')
    await expect(tools).toBeVisible()
    await expect(tools).toHaveText(/^Used\s*2\s*Read, Grep$/)
    await expect(tools.locator('[data-component="context-tool-group-trigger"]')).toHaveAttribute(
      "aria-label",
      "Used 2 Read, Grep",
    )
    await expect(thinking).toHaveCount(0)
    await expect(pending).toBeVisible()
    expect(mock.rows.map((row) => ({ id: row.id, delivery: row.delivery }))).toEqual([
      { id: inboxID, delivery: "steer" },
    ])
    await transcript.screenshot({ path: testInfo.outputPath("pending-steer.png") })

    await expect(tools.or(pending)).toHaveText([/^Used\s*2\s*Read, Grep$/, /U2: Also check the retry path\./])
    await expect(transcript.locator('[data-timeline-row="AssistantPart"]').filter({ has: tools })).toHaveAttribute(
      "data-message-id",
      userID,
    )
    await expect
      .poll(async () => {
        const boxes = await Promise.all([tools.boundingBox(), pending.boundingBox()])

        return boxes.every((box) => box !== null) && boxes[0]!.y + boxes[0]!.height <= boxes[1]!.y
      })
      .toBe(true)

    // Working ends the work the model has seen, so the steer it has not seen yet waits below it.
    const working = transcript.locator('[data-component="session-working"]')
    await expect(tools.or(working).or(pending)).toHaveText([
      /^Used\s*2\s*Read, Grep$/,
      /Working/,
      /U2: Also check the retry path\./,
    ])

    mock.rows.splice(0, 1)
    mock.emit("session.inbox.delivered", { sessionID, inboxID })
    await expect(thinking).toHaveCount(0)
    await expect(pending).toHaveCount(1)
    await expect(tools.or(pending).or(working)).toHaveText([
      /^Used\s*2\s*Read, Grep$/,
      /U2: Also check the retry path\./,
      /Working/,
    ])

    if (colors) {
      await expect(bubble).toHaveAttribute("data-delivery-marker", "pending")
      await expect(pending.locator('[data-slot="user-message-meta"]')).toHaveText(/^Queue Model$/, {
        useInnerText: true,
      })
      await expect(bubble).toHaveCSS("background-color", colors.delivered.background)
      await expect(bubble).toHaveCSS("color", colors.delivered.text)
      // Only delivery animates the colour; reduced motion switches instantly.
      await expect(bubble).toHaveCSS("transition-property", "background-color, color")
      await transcript.screenshot({ path: testInfo.outputPath("delivered-steer.png") })
      await page.emulateMedia({ reducedMotion: "reduce" })
      await expect(bubble).toHaveCSS("transition-duration", "0s")
    }

    await expect(transcript.locator('[data-timeline-row="UserMessage"]')).toHaveCount(2)
    await expect(transcript.locator('[data-timeline-row="AssistantPart"]').filter({ has: tools })).toHaveAttribute(
      "data-message-id",
      userID,
    )

    const later = { sessionID, assistantMessageID: "msg_queue_follow_up_assistant" }
    mock.emit("session.step.started", { ...later, agent: "build", model, started: Date.now() })
    mock.emit("session.text.started", { ...later, ordinal: 0 })
    mock.emit("session.text.ended", { ...later, ordinal: 0, text: "A3: Now checking the retry path for U2." })

    const response = transcript
      .locator('[data-timeline-row="AssistantPart"]')
      .filter({ hasText: "A3: Now checking the retry path for U2." })

    await expect(response).toHaveAttribute("data-message-id", inboxID)
    await expect(thinking).toHaveCount(0)
    await expect(tools.or(pending).or(response)).toHaveText([
      /^Used\s*2\s*Read, Grep$/,
      /U2: Also check the retry path\./,
      /A3: Now checking the retry path for U2\./,
    ])
  })
}

test("a steer moves a blocking shell to the background after its admission, so the next step reads it", async ({
  page,
}, testInfo) => {
  const model = { id: "alpha", providerID: "opencode" }
  const assistantID = "msg_steer_background_assistant"
  const shell = { sessionID, assistantMessageID: assistantID, id: "prt_steer_background_shell" }
  const steer = "Skip the slow suites and run only the queue tests."

  const mock = createQueueMock(
    [],
    [
      {
        id: "msg_steer_background_user",
        type: "user",
        text: "Run the full test suite.",
        time: { created: 1700000000000 },
      },
      {
        id: assistantID,
        type: "assistant",
        agent: "build",
        model,
        content: [
          {
            type: "tool",
            id: shell.id,
            name: "shell",
            state: {
              status: "running",
              input: { command: "bun test --timeout 600000", description: "Run the full test suite" },
              metadata: { shellID: "sh_steer_background" },
            },
            time: { created: 1700000000002 },
          },
        ],
        time: { created: 1700000000001 },
      },
    ],
  )

  // The command is live from its start; its blocking call keeps it out of the background until the move.
  mock.shells.push({
    id: "sh_steer_background",
    status: "running",
    command: "bun test --timeout 600000",
    cwd: "C:/OpenCode/SessionQueueRegression",
    shell: "bash",
    file: "/tmp/steer-background.out",
    metadata: { sessionID },
    time: { started: 1700000000002 },
  })
  const view = await openQueue(page, mock, "steer", undefined, "running", { id: "alpha", name: "Alpha" })
  const transcript = page.locator("[data-timeline-virtual-content]")
  const hint = page.getByRole("button", { name: /move running work to the background/i })
  await expect(hint).toBeVisible()
  await transcript.screenshot({ path: testInfo.outputPath("before-steer.png") })

  await view.input.fill(steer)
  await view.input.press("Enter")
  // Admission comes first: the steer already waits in the inbox when the moved shell ends the step.
  await expect.poll(() => mock.log).toEqual(["prompt:steer", "background"])

  const inboxID = mock.rows[0].id
  const pending = transcript.locator(`[data-timeline-row="UserMessage"][data-message-id="${inboxID}"]`)
  await expect(pending.locator('[data-component="user-message"]')).toHaveAttribute("data-pending", "true")

  // As the server does, the moved shell's call completes while the command keeps running.
  mock.emit("session.tool.success", {
    ...shell,
    content: [{ type: "text", text: "Command moved to the background (shell ID: sh_steer_background)." }],
    metadata: { status: "running", shellID: "sh_steer_background" },
    executed: true,
  })
  await expect(hint).toHaveCount(0)
  await expect(page.getByRole("button", { name: "1 shell", exact: true })).toBeVisible()
  await transcript.screenshot({ path: testInfo.outputPath("moved-to-background.png") })

  mock.emit("session.step.ended", {
    sessionID,
    assistantMessageID: assistantID,
    finish: "tool-calls",
    cost: 0,
    tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  mock.rows.splice(0, 1)
  mock.emit("session.inbox.delivered", { sessionID, inboxID })

  const next = { sessionID, assistantMessageID: "msg_steer_background_next" }
  mock.emit("session.step.started", { ...next, agent: "build", model, started: Date.now() })
  mock.emit("session.text.started", { ...next, ordinal: 0 })
  mock.emit("session.text.ended", { ...next, ordinal: 0, text: "Running only the queue tests now." })

  const response = transcript
    .locator('[data-timeline-row="AssistantPart"]')
    .filter({ hasText: "Running only the queue tests now." })

  await expect(response).toHaveAttribute("data-message-id", inboxID)
  await expect(pending.locator('[data-component="user-message"]')).not.toHaveAttribute("data-pending", "true")
  expect(mock.log).toEqual(["prompt:steer", "background"])
  await transcript.screenshot({ path: testInfo.outputPath("steer-delivered.png") })
})
