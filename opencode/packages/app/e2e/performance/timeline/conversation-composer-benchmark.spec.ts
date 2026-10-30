import { benchmark, expect } from "../benchmark"
import { openSession } from "../../utils/workspace"

benchmark.use({ viewport: { width: 1440, height: 900 }, video: "off", trace: "off", serviceWorkers: "block", traceScope: "interaction" })

benchmark("conversation composer accepts consecutive input without losing text", async ({ page, report }) => {
  const { editor } = await openSession(page, { name: "Conversation composer", workspace: false })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Performance.enable")
  const before = await cdp.send("Performance.getMetrics")
  const started = performance.now()
  const text = "Preserve native conversation order and the pending message queue."
  await editor.pressSequentially(text)
  await expect(editor).toHaveText(text)
  const after = await cdp.send("Performance.getMetrics")
  const value = (metrics: typeof before.metrics, name: string) => metrics.find(metric => metric.name === name)?.value ?? 0
  report({ elapsedMs: performance.now() - started,
    scriptMs: 1000 * (value(after.metrics, "ScriptDuration") - value(before.metrics, "ScriptDuration")),
    taskMs: 1000 * (value(after.metrics, "TaskDuration") - value(before.metrics, "TaskDuration")),
    nodes: value(after.metrics, "Nodes"), characters: text.length }, { productionBuild: true, transport: "native HTTP fixture", history: "empty" })
})
