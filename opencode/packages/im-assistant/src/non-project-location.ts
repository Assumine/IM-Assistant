export * as NonProjectLocation from "./non-project-location.js"

import { Storage } from "./storage.js"

// The native Location remains the owner; this profile supplies only its managed directory.
export function directory() {
  return Storage.paths(Storage.root()).location
}
