import type { Page } from "@playwright/test"

type Entry = { key: string; text: string }

declare global {
  interface Window {
    assistantMessageEntries: Entry[]
  }
}

/** Observe the actual CSS animation, including a replay after a retained timeline becomes visible again. */
export async function recordMessageEntries(page: Page) {
  await page.addInitScript(() => {
    window.assistantMessageEntries = []
    document.addEventListener("animationstart", (event) => {
      if (event.animationName !== "assistant-message-enter" || !(event.target instanceof HTMLElement)) return
      const row = event.target.closest<HTMLElement>("[data-timeline-key]")
      window.assistantMessageEntries.push({
        key: row?.dataset.timelineKey ?? "",
        text: event.target.textContent ?? "",
      })
    })
  })

  return () => page.evaluate(() => window.assistantMessageEntries)
}

/** The shell, native sidebar and editable content must fit their viewport at every tested window size. */
export async function layoutBounds(page: Page) {
  return page.evaluate(() => {
    const bounds = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector)

      if (!element?.checkVisibility({ checkVisibilityCSS: true })) return undefined
      const rect = element.getBoundingClientRect()

      return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
    }

    return {
      width: innerWidth,
      height: innerHeight,
      overflow: document.documentElement.scrollWidth > innerWidth,
      navigation: bounds('[data-component="application-navigation"]'),
      sidebar: bounds('[data-slot="vertical-tabs-sidebar"]'),
      content: bounds("main"),
      editor: bounds('[data-component="composer-editor"]'),
    }
  })
}
