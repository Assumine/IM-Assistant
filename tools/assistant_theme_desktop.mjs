// Actual isolated native window, caption clearance and native zoom; no live profile or mocked Electron bridge.
import { chromium, expect } from '../opencode/packages/app/node_modules/@playwright/test/index.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const profile = path.resolve(process.env.IM_THEME_DESKTOP_ROOT ?? '')
assert(profile.startsWith(path.join(root, 'runtime', 'baseline') + path.sep))
const sessions = JSON.parse(process.env.IM_THEME_DESKTOP_SESSIONS ?? '[]')
assert.equal(sessions.length, 2)
const port = fs.readFileSync(path.join(profile, 'session/DevToolsActivePort'), 'utf8').split('\n')[0]
const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { noDefaults: true, timeout: 15000 })
const page = browser.contexts().flatMap((context) => context.pages()).find((item) => item.url().startsWith('oc://renderer/'))
const checks = []
const views = []
const migrationRequests = []
const failedRequests = []
const previews = path.join(root, '.reports/native/r4-theme-desktop-previews')
fs.mkdirSync(previews, { recursive: true })

function nativeWindow(args = []) {
  return JSON.parse(execFileSync(process.env.IM_THEME_WINDOW_PYTHON, [
    '-X', 'utf8', '-m', 'tools.assistant_theme_window', '--launcher', process.env.IM_THEME_WINDOW_LAUNCHER, ...args,
  ], { cwd: root, encoding: 'utf8', windowsHide: true }))
}

async function geometry(label) {
  const result = await page.evaluate(() => {
    const box = (selector) => {
      const element = document.querySelector(selector)
      if (!element?.checkVisibility({ checkVisibilityCSS: true })) return null
      const rect = element.getBoundingClientRect()
      return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
    }
    return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
      overflow: document.documentElement.scrollWidth > innerWidth,
      navigation: box('[data-component="application-navigation"]'), content: box('main'),
      editor: box('[data-component="composer-editor"]'), titlebar: box('[data-slot="titlebar-v2"]'),
      interface: document.documentElement.dataset.interface,
      scheme: document.documentElement.dataset.colorScheme,
    }
  })
  assert.equal(result.interface, 'assistant')
  assert.equal(result.overflow, false, label)
  assert(result.content && result.content.right <= result.width + 1 && result.content.bottom <= result.height + 1, label)
  assert(result.titlebar && result.titlebar.right <= result.width - 46, 'Native Windows caption controls retain their physical clearance')
  if (result.editor) assert(result.editor.bottom <= result.height + 1, label)
  if (result.width >= 768) assert(result.navigation && Math.abs(result.navigation.width - 56) < 0.1, label + ': ' + JSON.stringify(result))
  else assert(!result.navigation, label)
  views.push({ label, ...result })
  await page.screenshot({ path: path.join(previews, label + '.png'), timeout: 15000 })
  return result
}

try {
  assert(page, 'The original Electron renderer must be present')
  page.on('request', (request) => {
    if (request.url().includes('/migration/')) migrationRequests.push(request.url())
  })
  page.on('response', (response) => {
    if (response.status() >= 400) failedRequests.push({ path: new URL(response.url()).pathname, status: response.status() })
  })
  await page.reload()
  await page.bringToFront()
  const navigation = page.locator('[data-component="application-navigation"]')
  await expect(navigation).toBeVisible({ timeout: 45000 })
  await expect(page.locator('[data-slot="titlebar-v2"]')).toHaveCount(1)
  const initialWindow = nativeWindow(['--width', '1280', '--height', '820'])
  assert.equal(initialWindow.owned_launcher, true)
  await page.keyboard.press('Control+0')
  await navigation.locator('a[href="/"]').click()
  const row = (id) => page.locator(`[data-component="home-session-row-container"][data-session-id="${id}"] [data-component="home-session-row"]`)
  await expect(row(sessions[0])).toBeVisible({ timeout: 45000 })
  await row(sessions[0]).click()
  await expect(page.locator('[data-component="composer-editor"]')).toBeEditable()
  const initial = await geometry('session-100')
  checks.push('compiled product opens original native sessions with the scoped assistant presentation and no QQ or model login')
  await navigation.locator('.assistant-nav-bottom button').click()
  await page.getByRole('tab', { name: /^(Appearance|外观)$/ }).click()
  await page.locator('[data-action="settings-color-scheme"]').click()
  await page.getByRole('option', { name: /^(Dark|深色)$/ }).click()
  await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'dark')
  await expect(navigation).toHaveCSS('background-color', 'rgb(32, 32, 32)')
  await navigation.getByRole('button', { name: 'Application modules', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Application modules', exact: true })).toBeVisible()
  const moduleView = await geometry('modules-100')
  assert.deepEqual(moduleView.navigation, initial.navigation)
  checks.push('the same native window keeps icon navigation fixed while its native settings page changes')
  const baseDPR = moduleView.dpr
  for (const zoom of [1.1, 1.25, 1.5]) {
    await page.keyboard.press('Control+=')
    await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBeCloseTo(baseDPR * zoom, 2)
    await geometry('modules-' + Math.round(zoom * 100))
  }
  checks.push('native Windows zoom at 110, 125 and 150 percent applies through original IPC without clipping the settings content')
  await page.keyboard.press('Control+0')
  await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBeCloseTo(baseDPR, 2)
  const windowed = nativeWindow(['--width', '960', '--height', '680'])
  assert.equal(windowed.width, 960)
  await geometry('modules-windowed')
  nativeWindow(['--maximize'])
  await expect.poll(() => nativeWindow().maximized).toBe(true)
  await geometry('modules-maximized')
  checks.push('real windowed and maximized Windows bounds retain one native caption area and a fitting native content pane')
  assert.deepEqual(migrationRequests, [], 'An isolated assistant profile must not request legacy project migration')
  assert.deepEqual(failedRequests, [], 'The native profile must not issue rejected API requests while browsing its own UI')
  console.log(JSON.stringify({ status: 'passed', original_electron_app: true, checks, views,
    screenshots_captured: true, packaged_installer: false, native_zoom: true, legacy_migration_requests: migrationRequests.length,
    rejected_api_requests: failedRequests.length,
    windows: { initial: initialWindow, windowed } }))
} finally {
  const cdp = await browser.newBrowserCDPSession()
  await cdp.send('Browser.close').catch((error) => {
    if (!String(error).includes('Target page, context or browser has been closed')) throw error
  })
}
process.exit(0)
