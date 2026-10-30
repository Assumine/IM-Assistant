export * as Policy from "./policy.js"

import { NonProjectLocation } from "./non-project-location.js"

export function runtime() {
  return { managedDirectory: NonProjectLocation.directory() }
}

export function allowsCLI(args: readonly string[]) {
  return args[0] === "serve" || args[0] === "service" ||
    (args[0] === "debug" && args[1] === "paths") || args[0] === "--version" || args[0] === "--help"
}
