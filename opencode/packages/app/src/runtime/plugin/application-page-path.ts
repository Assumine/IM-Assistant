/** Stable routes belong to the host; providers only name their own page. */
export const applicationPagePath = (plugin: string, id: string) =>
  `/page/${encodeURIComponent(plugin)}/${encodeURIComponent(id)}`
