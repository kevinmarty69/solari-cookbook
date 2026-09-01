import { isDeepStrictEqual } from "node:util"
import { randomUUID } from "node:crypto"
import { isIP } from "node:net"
import { lookup } from "node:dns/promises"

import { Solari, type BrowserSession } from "@solarisdk/browser"
import { SolariClient, type Sandbox } from "@solarisdk/sdk"

import type { ExpectedInvoice, ObservedBatch, VerificationSummary } from "./types.ts"
import { hashObservedRecords, verifyBatch } from "./verify.ts"

type BrowserPage = Awaited<ReturnType<BrowserSession["newPage"]>>
type BrowserContextOptions = NonNullable<Parameters<BrowserSession["newContext"]>[0]>

export interface ErpAdapter {
  readonly workerUrl: URL
  readonly verifierUrl: URL
  assertReady(): void
  probeWorkerRestrictions(page: BrowserPage, draftHref: string): Promise<Pick<PermissionEvidence, "workerCannotValidate" | "workerCannotPay">>
  writeDrafts(page: BrowserPage, invoices: readonly ExpectedInvoice[], runId: string): Promise<string>
  probeVerifierRestrictions(page: BrowserPage): Promise<Pick<PermissionEvidence, "verifierCannotMutate">>
  readDrafts(page: BrowserPage, runId: string): Promise<unknown>
}

export interface PermissionEvidence {
  workerCannotValidate: boolean
  workerCannotPay: boolean
  verifierCannotMutate: boolean
}

export interface LiveRunResult {
  runId: string
  manifest: readonly ExpectedInvoice[]
  summary: VerificationSummary
  observed: ObservedBatch
  permissions: PermissionEvidence
  lifecycle: { browsersReleased: true; sandboxKilled: true }
}

export interface LiveConfig {
  apiKey: string
  workerProfileId: string
  verifierProfileId: string
}

export interface DolibarrConnection {
  baseUrl: string
  username: string
  password: string
}

export interface ReadOnlyLiveResult {
  runId: string
  manifest: readonly ExpectedInvoice[]
  summary: VerificationSummary
  observed: ObservedBatch
  permissions: { verifierCannotMutate: true; verifierCannotPay: true }
  lifecycle: { browsersReleased: true; sandboxKilled: true }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required in live mode`)
  return value
}

function httpUrl(env: NodeJS.ProcessEnv, name: string): URL {
  return safeDolibarrUrl(required(env, name), name)
}

export function safeDolibarrUrl(value: string, name = "Dolibarr URL"): URL {
  const url = new URL(value)
  if (url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS`)
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must not contain credentials, query parameters, or fragments`)
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "localhost" || host.endsWith(".local") || (isIP(host) && privateAddress(host))) throw new Error(`${name} must use a public host`)
  return url
}

function privateAddress(address: string): boolean {
  return /^(?:0|10|127|169\.254|192\.168)\./.test(address) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(address) ||
    /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address) ||
    /^(?:198\.(?:1[89])|203\.0\.113|192\.0\.2)\./.test(address) ||
    address === "::1" || address === "::" || /^(?:fc|fd|fe[89ab])/i.test(address)
}

export async function assertPublicDolibarrDns(url: URL): Promise<void> {
  const addresses = await lookup(url.hostname, { all: true })
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) throw new Error("Dolibarr DNS must resolve only to public addresses")
}

export function liveConfigFromEnv(env = process.env): LiveConfig {
  const workerProfileId = required(env, "DONELEDGER_WORKER_PROFILE_ID")
  const verifierProfileId = required(env, "DONELEDGER_VERIFIER_PROFILE_ID")
  if (workerProfileId === verifierProfileId) {
    throw new Error("Worker and verifier must use different Solari profiles")
  }
  return {
    apiKey: required(env, "SOLARI_API_KEY"),
    workerProfileId,
    verifierProfileId,
  }
}

export function dolibarrAdapterFromEnv(env = process.env): ErpAdapter {
  const workerUrl = httpUrl(env, "DONELEDGER_WORKER_URL")
  const verifierUrl = httpUrl(env, "DONELEDGER_VERIFIER_URL")

  const base = workerUrl.origin
  const denied = async (page: BrowserPage) => /access denied/i.test(await page.locator("body").innerText())
  const go = (page: BrowserPage, path: string) => page.goto(new URL(path, base).href, { waitUntil: "domcontentloaded", timeout: 10_000 })
  const submit = async (page: BrowserPage, selector: string) => {
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10_000 }),
      page.locator(selector).click(),
    ])
  }
  const usDate = (iso: string) => {
    const [year, month, day] = iso.split("-")
    return `${month}/${day}/${year}`
  }
  const setDate = async (page: BrowserPage, prefix: "re" | "ech", iso: string) => {
    const [year, month, day] = iso.split("-")
    await page.locator(`#${prefix}`).fill(usDate(iso))
    for (const [suffix, value] of [["day", day], ["month", month], ["year", year]] as const) {
      await page.locator(`#${prefix}${suffix}`).evaluate((element, next) => {
        (element as HTMLInputElement).value = next
      }, value)
    }
  }
  const existing = async (page: BrowserPage, invoiceNumber: string) => {
    await go(page, `/fourn/facture/list.php?search_refsupplier=${encodeURIComponent(invoiceNumber)}`)
    if (await denied(page)) throw new Error("Worker cannot read supplier invoices")
    const hrefs = await page.locator('a[href*="/fourn/facture/card.php?"]').evaluateAll((links) =>
      links.map((link) => link.getAttribute("href")).filter((href): href is string => typeof href === "string" && /[?&](?:id|facid)=\d+/.test(href)),
    )
    return [...new Set(hrefs)]
  }
  const vatOption = async (page: BrowserPage, rate: number) => {
    const options = await page.locator("select#tva_tx option").evaluateAll((items) =>
      items.map((item) => ({ value: (item as HTMLOptionElement).value, text: item.textContent ?? "" })),
    )
    const option = options.find(({ value, text }) => Number.parseFloat(value || text) === rate)
    if (!option) throw new Error(`VAT rate ${rate} is unavailable`)
    return option.value
  }
  const addDraftLine = async (page: BrowserPage, invoice: ExpectedInvoice) => {
    const lineCount = await page.locator('#tablelines tr[id^="row-"]').count()
    if (lineCount > 1) throw new Error(`Draft ${invoice.jobId} has unexpected extra lines`)
    if (lineCount === 1) return
    await page.locator("#dp_desc").fill(`DoneLedger synthetic job ${invoice.jobId}`)
    if (await page.locator("#select_type").count()) await page.locator("#select_type").selectOption("0")
    await page.locator("#price_ht").fill(((invoice.jobId === "DL-018" ? 84_500 : invoice.netCents) / 100).toFixed(2))
    await page.locator("#qty").fill("1")
    if (await page.locator("select#tva_tx").count()) {
      await page.locator("select#tva_tx").selectOption(await vatOption(page, 20))
    }
    await submit(page, "#addline")
    if (await denied(page) || await page.locator('#tablelines tr[id^="row-"]').count() !== 1) {
      throw new Error(`Draft line ${invoice.jobId} was not created`)
    }
  }
  const createDraft = async (page: BrowserPage, invoice: ExpectedInvoice, copy: number, runId: string) => {
    await go(page, "/fourn/facture/card.php?action=create")
    if (await denied(page)) throw new Error("Worker cannot create supplier invoices")

    const suppliers = await page.locator("#socid option").evaluateAll((options) =>
      options.map((option) => ({ value: (option as HTMLOptionElement).value, text: option.textContent ?? "" })),
    )
    const supplier = suppliers.find(({ text }) => text.includes(`[${invoice.supplierId}]`))
    if (!supplier) throw new Error(`Supplier ${invoice.supplierId} is unavailable`)
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10_000 }),
      page.locator("#socid").selectOption(supplier.value),
    ])
    const invoiceNumber = invoice.jobId === "DL-019" && copy > 0 ? `${invoice.invoiceNumber}-DUP` : invoice.invoiceNumber
    await page.locator('input[name="ref_supplier"]').fill(invoiceNumber)
    await page.locator('input[name="label"]').fill(`${invoice.jobId} · ${runId}`)
    await setDate(page, "re", invoice.issueDate)
    await setDate(page, "ech", invoice.dueDate)
    await page.locator("#note_private").fill(`DoneLedger run ${runId} job ${invoice.jobId}`)
    await submit(page, 'input[name="save"]')
    if (await denied(page) || !/[?&](?:id|facid)=\d+/.test(page.url())) throw new Error(`Draft header ${invoice.jobId} was not created`)
    await addDraftLine(page, invoice)
  }

  return {
    workerUrl,
    verifierUrl,
    assertReady() {
      if (workerUrl.origin !== verifierUrl.origin) throw new Error("Worker and verifier must use the same Dolibarr origin")
    },
    async writeDrafts(page, invoices, runId) {
      let probeHref = ""
      for (const invoice of invoices) {
        const wanted = invoice.jobId === "DL-020" ? 0 : invoice.jobId === "DL-019" ? 2 : 1
        const found = await existing(page, invoice.invoiceNumber)
        if (found.length > wanted) throw new Error(`Too many existing records for ${invoice.jobId}`)
        for (const href of found) {
          await go(page, href)
          await addDraftLine(page, invoice)
          probeHref ||= href
        }
        for (let copy = found.length; copy < wanted; copy += 1) {
          await createDraft(page, invoice, copy, runId)
          probeHref ||= page.url()
        }
      }
      if (!probeHref) throw new Error("No draft is available for the worker permission probe")
      return probeHref
    },
    async probeWorkerRestrictions(page, draftHref) {
      const draftUrl = new URL(draftHref, base)
      draftUrl.searchParams.set("action", "validate")
      await go(page, `${draftUrl.pathname}${draftUrl.search}`)
      const workerCannotValidate = await denied(page)
      await go(page, "/fourn/paiement/card.php?action=create")
      return { workerCannotValidate, workerCannotPay: await denied(page) }
    },
    async probeVerifierRestrictions(page) {
      await go(page, "/fourn/facture/card.php?action=create")
      return { verifierCannotMutate: await denied(page) }
    },
    async readDrafts(page, runId) {
      await go(page, "/fourn/facture/list.php?button_removefilter_x=x")
      if (await denied(page)) return unavailableBatch()
      const hrefs = await page.locator('a[href*="/fourn/facture/card.php?"]').evaluateAll((links) =>
        [...new Set(links.map((link) => link.getAttribute("href")).filter((href): href is string => typeof href === "string" && /[?&](?:id|facid)=\d+/.test(href)))],
      )
      const records = []
      for (const href of hrefs) {
        await go(page, href)
        if (await denied(page)) return unavailableBatch()
        const body = await page.locator("body").innerText()
        if (!body.includes(`DoneLedger run ${runId} job `)) continue
        const jobId = body.match(/\bDL-\d{3}\b/)?.[0]
        if (!jobId) continue
        const record = await parseDolibarrDraft(page, jobId)
        if (!record) return unavailableBatch()
        records.push(record)
      }
      const observedAt = new Date().toISOString()
      return { state: "fresh", runId, observedAt, exportHash: hashObservedRecords(records), records }
    },
  }
}

export function moneyToCents(value: string): number {
  let number = value.replace(/[^\d,.-]/g, "")
  if (!number) throw new Error("Invalid money value")
  if (number.includes(",") && number.includes(".")) {
    number = number.lastIndexOf(".") > number.lastIndexOf(",") ? number.replaceAll(",", "") : number.replaceAll(".", "").replace(",", ".")
  } else if (number.includes(",")) {
    number = /,\d{2}$/.test(number) ? number.replace(",", ".") : number.replaceAll(",", "")
  }
  const parsed = Number(number)
  if (!Number.isFinite(parsed)) throw new Error("Invalid money value")
  return Math.round(parsed * 100)
}

export function dateToIso(value: string): string | undefined {
  const match = value.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/)
  if (!match) return undefined
  const [, first, second, year] = match
  const french = value.includes("Date de")
  const month = french ? second : first
  const day = french ? first : second
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`
}

async function parseDolibarrDraft(page: BrowserPage, jobId: string, expected?: ExpectedInvoice) {
  const body = await page.locator("body").innerText()
  const supplierId = expected
    ? body.includes(expected.supplierId) ? expected.supplierId : undefined
    : body.match(/\bSUP-\d{3}\b/)?.[0]
  const invoiceNumber = expected
    ? body.includes(expected.invoiceNumber) ? expected.invoiceNumber : undefined
    : body.match(/\bINV-[A-Za-z0-9-]+\b/)?.[0]
  const rows = await page.locator("tr").evaluateAll((items) => items.map((row) =>
    [...row.querySelectorAll(":scope > td")].map((cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim()),
  ))
  const rowValue = (label: RegExp) => rows.find(([name]) => label.test(name ?? ""))?.slice(1).join(" ") ?? ""
  const issueDate = dateToIso(rowValue(/Invoice date|Date de facture/i))
  const dueDate = dateToIso(rowValue(/Due date|Payment due on|Date limite de paiement/i))
  const lines = await page.locator('#tablelines tr[id^="row-"]').evaluateAll((items) => items.map((row) => ({
    net: row.querySelector(".linecolht")?.textContent ?? "",
    gross: row.querySelector(".linecoluttc")?.textContent ?? "",
  })))
  if (!supplierId || !invoiceNumber || !issueDate || !dueDate || lines.length === 0) return undefined
  const netCents = lines.reduce((sum, line) => sum + moneyToCents(line.net), 0)
  const grossCents = lines.reduce((sum, line) => sum + moneyToCents(line.gross), 0)
  return {
    jobId,
    recordId: `DOL-${new URL(page.url()).searchParams.get("id") ?? new URL(page.url()).searchParams.get("facid")}`,
    supplierId,
    invoiceNumber,
    issueDate,
    dueDate,
    currency: "EUR",
    netCents,
    taxCents: grossCents - netCents,
    grossCents,
    state: /\bDraft\b|\bBrouillon\b/i.test(body) ? "draft" as const : "posted" as const,
  }
}

export function scopeManifestForRun(
  invoices: readonly ExpectedInvoice[],
  runId: string,
): ExpectedInvoice[] {
  if (!/^[a-f0-9-]{36}$/i.test(runId)) throw new Error("runId must be a UUID")
  const suffix = runId.slice(0, 8)
  return invoices.map((invoice) => ({ ...invoice, invoiceNumber: `${invoice.invoiceNumber}-${suffix}` }))
}

const COMPARATOR = String.raw`
import hashlib, json, re
from datetime import datetime

with open("/tmp/doneledger/input.json", encoding="utf-8") as source:
    payload = json.load(source)

ground_truth = payload["groundTruth"]
observed = payload["observed"]
unknown_reason = {"timeout": "READ_TIMEOUT", "stale": "STALE_STATE", "export_unavailable": "EXPORT_UNAVAILABLE", "erp_unavailable": "ERP_UNAVAILABLE"}
fields = ["supplierId", "invoiceNumber", "issueDate", "dueDate", "currency", "netCents", "taxCents", "grossCents"]
try:
    datetime.fromisoformat(observed.get("observedAt", "").replace("Z", "+00:00"))
    date_valid = True
except ValueError:
    date_valid = False
records_hash = hashlib.sha256(json.dumps(observed.get("records", []), separators=(",", ":")).encode()).hexdigest()
metadata_valid = bool(observed.get("runId", "").strip()) and date_valid and records_hash == observed.get("exportHash")

def normalize(value):
    return value.strip().upper() if isinstance(value, str) else value

results = []
for expected in ground_truth:
    job_id = expected["jobId"]
    if not expected["truthAvailable"]:
        results.append({"jobId": job_id, "state": "unknown", "reasonCode": "GROUND_TRUTH_UNAVAILABLE", "recordIds": [], "differences": []})
        continue
    if observed["state"] != "fresh":
        results.append({"jobId": job_id, "state": "unknown", "reasonCode": unknown_reason[observed["state"]], "recordIds": [], "differences": []})
        continue
    if not metadata_valid:
        results.append({"jobId": job_id, "state": "unknown", "reasonCode": "ERP_UNAVAILABLE", "recordIds": [], "differences": []})
        continue

    records = [record for record in observed["records"] if record["jobId"] == job_id]
    record_ids = [record["recordId"] for record in records]
    if len(records) == 0:
        results.append({"jobId": job_id, "state": "exception", "reasonCode": "RECORD_MISSING", "recordIds": record_ids, "differences": []})
        continue
    if len(records) > 1:
        results.append({"jobId": job_id, "state": "exception", "reasonCode": "DUPLICATE_RECORD", "recordIds": record_ids, "differences": []})
        continue
    if records[0]["state"] != "draft":
        results.append({"jobId": job_id, "state": "exception", "reasonCode": "NOT_DRAFT", "recordIds": record_ids, "differences": []})
        continue

    differences = [{"field": field, "expected": expected[field], "observed": records[0][field]} for field in fields if normalize(expected[field]) != normalize(records[0][field])]
    if not differences:
        results.append({"jobId": job_id, "state": "verified", "reasonCode": "EXACT_MATCH", "recordIds": record_ids, "differences": []})
    else:
        reason = "TAX_MISMATCH" if any(item["field"] == "taxCents" for item in differences) else "FIELD_MISMATCH"
        results.append({"jobId": job_id, "state": "exception", "reasonCode": reason, "recordIds": record_ids, "differences": differences})

print(json.dumps({
    "total": len(results),
    "verified": sum(item["state"] == "verified" for item in results),
    "exceptions": sum(item["state"] == "exception" for item in results),
    "unknown": sum(item["state"] == "unknown" for item in results),
    "results": results,
}), end="")
`

async function compareInSandbox(
  sandbox: Sandbox,
  groundTruth: readonly ExpectedInvoice[],
  observed: ObservedBatch,
): Promise<VerificationSummary> {
  await sandbox.connect()
  await sandbox.files.mkdir("/tmp/doneledger")
  await sandbox.files.write("/tmp/doneledger/input.json", JSON.stringify({ groundTruth, observed }))
  await sandbox.files.write("/tmp/doneledger/compare.py", COMPARATOR)
  const result = await sandbox.commands.run("python3", { args: ["/tmp/doneledger/compare.py"] })
  if (result.exitCode !== 0) throw new Error(`Sandbox comparator failed with exit ${result.exitCode}`)
  return JSON.parse(result.stdout) as VerificationSummary
}

function unavailableBatch(): ObservedBatch {
  return {
    state: "erp_unavailable",
    runId: "invalid",
    observedAt: new Date(0).toISOString(),
    exportHash: "0".repeat(64),
    records: [],
  }
}

function validateObservedBatch(value: unknown): ObservedBatch {
  if (!value || typeof value !== "object") return unavailableBatch()
  const batch = value as Partial<ObservedBatch>
  const states = new Set(["fresh", "timeout", "stale", "export_unavailable", "erp_unavailable"])
  if (!batch.state || !states.has(batch.state) || !Array.isArray(batch.records)) return unavailableBatch()
  if (typeof batch.runId !== "string" || typeof batch.observedAt !== "string" || typeof batch.exportHash !== "string") return unavailableBatch()
  const recordsValid = batch.records.every((record) =>
    record &&
    typeof record === "object" &&
    typeof record.jobId === "string" &&
    typeof record.recordId === "string" &&
    typeof record.supplierId === "string" &&
    typeof record.invoiceNumber === "string" &&
    typeof record.issueDate === "string" &&
    typeof record.dueDate === "string" &&
    typeof record.currency === "string" &&
    Number.isInteger(record.netCents) &&
    Number.isInteger(record.taxCents) &&
    Number.isInteger(record.grossCents) &&
    ["draft", "posted", "paid"].includes(record.state),
  )
  if (!recordsValid) return unavailableBatch()
  if (Number.isNaN(Date.parse(batch.observedAt)) || hashObservedRecords(batch.records) !== batch.exportHash) return unavailableBatch()
  return batch as ObservedBatch
}

async function releaseBrowser(client: Solari, browser: BrowserSession): Promise<void> {
  try {
    await browser.close()
  } catch {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await client.sessions.releaseAndWait(browser.id)
        return
      } catch {
        if (attempt === 1) throw new Error("A browser session could not be released")
      }
    }
  }
}

export async function runLive(
  groundTruth: readonly ExpectedInvoice[],
  adapter: ErpAdapter,
  config: LiveConfig,
): Promise<LiveRunResult> {
  // Fail before allocating billable resources until the ERP adapter is real.
  adapter.assertReady()

  const browsers = new Solari({ apiKey: config.apiKey })
  const compute = new SolariClient({ apiKey: config.apiKey })
  const runId = randomUUID()
  const manifest = scopeManifestForRun(groundTruth, runId)
  const opened = new Set<BrowserSession>()
  let sandbox: Sandbox | undefined
  let output: Omit<LiveRunResult, "lifecycle"> | undefined

  try {
    const worker = await browsers.launch({ profileId: config.workerProfileId })
    opened.add(worker)
    const workerContext = await worker.newContext({ storageState: worker.session.storageState as BrowserContextOptions["storageState"] })
    const workerPage = await workerContext.newPage()
    workerPage.setDefaultTimeout(8_000)
    await workerPage.goto(adapter.workerUrl.href)
    const draftHref = await adapter.writeDrafts(workerPage, manifest, runId)
    const workerPermissions = await adapter.probeWorkerRestrictions(workerPage, draftHref)
    await releaseBrowser(browsers, worker)
    opened.delete(worker)

    const verifier = await browsers.launch({ profileId: config.verifierProfileId })
    opened.add(verifier)
    if (verifier.id === worker.id) throw new Error("Solari returned the same browser session twice")
    const verifierContext = await verifier.newContext({ storageState: verifier.session.storageState as BrowserContextOptions["storageState"] })
    const verifierPage = await verifierContext.newPage()
    verifierPage.setDefaultTimeout(8_000)
    await verifierPage.goto(adapter.verifierUrl.href)
    const verifierPermissions = await adapter.probeVerifierRestrictions(verifierPage)
    const observed = validateObservedBatch(await adapter.readDrafts(verifierPage, runId))
    if (observed.runId !== runId) throw new Error("ERP observation is not bound to the active run")
    await releaseBrowser(browsers, verifier)
    opened.delete(verifier)

    const permissions = { ...workerPermissions, ...verifierPermissions }
    if (!permissions.workerCannotValidate || !permissions.workerCannotPay || !permissions.verifierCannotMutate) {
      throw new Error("ERP role probes did not prove the required authority boundary")
    }

    sandbox = await compute.sandboxes.create({
      template: "base",
      timeoutMs: 5 * 60_000,
      lifecycle: { onTimeout: "kill" },
    })

    const local = verifyBatch(manifest, observed)
    const remote = await compareInSandbox(sandbox, manifest, observed)
    if (!isDeepStrictEqual(local, remote)) throw new Error("Local and sandbox verdicts disagree")
    output = { runId, manifest, summary: remote, observed, permissions }
  } finally {
    const cleanup = await Promise.allSettled([
      ...(sandbox ? [sandbox.kill()] : []),
      ...[...opened].map((browser) => releaseBrowser(browsers, browser)),
    ])
    await browsers.close()
    const failures = cleanup.filter((result) => result.status === "rejected")
    if (failures.length > 0) throw new Error("One or more Solari resources failed to clean up")
  }
  if (!output) throw new Error("Live run did not produce an artifact")
  return { ...output, lifecycle: { browsersReleased: true, sandboxKilled: true } }
}

export async function runReadOnlyLive(
  manifest: readonly ExpectedInvoice[],
  connection: DolibarrConnection,
  apiKey: string,
  options: { runId?: string; signal?: AbortSignal; onProgress?: (step: "browser" | "compare" | "cleanup") => void } = {},
): Promise<ReadOnlyLiveResult> {
  if (manifest.length < 1 || manifest.length > 25) throw new Error("A live run requires 1 to 25 claims")
  if (!apiKey.trim() || !connection.username.trim() || !connection.password) throw new Error("Live credentials are required")
  const baseUrl = safeDolibarrUrl(connection.baseUrl)
  await assertPublicDolibarrDns(baseUrl)
  const runId = options.runId ?? randomUUID()
  const browsers = new Solari({ apiKey, maxAttempts: 1, timeoutMs: 15_000 })
  const compute = new SolariClient({ apiKey, callTimeoutMs: 30_000 })
  let browser: BrowserSession | undefined
  let sandbox: Sandbox | undefined
  let observed: ObservedBatch | undefined
  let summary: VerificationSummary | undefined

  try {
    options.signal?.throwIfAborted()
    options.onProgress?.("browser")
    browser = await browsers.launch({ proxy: "off", recording: false, retries: 0 })
    const page = await browser.newPage()
    page.setDefaultTimeout(8_000)
    const go = async (path: string) => {
      const target = new URL(path, baseUrl)
      if (target.origin !== baseUrl.origin) throw new Error("Dolibarr navigation left the allowed origin")
      await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 10_000 })
      if (new URL(page.url()).origin !== baseUrl.origin) throw new Error("Dolibarr redirected outside the allowed origin")
    }
    const denied = async () => /access denied|accès refusé/i.test(await page.locator("body").innerText())

    await go(baseUrl.href)
    if (await page.locator("#username").count()) {
      await page.locator("#username").fill(connection.username)
      await page.locator("#password").fill(connection.password)
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10_000 }),
        page.locator('button[type="submit"], input[type="submit"]').click(),
      ])
      if (new URL(page.url()).origin !== baseUrl.origin) throw new Error("Dolibarr login redirected outside the allowed origin")
    }
    if (await page.locator("#username").count()) throw new Error("Dolibarr login failed")

    await go("/fourn/facture/card.php?action=create")
    const verifierCannotMutate = await denied()
    await go("/fourn/paiement/card.php?action=create")
    const verifierCannotPay = await denied()
    if (!verifierCannotMutate || !verifierCannotPay) throw new Error("The Dolibarr account is not read-only")

    const records = []
    for (const expected of manifest) {
      options.signal?.throwIfAborted()
      await go(`/fourn/facture/list.php?search_refsupplier=${encodeURIComponent(expected.invoiceNumber)}`)
      if (await denied()) throw new Error("The Dolibarr account cannot read supplier invoices")
      const hrefs = await page.locator('a[href*="/fourn/facture/card.php?"]').evaluateAll((links) =>
        [...new Set(links.map((link) => link.getAttribute("href")).filter((href): href is string => typeof href === "string" && /[?&](?:id|facid)=\d+/.test(href)))],
      )
      for (const href of hrefs) {
        await go(href)
        const record = await parseDolibarrDraft(page, expected.jobId, expected)
        if (record) records.push(record)
      }
    }
    observed = {
      state: "fresh",
      runId,
      observedAt: new Date().toISOString(),
      exportHash: hashObservedRecords(records),
      records,
    }
    await releaseBrowser(browsers, browser)
    browser = undefined

    options.signal?.throwIfAborted()
    options.onProgress?.("compare")
    sandbox = await compute.sandboxes.create({
      template: "base",
      timeoutMs: 5 * 60_000,
      lifecycle: { onTimeout: "kill" },
    })
    const local = verifyBatch(manifest, observed)
    const remote = await compareInSandbox(sandbox, manifest, observed)
    if (!isDeepStrictEqual(local, remote)) throw new Error("Local and sandbox verdicts disagree")
    summary = remote
  } finally {
    options.onProgress?.("cleanup")
    const cleanup = await Promise.allSettled([
      ...(sandbox ? [sandbox.kill()] : []),
      ...(browser ? [releaseBrowser(browsers, browser)] : []),
    ])
    await browsers.close()
    if (cleanup.some((result) => result.status === "rejected")) throw new Error("One or more Solari resources failed to clean up")
  }
  if (!observed || !summary) throw new Error("Live run did not produce an artifact")
  return {
    runId,
    manifest,
    observed,
    summary,
    permissions: { verifierCannotMutate: true, verifierCannotPay: true },
    lifecycle: { browsersReleased: true, sandboxKilled: true },
  }
}
