import { createInterface } from "node:readline"
import { CodexSessionAdapter, loadProfile } from "../../src"

const adapter = await CodexSessionAdapter.open({
  executable: process.argv[3], profile: await loadProfile(process.argv[2]), apiKey: "fixture-only",
})
console.log(JSON.stringify({ type: "ready", ...adapter.runtimeInfo() }))
try {
  for await (const line of createInterface({ input: process.stdin })) {
    if (line === "read") console.log(JSON.stringify({ type: "account", result: await adapter.account() }))
    if (line === "close") {
      await adapter.close()
      console.log(JSON.stringify({ type: "closed" }))
      break
    }
  }
} finally {
  await adapter.close()
  process.stdin.destroy()
}
