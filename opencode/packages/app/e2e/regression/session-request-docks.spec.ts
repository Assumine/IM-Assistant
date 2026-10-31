import type { OpenCodeEvent } from "@opencode/client/promise"
import { expect, test, type Page } from "@playwright/test"
import { SERVER, sessionHref } from "../utils/app"
import { installSseTransport } from "../utils/sse-transport"
import { expectSessionTitle } from "../utils/waits"
import { mockWorkspace, type WorkspaceInput } from "../utils/workspace"
import { backendEvent, backendHref, backendRpc, backendTabs } from "../utils/backends"
import type { ConversationBackend } from "@opencode/schema/conversation-backend"

const directory = "C:/OpenCode/RequestDocks"

const sessionID = "ses_request_docks"

const title = "Request dock regression"

for (const variant of ["classic", "experimental"] as const) {
  test(`whole backend: ${variant} questions preserve drafts and wait for native resolution`, async ({
    page,
  }, testInfo) => {
    const thread: ConversationBackend.Thread = {
      ref: { backendID: "native", threadID: "questions" },
      title: "Native questions",
      state: "idle",
    }

    const question: ConversationBackend.Question = {
      id: "question-first",
      turnID: "native-turn",
      itemID: "native-item",
      blocking: true,
      state: "pending",
      prompts: [
        {
          id: "choice",
          header: "Direction",
          question: "Which direction?",
          other: false,
          options: [
            { label: "Minimal", description: "Keep it small" },
            { label: "Extended", description: "Include detail" },
          ],
        },
        { id: "detail", header: "Details", question: "What should stay?", other: true, options: [] },
      ],
    }

    let value: ConversationBackend.Execution = { thread, queue: [] }
    const actions: ConversationBackend.Control[] = []
    const released = Promise.withResolvers<void>()
    let sends = 0

    const workspace = await mockWorkspace(page, {
      name: "BackendQuestions",
      workspace: false,
      sessions: [],
      seed: { ...backendTabs([], [thread]), settings: { general: { newQuestionUI: variant === "experimental" } } },
      rpc: backendRpc({
        list: () => [{ id: "native", label: "Native", execution: true }],
        status: () => ({ authentication: null }),
        history: () => ({ thread, items: [] }),
        execution: () => value,
        send: (input) => {
          sends++

          return { status: "uncertain", ref: input.ref, inputID: input.inputID }
        },
        control: async (backend, action) => {
          expect(backend).toBe("native")
          actions.push(action)

          if (action.action === "answer") await released.promise

          if (action.action === "answer" && action.questionID === "question-unknown") {
            value = { ...value, questions: value.questions?.map((item) => ({ ...item, state: "responding" })) }
            throw new Error("Private answer failure")
          }

          if (action.action === "dismiss-question") value = { ...value, questions: [] }

          return { status: "resolved" }
        },
      }),
    })

    await page.goto(backendHref(thread.ref))
    const panel = page.getByRole("region", { name: "Native execution and queue" })
    const editor = panel.locator('[contenteditable="true"]')
    await expect(editor).toBeEditable()
    await editor.fill("Keep my unsent draft")
    await editor.evaluate((element) => {
      element.dataset.questionDraft = "original"
    })
    value = {
      thread: { ...thread, state: "waiting" },
      turn: { id: "native-turn", state: "running" },
      queue: [],
      questions: [question],
    }
    await workspace.push([backendEvent("activity", { ref: thread.ref, change: "execution" }, workspace.directory)])
    const dock = panel.locator('[data-component="dock-prompt"][data-kind="question"]')
    await expect(dock).toBeVisible()
    await expect(editor).toHaveCount(1)
    await expect(editor).toBeHidden()
    await expect(dock.getByRole("textbox")).toHaveCount(0)
    await expect(dock.getByRole("button", { name: "Next", exact: true })).toBeDisabled()
    await dock.getByRole("radio", { name: /Minimal/ }).click()
    await page.keyboard.press("3")
    await expect(dock.getByRole("textbox")).toHaveCount(0)
    await dock.getByRole("button", { name: "Next", exact: true }).click()
    const input = dock.getByRole("textbox", { name: "Type your own answer…", exact: true })
    await expect(input).toBeEditable()
    await expect(dock.getByRole("button", { name: "Submit", exact: true })).toBeDisabled()
    await input.fill("Keep the existing layout")
    await dock.getByRole("button", { name: "Back", exact: true }).click()
    await expect(dock.getByRole("radio", { name: /Minimal/ })).toBeChecked()
    await dock.getByRole("button", { name: "Next", exact: true }).click()
    await expect(input).toHaveValue("Keep the existing layout")
    await page.screenshot({ path: testInfo.outputPath(`backend-question-${variant}.png`), fullPage: true })
    await dock.getByRole("button", { name: "Submit", exact: true }).click()
    await expect
      .poll(() => actions)
      .toEqual([
        {
          action: "answer",
          threadID: "questions",
          questionID: "question-first",
          answers: { choice: ["Minimal"], detail: ["Keep the existing layout"] },
        },
      ])
    await expect(dock.getByRole("button", { name: "Submit", exact: true })).toBeDisabled()
    await page.keyboard.press("Control+Enter")
    released.resolve()
    await expect(panel.getByRole("button", { name: "Refresh execution" })).toBeEnabled()
    await expect(dock).toBeVisible()
    await expect(dock.getByRole("button", { name: "Submit", exact: true })).toBeDisabled()
    expect(actions).toHaveLength(1)
    value = { thread, queue: [], questions: [] }
    await workspace.push([backendEvent("activity", { ref: thread.ref, change: "execution" }, workspace.directory)])
    await expect(dock).toHaveCount(0)
    await expect(editor).toBeVisible()
    await expect(editor).toHaveText("Keep my unsent draft")
    await expect(editor).toHaveAttribute("data-question-draft", "original")
    value = {
      ...value,
      questions: [{ ...question, id: "question-next", blocking: false, prompts: [question.prompts[0]] }],
    }
    await workspace.push([backendEvent("activity", { ref: thread.ref, change: "execution" }, workspace.directory)])
    await expect(dock).toBeVisible()
    await expect(editor).toBeVisible()
    await editor.fill("Draft while a question is open")
    await dock.getByRole("button", { name: "Dismiss", exact: true }).click()
    await expect(dock).toHaveCount(0)
    await expect(editor).toHaveText("Draft while a question is open")
    expect(actions).toHaveLength(2)
    expect(actions[1]).toEqual({ action: "dismiss-question", threadID: "questions", questionID: "question-next" })
    value = { ...value, questions: [{ ...question, id: "question-unknown", prompts: [question.prompts[0]] }] }
    await workspace.push([backendEvent("activity", { ref: thread.ref, change: "execution" }, workspace.directory)])
    await expect(dock.getByRole("radio", { name: /Minimal/ })).toBeVisible()
    await dock.getByRole("radio", { name: /Minimal/ }).click()
    await dock.getByRole("button", { name: "Submit", exact: true }).click()
    await expect(panel.getByRole("alert")).toContainText("Could not confirm the action")
    await expect(page.getByText("Private answer failure", { exact: true })).toHaveCount(0)
    await panel.getByRole("button", { name: "Refresh execution" }).click()
    await expect(panel.getByRole("alert")).toHaveCount(0)
    await expect(dock.getByRole("button", { name: "Submit", exact: true })).toBeDisabled()
    await page.keyboard.press("Control+Enter")
    expect(actions).toHaveLength(3)
    value = { ...value, questions: [] }
    await workspace.push([backendEvent("activity", { ref: thread.ref, change: "execution" }, workspace.directory)])
    await expect(dock).toHaveCount(0)
    await expect(editor).toHaveText("Draft while a question is open")
    expect(sends).toBe(0)
  })
}

test("whole backend: question drafts and late unknown answers stay with their native identity", async ({ page }) => {
  const threads: ConversationBackend.Thread[] = ["alpha", "beta"].map((backendID) => ({
    ref: { backendID, threadID: "same-thread" },
    title: `Question ${backendID}`,
    state: "waiting",
  }))

  const question: ConversationBackend.Question = {
    id: "same-question",
    turnID: "turn",
    itemID: "item",
    blocking: true,
    state: "pending",
    prompts: [
      {
        id: "choice",
        header: "Pick",
        question: "Choose a direction",
        other: false,
        options: [
          { label: "Alpha", description: "First" },
          { label: "Beta", description: "Second" },
        ],
      },
    ],
  }

  const values: Record<string, ConversationBackend.Execution> = Object.fromEntries(
    threads.map((thread) => [thread.ref.backendID, { thread, queue: [], questions: [question] }]),
  )

  const actions: { backendID: string; action: ConversationBackend.Control }[] = []
  const released = Promise.withResolvers<void>()

  const workspace = await mockWorkspace(page, {
    name: "QuestionIdentity",
    workspace: false,
    sessions: [],
    seed: backendTabs([], threads),
    rpc: backendRpc({
      list: () => threads.map((thread) => ({ id: thread.ref.backendID, label: thread.title, execution: true })),
      status: () => ({ authentication: null }),
      history: ({ ref }) => ({ thread: values[ref.backendID].thread, items: [] }),
      execution: ({ ref }) => values[ref.backendID],
      control: async (backendID, action) => {
        actions.push({ backendID, action })
        values[backendID] = { ...values[backendID], questions: [{ ...question, state: "responding" }] }
        await released.promise
        throw new Error("Private native transport error")
      },
    }),
  })

  await page.goto(backendHref(threads[0].ref))
  const dock = page.locator('[data-component="dock-prompt"][data-kind="question"]')
  await expect(dock.getByRole("radio", { name: /Alpha/ })).toBeVisible()
  await dock.getByRole("radio", { name: /Alpha/ }).click()
  await page.getByRole("link", { name: /Question beta/ }).click()
  await expect(dock.getByRole("radio", { name: /Alpha/ })).not.toBeChecked()
  await dock.getByRole("radio", { name: /Beta/ }).click()
  const completed = page.waitForResponse(/\/api\/rpc\/experimental\.conversation\/control$/)
  await dock.getByRole("button", { name: "Submit", exact: true }).click()
  await expect.poll(() => actions).toHaveLength(1)
  await page.getByRole("link", { name: /Question alpha/ }).click()
  await expect(dock.getByRole("radio", { name: /Alpha/ })).toBeChecked()
  released.resolve()
  await completed
  await page.getByRole("link", { name: /Question beta/ }).click()
  await expect(dock.getByRole("button", { name: "Submit", exact: true })).toBeDisabled()
  await expect(dock.getByRole("radio", { name: /Beta/ })).toBeChecked()
  await expect(page.getByText("Private native transport error", { exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Refresh execution" }).click()
  await expect(dock.getByRole("button", { name: "Submit", exact: true })).toBeDisabled()
  expect(actions).toEqual([
    {
      backendID: "beta",
      action: { action: "answer", threadID: "same-thread", questionID: "same-question", answers: { choice: ["Beta"] } },
    },
  ])
  values.beta = { ...values.beta, questions: [] }
  await workspace.push([backendEvent("activity", { ref: threads[1].ref, change: "execution" }, workspace.directory)])
  await expect(dock).toHaveCount(0)
  await page.getByRole("link", { name: /Question alpha/ }).click()
  await expect(dock.getByRole("radio", { name: /Alpha/ })).toBeChecked()
  await expect(dock.getByRole("button", { name: "Submit", exact: true })).toBeEnabled()
})

test("shows a pending question dock", async ({ page }) => {
  await mockServer(page, {
    forms: [
      {
        id: "frm_question_request",
        sessionID,
        title: "Questions",
        metadata: { kind: "question" },
        fields: [
          {
            key: "q0",
            type: "string",
            title: "Implementation",
            description: "Which implementation should be used?",
            options: [
              { value: "minimal", label: "Minimal", description: "Use the smallest correct change" },
              { value: "extended", label: "Extended", description: "Include additional behavior" },
            ],
            custom: true,
          },
        ],
      },
    ],
  })

  await page.goto(sessionHref(sessionID))
  await expectSessionTitle(page, title)

  const question = page.locator('[data-component="dock-prompt"][data-kind="question"]')
  await expect(question).toBeVisible()
  await expect(question.getByText("Which implementation should be used?")).toBeVisible()
  await expect(question.getByRole("radio", { name: /Minimal/ })).toBeVisible()
  await expect(question.getByRole("radio", { name: /Extended/ })).toBeVisible()
  await expect(page.locator('[data-component="composer"]')).toHaveCount(0)

  const rejectRequests: string[] = []
  page.on("request", (request) => {
    if (
      request.method() === "DELETE" &&
      new URL(request.url()).pathname === `/api/session/${sessionID}/form/frm_question_request`
    )
      rejectRequests.push(request.url())
  })

  await question.getByRole("button", { name: "Minimize question" }).click()
  await expect(question).toBeVisible()
  await expect(question.getByText("Which implementation should be used?")).toBeVisible()
  await expect(question.getByText("Select one answer")).toBeHidden()
  await expect(question.getByRole("radio", { name: /Minimal/ })).toBeHidden()
  await expect(question.getByRole("radio", { name: /Extended/ })).toBeHidden()
  await expect(question.getByRole("button", { name: "Dismiss" })).toBeVisible()
  await expect(question.getByRole("button", { name: "Submit" })).toBeVisible()
  await expect(page.locator('[data-component="question-minimized-dock"]')).toHaveCount(0)
  expect(rejectRequests).toEqual([])

  await question.getByRole("button", { name: "Restore question" }).click()
  await expect(question).toBeVisible()
  await expect(question.getByText("Which implementation should be used?")).toBeVisible()
  await expect(question.getByRole("radio", { name: /Minimal/ })).toBeVisible()
  expect(rejectRequests).toEqual([])

  await question.getByRole("radio", { name: /Minimal/ }).click()

  const reply = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === `/api/session/${sessionID}/form/frm_question_request/reply`,
  )

  await question.getByRole("button", { name: "Submit" }).click()
  expect((await reply).postDataJSON()).toEqual({ answer: { q0: "minimal" } })
})

test("replies with predefined choices and the edited custom multiselect answer", async ({ page }) => {
  await mockServer(page, {
    forms: [
      {
        id: "frm_question_multiselect",
        sessionID,
        title: "Questions",
        metadata: { kind: "question" },
        fields: [
          {
            key: "q0",
            type: "multiselect",
            title: "Include",
            description: "Which supporting surfaces should remain visible?",
            options: [
              { value: "files", label: "Changed files" },
              { value: "terminal", label: "Terminal" },
            ],
            custom: true,
          },
        ],
      },
    ],
  })

  await page.goto(sessionHref(sessionID))
  await expectSessionTitle(page, title)
  const question = page.locator('[data-component="dock-prompt"][data-kind="question"]')
  const files = question.getByRole("checkbox", { name: "Changed files", exact: true })
  const terminal = question.getByRole("checkbox", { name: "Terminal", exact: true })
  const custom = question.getByRole("checkbox", { name: "Type your own answer…", exact: true })
  const input = question.getByRole("textbox", { name: "Type your own answer…", exact: true })
  const cancellations: string[] = []
  page.on("request", (request) => {
    if (
      request.method() === "DELETE" &&
      new URL(request.url()).pathname === `/api/session/${sessionID}/form/frm_question_multiselect`
    )
      cancellations.push(request.url())
  })

  await expect(files).not.toBeChecked()
  await files.click()
  await input.fill("Original custom answer")
  await expect(custom).toBeChecked()
  await expect(files).toBeChecked()
  await terminal.click()
  await expect(terminal).toBeChecked()
  await expect(custom).toBeChecked()
  await expect(files).toBeChecked()

  await custom.click()
  await expect(custom).not.toBeChecked()
  await expect(input).toHaveValue("Original custom answer")
  await expect(files).toBeChecked()
  await expect(terminal).toBeChecked()
  await input.focus()
  await expect(custom).not.toBeChecked()
  await expect(files).toBeChecked()
  await expect(terminal).toBeChecked()
  await custom.click()
  await expect(custom).toBeChecked()
  await expect(input).toHaveValue("Original custom answer")
  await expect(files).toBeChecked()
  await expect(terminal).toBeChecked()

  await input.fill("Updated custom answer")
  await input.press("Escape")
  await expect(input).not.toBeFocused()
  await expect(question.getByRole("button", { name: "Submit", exact: true })).toBeEnabled()
  await expect(input).toHaveValue("Updated custom answer")
  await expect(custom).toBeChecked()
  await expect(files).toBeChecked()
  await expect(terminal).toBeChecked()
  expect(cancellations).toEqual([])

  const reply = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === `/api/session/${sessionID}/form/frm_question_multiselect/reply`,
  )

  await question.getByRole("button", { name: "Submit", exact: true }).press("Control+Enter")
  expect((await reply).postDataJSON()).toEqual({ answer: { q0: ["files", "terminal", "Updated custom answer"] } })
  expect(cancellations).toEqual([])
})

test("shows a pending permission dock", async ({ page }) => {
  const replies: { sessionID: string; permissionID: string; body: unknown }[] = []
  await mockServer(page, {
    onPermissionReply: (reply) => replies.push(reply),
    sessionPermissions: {
      [sessionID]: [
        {
          id: "permission-request",
          sessionID,
          permission: "shell",
          patterns: ["git status", "git diff"],
          metadata: {},
          always: [],
        },
      ],
    },
  })

  await page.goto(sessionHref(sessionID))
  await expectSessionTitle(page, title)

  const permission = page.locator('[data-component="dock-prompt"][data-kind="permission"]')
  await expect(permission).toBeVisible()
  await expect(permission.getByText("git status")).toBeVisible()
  await expect(permission.getByText("git diff")).toBeVisible()
  await expect(permission.locator('[data-slot="permission-footer-actions"] button')).toHaveCount(3)
  await expect(page.locator('[data-component="composer"]')).toHaveCount(0)

  const reply = page.waitForResponse((response) => response.request().method() === "POST")
  await permission.getByRole("button", { name: "Allow once" }).click()
  const response = await reply
  expect(new URL(response.url()).pathname).toBe(`/api/session/${sessionID}/permission/permission-request/reply`)
  expect(response.request().postDataJSON()).toEqual({ decision: "once" })
  expect(response.status()).toBe(204)
  expect(replies).toEqual([{ sessionID, permissionID: "permission-request", body: { decision: "once" } }])
  await expect(permission).toHaveCount(0)
  await expect(page.locator('[data-component="composer"]')).toBeVisible()
})

test("loads a running subagent's question without polling idle subagents on every update", async ({ page }) => {
  const runningID = "ses_request_running_subagent"
  const idleIDs = Array.from({ length: 20 }, (_, index) => `ses_request_idle_${index}`)

  const workspace = await mockWorkspace(page, {
    name: "RequestDocks",
    directory,
    sessions: [
      { id: sessionID, title },
      { id: runningID, title: "Running subagent", parentID: sessionID },
      ...idleIDs.map((id) => ({ id, title: id, parentID: sessionID })),
    ],
    seed: { tabs: [sessionID] },
    // The mock reports a Session with a pending form as running.
    forms: [
      {
        id: "frm_subagent_question",
        sessionID: runningID,
        title: "Questions",
        metadata: { kind: "question" },
        fields: [{ key: "q0", type: "string", title: "Direction", description: "Which way should the subagent go?" }],
      },
    ],
  })

  // Idle subagents whose worktrees were deleted; a failed read is retried on its next sync.
  await page.route(/\/api\/session\/ses_request_idle_\d+\/form$/, (route) =>
    route.fulfill({ status: 404, json: { message: "Location not found" } }),
  )

  const forms: string[] = []
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname

    if (request.method() === "GET" && path.startsWith("/api/session/") && path.endsWith("/form")) forms.push(path)
  })

  await page.goto(sessionHref(sessionID))
  await expectSessionTitle(page, title)
  await expect(
    page.locator('[data-component="dock-prompt"][data-kind="question"]').getByText("Which way should the subagent go?"),
  ).toBeVisible()

  // Every session update used to re-request the forms of the whole subagent tree.
  await workspace.push(
    [...idleIDs, sessionID].map(
      (id, index) =>
        // SAFETY: the fixture event matches the generated OpenCodeEvent shape for its type.
        ({
          id: `evt_request_rename_${index}`,
          created: index + 2,
          type: "session.renamed",
          durable: { aggregateID: id, seq: 1, version: 1 },
          data: { sessionID: id, title: id === sessionID ? "Renamed request docks" : `${id} renamed` },
        }) as OpenCodeEvent,
    ),
  )
  await expect(page.getByRole("heading", { name: "Renamed request docks", exact: true })).toBeVisible()
  expect(forms.toSorted()).toEqual([`/api/session/${runningID}/form`, `/api/session/${sessionID}/form`].toSorted())
})

test("restores the draft caret before typing after a request dock closes", async ({ page }) => {
  const transport = await installSseTransport(page, { server: SERVER, retry: 20 })
  await mockServer(page, { forms: [] })
  await page.goto(sessionHref(sessionID))
  await transport.waitForConnection()
  await expectSessionTitle(page, title)

  const editor = page.locator('[data-component="composer-editor"][contenteditable="true"]')
  const draft = "keep the caret at the end"

  const caret = () =>
    editor.evaluate((element) => {
      const selection = window.getSelection()

      if (!selection?.rangeCount || !element.contains(selection.anchorNode)) return -1
      const range = selection.getRangeAt(0).cloneRange()
      range.selectNodeContents(element)
      range.setEnd(selection.anchorNode!, selection.anchorOffset)

      return range.toString().length
    })

  await editor.fill(draft)
  // The editor places the caret after the filled text; move it only from that known position.
  await expect.poll(caret).toBe(draft.length)

  for (let index = 0; index < 4; index++) await page.keyboard.press("ArrowLeft")
  const cursor = draft.length - 4
  await expect.poll(caret).toBe(cursor)
  await transport.send({
    id: "evt_form_created",
    created: 1700000001000,
    type: "form.created",
    location: { directory },
    data: {
      form: {
        id: "frm_question_caret",
        sessionID,
        title: "Questions",
        metadata: { kind: "question", tool: { messageID: "message-caret", id: "call-caret" } },
        fields: [
          {
            key: "q0",
            type: "string",
            title: "Continue",
            description: "Continue?",
            options: [{ value: "yes", label: "Yes", description: "Continue the session" }],
            custom: true,
          },
        ],
      },
    },
  })
  const question = page.locator('[data-component="dock-prompt"][data-kind="question"]')
  await expect(question).toBeVisible()
  await expect(editor).toHaveCount(0)

  await transport.send({
    id: "evt_form_cancelled",
    created: 1700000002000,
    type: "form.cancelled",
    location: { directory },
    data: { sessionID, id: "frm_question_caret" },
  })
  await expect(question).toHaveCount(0)
  await expect(editor).toBeVisible()
  await page.keyboard.press("x")

  await expect(editor).toHaveText(`${draft.slice(0, cursor)}x${draft.slice(cursor)}`)
})

function mockServer(page: Page, requests: Pick<WorkspaceInput, "sessionPermissions" | "onPermissionReply" | "forms">) {
  return mockWorkspace(page, { name: "RequestDocks", directory, sessions: [{ id: sessionID, title }], ...requests })
}
