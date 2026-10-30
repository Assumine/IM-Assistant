// Development acceptance of the original Electron application, no production connection.
import { chromium } from '../opencode/packages/app/node_modules/@playwright/test/index.mjs'
import path from 'node:path'
import fs from 'node:fs'

const root = path.resolve(import.meta.dirname, '..')
const expected = process.env.BASELINE_PRODUCT_ROOT ?? process.env.OPENCODE_DESKTOP_TEST_ROOT
if (!expected?.startsWith(path.join(root, 'runtime', 'baseline') + path.sep))
  throw new Error('A private desktop baseline profile is required')
const port = fs.readFileSync(path.join(expected, 'session/DevToolsActivePort'), 'utf8').split('\n')[0]
const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, {noDefaults: true, timeout: 15000})
try {
  const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith('oc://renderer/'))
  if (!page) throw new Error('Original renderer did not open')
  // No screenshot/visibility assertion: Chromium stops painting occluded desktop windows.
  const deadline = Date.now() + 45000
  const selector = process.env.BASELINE_PRODUCT_ROOT
    ? '[data-component="composer-editor"][contenteditable="true"]'
    : '[data-action="home-new-session"], [data-component="composer-editor"][contenteditable="true"]'
  while (!await page.evaluate(selector => !!document.querySelector(selector), selector)) {
    if (Date.now() > deadline) throw new Error('Renderer not ready: ' + await page.locator('body').innerText())
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const body = await page.locator('body').innerText({timeout: 10000})
  if (body.includes('出了点问题') || body.includes('Something went wrong')) throw new Error('Fatal error screen')
  console.log(JSON.stringify({ready: true, url: page.url(), profile_isolated: true,
    screenshot_verified: false, packaged_installer: false}))
} finally {
  const session = await browser.newBrowserCDPSession()
  await session.send('Browser.close').catch(error => {
    // Electron can close the transport before acknowledging Browser.close.
    if (!String(error).includes('Target page, context or browser has been closed')) throw error
  })
}
process.exit(0)
