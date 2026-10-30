import { RuntimePolicy } from "@opencode/core/runtime-policy"
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

// The conversation host publishes only this API surface. New integrations must opt in through a controlled host.
export function allows(method: string, pathname: string) {
  if (method === "GET" && /^\/api\/(info|event|config|location|project|agent|model|provider|integration|credential|command|plugin|skill|reference|form)(\/[^/]+)?$/.test(pathname))
    return !/^\/api\/(config|plugin)\//.test(pathname)
  if (/^\/api\/credential(?:\/[^/]+(?:\/activate)?)?$/.test(pathname))
    return ["GET", "POST", "PATCH", "DELETE"].includes(method)
  if (/^\/api\/integration\/[^/]+\/connect\/(key|oauth)(?:\/[^/]+(?:\/complete)?)?$/.test(pathname))
    return ["GET", "POST", "DELETE"].includes(method)
  if (/^\/api\/session(?:\/[^/]+)?$/.test(pathname))
    return ["GET", "POST", "PATCH", "DELETE"].includes(method)
  if (/^\/api\/session\/[^/]+\/(fork|agent|model|prompt|synthetic|compact|generate|interrupt|background|view)$/.test(pathname))
    return method === "POST"
  if (/^\/api\/session\/[^/]+\/(context|inbox|message(?:\/[^/]+)?|form)$/.test(pathname)) return method === "GET"
  if (/^\/api\/session\/[^/]+\/inbox\/[^/]+$/.test(pathname)) return method === "PATCH" || method === "DELETE"
  if (/^\/api\/session\/[^/]+\/form(?:\/[^/]+(?:\/reply)?)?$/.test(pathname))
    return ["GET", "POST", "DELETE"].includes(method)
  if (/^\/api\/session\/[^/]+\/revert(?:\/(stage|commit))?$/.test(pathname))
    return method === "POST" || method === "DELETE"
  if (/^\/api\/experimental\/session\/(stats|import)$/.test(pathname))
    return method === (pathname.endsWith("import") ? "POST" : "GET")
  if (/^\/api\/experimental\/session\/[^/]+\/(export|wait|log)$/.test(pathname)) return method === "GET"
  if (/^\/api\/experimental\/media\/[a-f0-9]+$/.test(pathname)) return method === "GET"
  if (/^\/api\/permission\/(request|saved)(\/[^/]+)?$/.test(pathname)) return method === "GET"
  if (/^\/api\/session\/[^/]+\/permission(?:\/[^/]+(?:\/reply)?)?$/.test(pathname))
    return method === "GET" || method === "POST"
  if (pathname === "/api/experimental/usage/limits") return method === "GET"
  return false
}

export function middleware(options: RuntimePolicy.Options = {}) {
  return HttpRouter.middleware((app) => Effect.gen(function* () {
    if (options.managedDirectory === undefined) return yield* app
    const request = yield* HttpServerRequest.HttpServerRequest
    const url = new URL(request.url, "http://localhost")
    if (!allows(request.method, url.pathname))
      return HttpServerResponse.jsonUnsafe({ code: "runtime_capability_disabled", message: "This capability is unavailable in the conversation runtime" }, { status: 403 })
    return yield* app
  })).layer
}
