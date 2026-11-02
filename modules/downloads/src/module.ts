import { createHash } from "node:crypto";
import { mkdir, realpath, statfs } from "node:fs/promises";
import path from "node:path";
import type { ApplicationModule } from "../../../opencode/packages/plugin/src/promise/application";
import type { Capability } from "../../../opencode/packages/schema/src/capability";
import { Engine, EngineError } from "./engine";
import { settingsOwner, type Configuration } from "./configuration";

type Job = {
  id: string;
  requestID: string;
  title: string;
  uri: string;
  filename: string;
  checksum: string;
  gid: string;
  engineKey: string;
  status: string;
  total: number;
  completed: number;
  speed: number;
  created: number;
  locale: string;
  notified: boolean;
  errorCode: string;
};
function isJob(value: unknown): value is Job {
  if (!value || typeof value !== "object") return false;
  return (
    [
      "id",
      "requestID",
      "title",
      "uri",
      "filename",
      "checksum",
      "gid",
      "engineKey",
      "status",
      "locale",
      "errorCode",
    ].every(
      (key) => key in value && typeof Reflect.get(value, key) === "string",
    ) &&
    ["total", "completed", "speed", "created"].every(
      (key) => key in value && Number.isSafeInteger(Reflect.get(value, key)),
    ) &&
    "notified" in value &&
    typeof value.notified === "boolean"
  );
}
const copy = {
  en: {
    title: "Downloads",
    description: "Direct links and magnets. Cancelling keeps downloaded files.",
    empty: "No downloads yet.",
    add: "Add download",
    name: "Title",
    uri: "Download URL or magnet",
    filename: "File name (direct links)",
    checksum: "SHA-256 (optional)",
    pause: "Pause",
    resume: "Resume or reconcile",
    cancel: "Cancel transfer",
    file: "File",
    progress: "Downloaded / total",
    speed: "Download speed",
    submitting: "Reconciling admission",
    running: "Downloading",
    queued: "Waiting for engine",
    metadata: "Retrieving torrent metadata",
    paused: "Paused",
    completed: "Completed",
    cancelled: "Cancelled; files retained",
    error: "Engine error",
    unknown: "Reconciliation required",
    review: "Interrupted; resume explicitly",
    accepted: "Download recorded.",
    duplicate:
      "This request was already recorded; check its existing download.",
    applied: "Operation applied.",
    rejected: "Check the link, file name, checksum and available space.",
    uncertain:
      "The result is unknown. Inspect this download before resubmitting.",
    stopped: "The download module is stopped.",
    invalid: "This operation does not belong to an existing download.",
    done: "Download completed",
    reason: "Engine result",
    retained:
      "Existing files were retained; inspect the source and resume information.",
    engineCode: "Engine code",
  },
  zh: {
    title: "下载管理",
    description: "支持直链和磁力链接。取消传输会保留已下载文件。",
    empty: "暂无下载任务。",
    add: "新增下载",
    name: "任务名称",
    uri: "下载地址或磁力链接",
    filename: "保存文件名（直链）",
    checksum: "SHA-256（可选）",
    pause: "暂停",
    resume: "继续或核对",
    cancel: "取消传输",
    file: "文件",
    progress: "已下载 / 总量",
    speed: "下载速度",
    submitting: "正在核对受理",
    running: "下载中",
    queued: "等待引擎",
    metadata: "正在获取种子信息",
    paused: "已暂停",
    completed: "已完成",
    cancelled: "已取消，文件保留",
    error: "引擎报错",
    unknown: "需要核对",
    review: "运行曾中断，请手动继续",
    accepted: "下载任务已记录。",
    duplicate: "这条请求已记录，请查看对应的下载任务。",
    applied: "操作已生效。",
    rejected: "请检查链接、文件名、校验值及剩余空间。",
    uncertain: "尚未确认操作结果，请先核对这条下载记录，避免重复提交。",
    stopped: "下载模块已停止。",
    invalid: "此操作没有对应的下载任务。",
    done: "下载已完成",
    reason: "引擎结果",
    retained: "已有文件或分片缺少续传信息，原文件已保留，请核对来源。",
    engineCode: "引擎代码",
  },
};
const words = (locale?: string) =>
  locale === "zh" || /^zh-(?:cn|hans)/i.test(locale ?? "") ? copy.zh : copy.en;
const number = (value: string | undefined) => {
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    return 0;
  return Number(value);
};
const bytes = (value: number) =>
  value >= 1073741824
    ? (value / 1073741824).toFixed(2) + " GiB"
    : (value / 1048576).toFixed(2) + " MiB";
export function validFilename(value: string) {
  return (
    value.length > 0 &&
    value.length <= 180 &&
    !/[\x00-\x1f<>:"/\\|?*]/.test(value) &&
    !/[. ]$/.test(value) &&
    !/^(?:\.|\.\.|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
  );
}
export function validate(values: unknown): {
  title: string;
  uri: string;
  filename: string;
  checksum: string;
} {
  if (!values || typeof values !== "object" || Array.isArray(values))
    throw new Error("Invalid download input");
  const title = Reflect.get(values, "title"),
    uri = Reflect.get(values, "uri");
  const filename = Reflect.get(values, "filename") || "download.bin",
    checksum = Reflect.get(values, "checksum") || "";
  if (
    typeof title !== "string" ||
    !title.trim() ||
    title.length > 160 ||
    typeof uri !== "string" ||
    uri.length > 8192 ||
    typeof filename !== "string" ||
    !validFilename(filename) ||
    typeof checksum !== "string" ||
    (checksum && !/^[0-9a-f]{64}$/i.test(checksum))
  )
    throw new Error("Invalid download input");
  const parsed = new URL(uri);
  if (
    parsed.username ||
    parsed.password ||
    !["http:", "https:", "magnet:"].includes(parsed.protocol)
  )
    throw new Error("Invalid download URI");
  if (
    parsed.protocol === "magnet:" &&
    !parsed.searchParams
      .getAll("xt")
      .some((xt) => /^urn:btih:(?:[a-f0-9]{40}|[a-z2-7]{32})$/i.test(xt))
  )
    throw new Error("Unsupported magnet identity");
  return {
    title: title.trim(),
    uri: parsed.href,
    filename,
    checksum: checksum.toLowerCase(),
  };
}

export function createDownloadModule(options: {
  home: string;
  executable: string;
  config: Configuration;
}): ApplicationModule {
  return {
    id: "downloads",
    title: "Downloads",
    settings: settingsOwner(options.home),
    open(context) {
      let closing = false;
      const lifetime = new AbortController();
      const pending = new Set<Promise<unknown>>();
      const locks = new Map<string, Promise<void>>();
      const serial = <T>(id: string, run: () => Promise<T>): Promise<T> => {
        const result = (locks.get(id) ?? Promise.resolve()).then(run);
        const tail = result.then(
          () => {},
          () => {},
        );
        locks.set(id, tail);
        void tail.then(() => {
          if (locks.get(id) === tail) locks.delete(id);
        });
        return result;
      };
      const persist = async (job: Job) => {
        await context.storage.set("job:" + job.id, job);
        context.capability.invalidate?.();
      };
      const get = async (id: string) => {
        if (!/^[0-9a-f]{16}$/.test(id)) return undefined;
        const job = await context.storage.get("job:" + id);
        return isJob(job) ? job : undefined;
      };
      const all = async () =>
        (
          await context.storage.scan({ prefix: "job:", limit: 200 })
        ).entries.flatMap((entry) => (isJob(entry.value) ? [entry.value] : []));
      const effective = (job: Job) =>
        job.engineKey !== engine.key &&
        !["completed", "cancelled", "paused"].includes(job.status)
          ? "review"
          : job.status;
      const engine = new Engine({
        ...options,
        home: path.join(options.home, "engine"),
        changed: async (gid) => {
          if (closing) return;
          const jobs = await all();
          const job = jobs.find((job) => job.gid === gid || job.id === gid);
          if (job) await sync(job, lifetime.signal);
        },
      });
      const sync = (job: Job, signal: AbortSignal) =>
        serial(job.id, async () => rawSync((await get(job.id)) ?? job, signal));
      const rawSync = async (job: Job, signal: AbortSignal) => {
        if (
          closing ||
          !engine.started ||
          job.engineKey !== engine.key ||
          ["completed", "cancelled"].includes(job.status)
        )
          return job;
        let next = { ...job };
        try {
          let status = await engine.status(next.gid, signal);
          for (let depth = 0; status.followedBy?.length && depth < 4; depth++) {
            if (
              status.followedBy.length !== 1 ||
              !/^[0-9a-f]{16}$/.test(status.followedBy[0]!)
            )
              throw new EngineError("unknown");
            next.gid = status.followedBy[0]!;
            status = await engine.status(next.gid, signal);
          }
          next.total = number(status.totalLength);
          next.errorCode =
            status.status === "error" &&
            /^\d{1,3}$/.test(status.errorCode ?? "")
              ? status.errorCode!
              : "";
          next.completed = number(status.completedLength);
          next.speed = number(status.downloadSpeed);
          next.status =
            status.status === "complete"
              ? next.uri.startsWith("magnet:") && next.gid === next.id
                ? "metadata"
                : "completed"
              : status.status === "active"
                ? next.uri.startsWith("magnet:") && next.gid === next.id
                  ? "metadata"
                  : "running"
                : status.status === "waiting"
                  ? "queued"
                  : status.status === "paused"
                    ? "paused"
                    : status.status === "removed"
                      ? "cancelled"
                      : status.status === "error"
                        ? "error"
                        : "unknown";
          if (next.completed > next.total && next.total > 0)
            next.status = "unknown";
        } catch {
          if (signal.aborted) return job;
          next.status = "unknown";
        }
        if (JSON.stringify(next) !== JSON.stringify(job)) await persist(next);
        if (next.status === "completed" && !next.notified) {
          await context.capability.notify({
            id: "completed_" + next.id,
            title: words(next.locale).done,
            message: next.title,
            severity: "info",
            requiresAction: false,
          });
          next = { ...next, notified: true };
          await persist(next);
        }
        return next;
      };
      const directory = async (id: string) => {
        const folder = path.join(options.home, "files", id);
        await mkdir(folder, { recursive: true });
        const root = await realpath(options.home),
          target = await realpath(folder);
        if (!target.startsWith(root + path.sep))
          throw new Error("Download directory escaped");
        return folder;
      };
      const admit = async (job: Job, signal: AbortSignal) => {
        const dir = await directory(job.id);
        const space = await statfs(dir);
        if (
          Number(space.bavail) * Number(space.bsize) <
          options.config.reserveBytes
        )
          throw new Error("Insufficient free space");
        await engine.start();
        signal.throwIfAborted();
        const settings = {
          gid: job.gid,
          dir,
          out: job.filename,
          continue: "true",
          "always-resume": "true",
          "max-download-limit": String(options.config.perDownloadLimit),
          ...(job.checksum ? { checksum: "sha-256=" + job.checksum } : {}),
        };
        await engine.call("addUri", [[job.uri], settings], signal);
        return rawSync(
          { ...job, status: "queued", engineKey: engine.key },
          signal,
        );
      };
      const invoke = async (
        input: Capability.Invocation & { signal: AbortSignal },
      ): Promise<Capability.ActionResult> => {
        const t = words(input.locale);
        const result = (
          state: Capability.ActionResult["state"],
          message: string,
        ) => ({ state, message });
        if (closing || input.id !== "downloads")
          return result("rejected", t.stopped);
        const signal = AbortSignal.any([input.signal, lifetime.signal]);
        signal.throwIfAborted();
        if (input.action === "create") {
          let value: ReturnType<typeof validate>;
          try {
            value = validate(JSON.parse(input.values));
          } catch {
            return result("rejected", t.rejected);
          }
          const id = createHash("sha256")
            .update(input.requestID)
            .digest("hex")
            .slice(0, 16);
          const existing = await get(id);
          if (existing)
            return result(
              existing.uri === value.uri &&
                existing.title === value.title &&
                existing.filename === value.filename &&
                existing.checksum === value.checksum
                ? "applied"
                : "rejected",
              t.duplicate,
            );
          if ((await all()).length >= 200)
            return result("rejected", t.rejected);
          const job: Job = {
            ...value,
            id,
            requestID: input.requestID,
            gid: id,
            engineKey: engine.key,
            status: "submitting",
            total: 0,
            completed: 0,
            speed: 0,
            created: Date.now(),
            locale: input.locale ?? "en",
            notified: false,
            errorCode: "",
          };
          if (!(await context.storage.insert("job:" + id, job)))
            return result("applied", t.duplicate);
          context.capability.invalidate?.();
          try {
            await serial(job.id, () => admit(job, signal));
            return result("applied", t.accepted);
          } catch {
            if (!closing) await persist({ ...job, status: "unknown" });
            return result("uncertain", t.uncertain);
          }
        }
        if (
          !["pause", "resume", "cancel"].includes(input.action) ||
          !input.target
        )
          return result("rejected", t.invalid);
        const job = await get(input.target);
        if (!job || job.status === "completed")
          return result("rejected", t.invalid);
        const operation = "operation:" + input.requestID;
        const existing = await context.storage.get(operation);
        if (existing && typeof existing === "object") {
          if (
            !("action" in existing) ||
            !("target" in existing) ||
            existing.action !== input.action ||
            existing.target !== job.id
          )
            return result("rejected", t.invalid);
          if ("applied" in existing && existing.applied === true)
            return result("applied", t.applied);
          const current = await sync(job, signal);
          const state = effective(current);
          if (
            (input.action === "pause" && state === "paused") ||
            (input.action === "cancel" && state === "cancelled") ||
            (input.action === "resume" &&
              ["running", "queued", "metadata", "completed"].includes(state))
          ) {
            await context.storage.set(operation, {
              action: input.action,
              target: job.id,
              applied: true,
            });
            return result("applied", t.applied);
          }
          return result("uncertain", t.uncertain);
        }
        if (
          !(await context.storage.insert(operation, {
            action: input.action,
            target: job.id,
            at: Date.now(),
          }))
        )
          return result("uncertain", t.uncertain);
        try {
          return await serial(job.id, async () => {
            signal.throwIfAborted();
            if (!engine.started || job.engineKey !== engine.key) {
              if (input.action === "resume")
                await admit(
                  { ...job, gid: job.id, engineKey: engine.key },
                  signal,
                );
              else
                await persist({
                  ...job,
                  status: input.action === "cancel" ? "cancelled" : "paused",
                });
            } else {
              const current = await rawSync((await get(job.id)) ?? job, signal);
              if (current.status === "completed")
                return result("applied", t.done);
              if (
                (input.action === "pause" && current.status === "paused") ||
                (input.action === "resume" &&
                  ["running", "queued", "metadata"].includes(current.status)) ||
                (input.action === "cancel" && current.status === "cancelled")
              ) {
                // The requested state is already observed; never repeat the engine mutation.
              } else if (
                input.action === "cancel" &&
                current.status === "error"
              ) {
                await persist({ ...current, status: "cancelled" });
              } else if (
                input.action === "resume" &&
                ["unknown", "error"].includes(current.status)
              ) {
                try {
                  const status = await engine.status(current.gid, signal);
                  if (status.status !== "error" && status.status !== "removed")
                    return result("uncertain", t.uncertain);
                  await engine.call(
                    "removeDownloadResult",
                    [current.gid],
                    signal,
                  );
                } catch (error) {
                  if (
                    !(error instanceof EngineError) ||
                    error.kind !== "missing"
                  )
                    return result("uncertain", t.uncertain);
                }
                await admit({ ...current, gid: current.id }, signal);
              } else {
                try {
                  await engine.call(
                    input.action === "pause"
                      ? "pause"
                      : input.action === "resume"
                        ? "unpause"
                        : "remove",
                    [current.gid],
                    signal,
                  );
                } catch (error) {
                  if (input.action !== "cancel") throw error;
                  try {
                    const observed = await engine.status(current.gid, signal);
                    if (!["error", "removed"].includes(observed.status))
                      throw error;
                  } catch (checked) {
                    if (
                      !(checked instanceof EngineError) ||
                      checked.kind !== "missing"
                    )
                      throw checked;
                  }
                }
                await persist({
                  ...current,
                  status:
                    input.action === "pause"
                      ? "paused"
                      : input.action === "cancel"
                        ? "cancelled"
                        : "queued",
                });
              }
            }
            await context.storage.set(operation, {
              action: input.action,
              target: job.id,
              applied: true,
            });
            return result("applied", t.applied);
          });
        } catch {
          return result("uncertain", t.uncertain);
        }
      };
      context.capability.report({ phase: "ready" });
      return {
        invoke(input) {
          const task = invoke(input);
          pending.add(task);
          void task.finally(() => pending.delete(task)).catch(() => {});
          return task;
        },
        async close() {
          closing = true;
          lifetime.abort();
          await Promise.allSettled(pending);
          await Promise.allSettled([...locks.values()]);
          await engine.close();
        },
        async view(input) {
          const t = words(input.locale);
          const items = (await all())
            .sort((a, b) => b.created - a.created)
            .slice(0, 30);
          const jobs = await Promise.all(
            items.map((job) => sync(job, input.signal)),
          );
          const active = jobs.some((job) =>
            ["submitting", "running", "queued", "metadata"].includes(
              effective(job),
            ),
          );
          return {
            title: t.title,
            description: t.description,
            empty: t.empty,
            ...(active ? { refreshAfterMs: 1000 } : {}),
            actions: [
              {
                id: "create",
                label: t.add,
                fields: [
                  { name: "title", label: t.name, required: true },
                  { name: "uri", label: t.uri, required: true },
                  { name: "filename", label: t.filename },
                  { name: "checksum", label: t.checksum },
                ],
              },
            ],
            items: jobs.map((job): Capability.ViewItem => {
              const status = effective(job);
              const labels: Record<string, string> = t;
              const actions =
                status === "completed" || status === "cancelled"
                  ? []
                  : [
                      {
                        id: ["running", "queued", "metadata"].includes(status)
                          ? "pause"
                          : "resume",
                        label: ["running", "queued", "metadata"].includes(
                          status,
                        )
                          ? t.pause
                          : t.resume,
                        target: job.id,
                      },
                      { id: "cancel", label: t.cancel, target: job.id },
                    ];
              return {
                id: job.id,
                title: job.title,
                status: labels[status] ?? t.unknown,
                state:
                  status === "completed"
                    ? "success"
                    : ["running", "queued", "metadata"].includes(status)
                      ? "running"
                      : ["unknown", "review", "error", "submitting"].includes(
                            status,
                          )
                        ? "attention"
                        : "waiting",
                ...((!job.uri.startsWith("magnet:") || job.gid !== job.id) &&
                job.total > 0
                  ? {
                      progress: Math.min(
                        100,
                        (job.completed / job.total) * 100,
                      ),
                    }
                  : {}),
                fields: [
                  {
                    label: t.file,
                    value: job.uri.startsWith("magnet:") ? "BT" : job.filename,
                  },
                  {
                    label: t.progress,
                    value:
                      job.uri.startsWith("magnet:") && job.gid === job.id
                        ? "—"
                        : bytes(job.completed) +
                          " / " +
                          (job.total ? bytes(job.total) : "—"),
                  },
                  {
                    label: t.speed,
                    value: ["running", "metadata"].includes(status)
                      ? bytes(job.speed) + "/s"
                      : "—",
                  },
                  ...(job.errorCode
                    ? [
                        {
                          label: t.reason,
                          value:
                            job.errorCode === "13"
                              ? t.retained
                              : t.engineCode + " " + job.errorCode,
                        },
                      ]
                    : []),
                ],
                actions,
              };
            }),
          };
        },
      };
    },
  };
}
