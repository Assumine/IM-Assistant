import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, lstat } from "node:fs/promises";
import path from "node:path";
import type { ApplicationModuleSettings } from "../../../opencode/packages/plugin/src/promise/application";

export type Configuration = {
  version: 1;
  enabled: boolean;
  maxConcurrent: number;
  perDownloadLimit: number;
  reserveBytes: number;
  enableDht: boolean;
};
export const defaults: Configuration = {
  version: 1,
  enabled: false,
  maxConcurrent: 3,
  perDownloadLimit: 5242880,
  reserveBytes: 5368709120,
  enableDht: true,
};
export function parse(text: string): Configuration {
  const value = JSON.parse(text);
  if (
    !value ||
    Object.keys(value).some((key) => !Object.keys(defaults).includes(key)) ||
    value.version !== 1 ||
    typeof value.enabled !== "boolean" ||
    typeof value.enableDht !== "boolean" ||
    !Number.isInteger(value.maxConcurrent) ||
    value.maxConcurrent < 1 ||
    value.maxConcurrent > 3 ||
    !Number.isInteger(value.perDownloadLimit) ||
    value.perDownloadLimit < 1024 ||
    value.perDownloadLimit > 104857600 ||
    !Number.isSafeInteger(value.reserveBytes) ||
    value.reserveBytes < 0
  )
    throw new Error("Invalid download settings");
  return {
    version: 1,
    enabled: value.enabled,
    maxConcurrent: value.maxConcurrent,
    perDownloadLimit: value.perDownloadLimit,
    reserveBytes: value.reserveBytes,
    enableDht: value.enableDht,
  };
}
export async function readConfiguration(home: string): Promise<Configuration> {
  try {
    const file = path.join(home, "downloads.json");
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384)
      throw new Error("Invalid settings file");
    return parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { ...defaults };
    throw error;
  }
}
export function settingsOwner(home: string): ApplicationModuleSettings {
  const read: ApplicationModuleSettings["read"] = async (signal) => {
    signal.throwIfAborted();
    const text = JSON.stringify(await readConfiguration(home), null, 2);
    return {
      revision: createHash("sha256").update(text).digest("hex"),
      text,
      appliesTo: "next-service-start",
    };
  };
  return {
    read,
    async write(input, signal) {
      const config = parse(input.text);
      signal.throwIfAborted();
      await mkdir(home, { recursive: true });
      const lock = path.join(home, "downloads.lock");
      const handle = await open(lock, "wx", 0o600);
      const file = path.join(home, "downloads.json");
      const temporary = file + "." + randomUUID() + ".tmp";
      try {
        if ((await read(signal)).revision !== input.revision) return undefined;
        const output = await open(temporary, "wx", 0o600);
        try {
          await output.writeFile(JSON.stringify(config, null, 2) + "\n");
          await output.sync();
        } finally {
          await output.close();
        }
        signal.throwIfAborted();
        await rename(temporary, file);
        return read(signal);
      } finally {
        await handle.close();
        await rm(temporary, { force: true });
        await rm(lock, { force: true });
      }
    },
  };
}
