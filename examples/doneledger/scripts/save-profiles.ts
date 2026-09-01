import { Solari, type BrowserSession } from "@solarisdk/browser"

const required = (name: string) => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const client = new Solari({ apiKey: required("SOLARI_API_KEY"), maxAttempts: 1, timeoutMs: 10_000 })

async function release(browser: BrowserSession) {
  try {
    await browser.close()
  } catch {
    await client.sessions.releaseAndWait(browser.id)
  }
}

async function save(role: "WORKER" | "VERIFIER") {
  const browser = await client.launch({
    profileId: required(`DONELEDGER_${role}_PROFILE_ID`),
    proxy: "off",
    recording: false,
    retries: 0,
  })

  try {
    const context = await browser.newContext({ storageState: browser.session.storageState ?? undefined })
    const page = await context.newPage()
    await page.goto(required(`DONELEDGER_${role}_URL`), { waitUntil: "domcontentloaded", timeout: 10_000 })

    if (await page.locator("#username").count()) {
      await page.locator("#username").fill(required(`DONELEDGER_${role}_USERNAME`))
      await page.locator("#password").fill(required(`DONELEDGER_${role}_PASSWORD`))
      await page.locator('button[type="submit"], input[type="submit"]').click()
      await page.waitForLoadState("domcontentloaded")
    }

    if (await page.locator("#username").count()) throw new Error(`${role.toLowerCase()} login failed`)
    await client.profiles.save(required(`DONELEDGER_${role}_PROFILE_ID`), await context.storageState())
    console.log(`${role.toLowerCase()} profile saved`)
  } finally {
    await release(browser)
  }
}

try {
  await save("WORKER")
  await save("VERIFIER")
} finally {
  await client.close()
}
