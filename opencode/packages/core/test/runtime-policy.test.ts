import { expect } from "bun:test"
import { Effect, Exit, Schema } from "effect"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { Command } from "../src/command"
import { RuntimePolicy } from "../src/runtime-policy"
import { SessionMessage } from "../src/session/message"
import { Tool } from "../src/tool"
import { Location } from "../src/location"
import { testEffect } from "./lib/effect"
import { tempGlobalLayer } from "./fixture/global"
import { tempLocationLayer } from "./fixture/location"
import path from "node:path"
import os from "node:os"

const directory = path.join(os.tmpdir(), "managed-conversation")
const it = testEffect(AppNodeBuilder.build(LayerNode.group([Tool.node, Command.node, RuntimePolicy.node, Global.node]), [
  Global.node.replace(tempGlobalLayer),
  Location.node.replace(tempLocationLayer),
  RuntimePolicy.node.replace(RuntimePolicy.configured({ managedDirectory: directory })),
]))

it.effect("trusted runtime denies injected tools even with allow-all session permissions", () => Effect.gen(function* () {
  const tools = yield* Tool.Service
  let executions = 0
  yield* tools.transform(editor => editor.add({ name: "read", description: "Injected file reader",
    input: Schema.Struct({}), output: Schema.String, options: { codemode: false },
    execute: () => Effect.sync(() => { executions++; return { output: "forbidden", content: "forbidden" } }),
  }))
  expect(yield* tools.list()).toEqual([])
  const snapshot = yield* tools.snapshot([{ action: "*", resource: "*", effect: "allow" }])
  expect(snapshot.definitions).toEqual([])
  const result = yield* snapshot.execute({ sessionID: Session.ID.make("ses_policy"), agent: Agent.ID.make("build"),
    messageID: SessionMessage.ID.make("msg_policy"), call: { type: "tool-call", id: "injected", name: "read", input: {} },
  }).pipe(Effect.exit)
  expect(Exit.isFailure(result)).toBe(true)
  expect(executions).toBe(0)
}))

it.effect("native command registrations cannot restore generic command execution", () => Effect.gen(function* () {
  const commands = yield* Command.Service
  let executions = 0
  yield* commands.transform(editor => editor.add({ name: "injected", execute: () => Effect.sync(() => { executions++ }) }))
  expect(yield* commands.list()).toEqual([])
  const result = yield* commands.execute({ name: "injected", invocation: {
    sessionID: Session.ID.make("ses_policy"), prompt: { text: "run" }, delivery: "queue",
  }}).pipe(Effect.exit)
  expect(Exit.isFailure(result)).toBe(true)
  expect(executions).toBe(0)
}))

it.effect("managed locations allow only the native application locations", () => Effect.gen(function* () {
  const policy = yield* RuntimePolicy.Service
  const global = yield* Global.Service
  expect(policy.allowsDirectory(directory)).toBe(true)
  expect(policy.allowsDirectory(global.config)).toBe(true)
  expect(policy.allowsDirectory(path.join(directory, "..", "other-project"))).toBe(false)
  expect(policy.allowsDirectory(path.join(directory, "nested-project"))).toBe(false)
}))
