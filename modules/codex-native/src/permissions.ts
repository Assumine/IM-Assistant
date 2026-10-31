import { chmod, stat } from "node:fs/promises"

export async function privatePath(target: string, kind: "home" | "directory" | "file", secure = false) {
  const directory = kind !== "file"
  if (process.platform === "win32") {
    const { windowsPrivate } = await import("./windows-security")
    return windowsPrivate(target, directory, secure, kind === "home")
  }
  const info = await stat(target)
  if (!process.getuid || info.uid !== process.getuid()) throw new Error("Native profile has a different owner")
  if (secure) await chmod(target, directory ? 0o700 : 0o600)
  const checked = await stat(target)
  if ((checked.mode & 0o077) !== 0 || checked.isDirectory() !== directory)
    throw new Error("Native profile permissions allow another identity")
}
