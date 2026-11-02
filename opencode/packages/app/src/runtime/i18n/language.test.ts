import { describe, expect, test } from "bun:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { DESKTOP_NATIVE_LOCALES } from "./desktop-native"
import { localizedListParts, richTemplateParts } from "./language"

describe("rich translations", () => {
  test("lets the translated phrase position a rich slot", () => {
    const names = { type: "names" }
    expect(richTemplateParts("Written by {{names}}", { names })).toEqual(["Written by ", names])
    expect(richTemplateParts("{{names}} tarafından yazıldı", { names })).toEqual([names, " tarafından yazıldı"])
  })

  test("keeps list elements intact while localizing punctuation", () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }]
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the check is that no element was stringified
    expect(localizedListParts("en", items).filter((part) => typeof part !== "string")).toEqual(items)
  })
})

describe("dictionaries", () => {
  test("are flat string maps in every locale", async () => {
    const modules = await Promise.all(
      DESKTOP_NATIVE_LOCALES.flatMap((locale) => [import(`./${locale}`), import(`../../../../ui/src/i18n/${locale}`)]),
    )

    const nested = modules.flatMap((module) =>
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the check is that no value is nested
      Object.entries<unknown>(module.dict).filter(([, value]) => typeof value !== "string"),
    )

    expect(nested).toEqual([])
  })

  const plugins = fileURLToPath(new URL("../../../../gui-plugins/src/", import.meta.url))
  const catalogs = [
    new URL("./", import.meta.url),
    new URL("../../../../ui/src/i18n/", import.meta.url),
    ...Array.from(new Bun.Glob("*/i18n/en.ts").scanSync({ cwd: plugins, absolute: true })).map(
      (file) => new URL("./", pathToFileURL(file)),
    ),
  ]

  for (const catalog of catalogs) {
    test(`Simplified Chinese covers source keys and preserves interpolation: ${catalog}`, async () => {
      const english = await import(new URL("en.ts", catalog).href)
      const chinese = await import(new URL("zh.ts", catalog).href)
      const en = english.default ?? english.dict
      const zh = chinese.default ?? chinese.dict
      expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
      for (const key of Object.keys(en)) {
        const placeholders = (value: string) => [...value.matchAll(/\{\{[^{}]+\}\}/g)].map(([slot]) => slot).sort()
        expect(placeholders(zh[key]), key).toEqual(placeholders(en[key]))
      }
    })
  }
})
