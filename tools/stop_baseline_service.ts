// Development cleanup only. Never use implicit discovery against a user's service.
import path from "node:path"
import { Service } from "../opencode/packages/client/src/promise/service.ts"

const root = path.resolve(import.meta.dirname, "../runtime/baseline")
const file = path.resolve(process.argv[2] ?? "")
const relative = path.relative(root, file)
if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !["service-local.json", "service-im-assistant.json"].includes(path.basename(file)))
  throw new Error("Only an explicit isolated baseline service can be stopped")
await Service.stop({ file })
