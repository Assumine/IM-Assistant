import type { Capability } from "../../../opencode/packages/schema/src/capability"
import type { createOwner } from "./owner"
import type { Data, Report } from "./types"

function progress(report: Report | undefined, zh: boolean): string {
  if (!report) return zh ? "等待采集函数运行" : "Waiting for a collection function"
  const reason = report.reason ?? ""
  if (reason.includes("source-requires-access")) return zh ? "来源需要登录或页面核查" : "The source needs access or page review"
  if (reason.includes("checkpoint-stale")) return zh ? "上游结果已失效，保留有效主干供续接" : "An upstream result expired; valid trunk results are retained"
  if (reason.includes("incomplete") || report.status === "uncertain") return zh ? "上次结果未确认，等待研究协助核对" : "The previous result is unconfirmed; waiting for assistance review"
  if (report.status === "blocked") return zh ? "采集已暂停，等待研究协助" : "Collection paused; waiting for research assistance"
  if (report.status === "exhausted" || report.status === "no-path") return zh ? "本轮没有可继续执行的路径" : "No eligible collection path remains in this round"
  if (report.status === "cancelled") return zh ? "原任务已停止，采集不会自动重做" : "The original task stopped; collection will not replay automatically"
  const value = report.output
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as { readonly [key: string]: Data }
    if (record.found === false) return zh ? "已确认没有匹配结果" : "Confirmed that no matching result exists"
    const title = [record.summary, record.title, record.name, record.fullName].find((item) => typeof item === "string")
    if (typeof title === "string") return (zh ? "已取得：" : "Collected: ") + title.slice(0, 240)
  }
  return zh ? "结果已保存" : "The result is saved"
}

function parameters(input: Data | undefined): string {
  if (input === undefined) return "—"
  const values = input && typeof input === "object" && !Array.isArray(input) ? Object.values(input) : [input]
  return values.filter((value) => typeof value === "string" || typeof value === "number").slice(0, 4).join(" · ").slice(0, 240) || "—"
}

/** Small module-owned presentation. The core sees only generic labels and records. */
export async function researchView(owner: ReturnType<typeof createOwner>, input: { locale?: string; signal: AbortSignal }, holderTitle?: string): Promise<Capability.View> {
  const zh = input.locale?.startsWith("zh") ?? false
  const [rows, catalog] = await Promise.all([owner.activity(input.signal), owner.catalog()])
  const title = (id: string, revision: string) => catalog.drafts.find((draft) => draft.id === id && draft.revision === revision)?.title ?? id
  const items = rows.sort((a, b) => Number(b.running) - Number(a.running) || (b.startedAt ?? 0) - (a.startedAt ?? 0)).map((row): Capability.ViewItem => {
    const report = row.result ?? row.last
    const state = row.running ? "running" : row.incomplete || report?.status === "uncertain" ? "unknown"
      : report?.status === "blocked" || report?.status === "exhausted" || report?.status === "no-path" ? "attention"
      : row.result?.status === "success" ? "success" : "waiting"
    const status = state === "running" ? zh ? "正在执行" : "Running" : state === "unknown" ? zh ? "待核对" : "Needs review"
      : state === "attention" ? zh ? "等待协助" : "Waiting for assistance" : state === "success" ? zh ? "本轮已结束" : "Round ended"
      : report?.status === "cancelled" ? zh ? "已停止" : "Stopped" : zh ? "等待下一步" : "Waiting for the next step"
    const selected = row.running ? row.selected ? title(row.selected.pathID, row.selected.revision) : row.request?.action ?? "—"
      : report?.attempts.at(-1) ? title(report.attempts.at(-1)!.pathID, report.attempts.at(-1)!.revision) : row.request?.action ?? "—"
    const scores = row.running && row.selected ? [{ id: row.selected.pathID, revision: row.selected.revision,
      initialScore: row.paths.find((item) => item.id === row.selected!.pathID && item.revision === row.selected!.revision)?.initialScore
        ?? row.history.find((item) => item.id === row.selected!.pathID && item.revision === row.selected!.revision)?.score ?? row.selected.score, score: row.selected.score }]
      : report?.paths ?? []
    const reason = scores.slice(0, 6).map((item) => title(item.id, item.revision) + (zh ? "：历史 " : ": history ") + item.initialScore.toFixed(2)
      + (zh ? " / 本轮 " : " / round ") + item.score.toFixed(2)).join("\n")
    return { id: row.owner.inputID, title: (row.goal || row.request?.action || (zh ? "研究运行" : "Research run")).slice(0, 160),
      ...(row.conversation ? { subtitle: row.conversation.slice(0, 300) } : {}), state, status,
      fields: [
        { label: zh ? "当前动作" : "Current action", value: selected.slice(0, 1000) },
        { label: zh ? "采集参数" : "Parameters", value: parameters(row.request?.input) },
        { label: zh ? "当前进度" : "Progress", value: row.running ? zh ? "采集函数正在运行" : "The collection function is running" : progress(report, zh) },
        ...(reason ? [{ label: zh ? "选路依据" : "Path selection", value: reason }] : []),
      ], technical: JSON.stringify({ owner: row.owner, request: row.request, selected: row.selected, paths: row.paths,
        report: row.result ?? row.last, incomplete: row.incomplete }, null, 2).slice(0, 32000),
    }
  })
  return { title: zh ? "研究执行" : "Research activity", description: (zh ? "研究协助：" : "Research assistance: ") + (holderTitle || (zh ? "尚未指定" : "not assigned")),
    empty: zh ? "暂无研究运行。在现有会话中指定研究协助并开始任务。" : "No research runs yet. Assign assistance in an existing conversation and start a task.", items }
}
