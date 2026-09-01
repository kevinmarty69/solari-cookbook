import { isDeepStrictEqual } from "node:util"

import { Solari, type BrowserSession } from "@solarisdk/browser"
import { SolariClient, type Sandbox } from "@solarisdk/sdk"

import type { ExpectedInvoice, ObservedBatch, VerificationSummary } from "./types.ts"
import { hashObservedRecords, verifyBatch } from "./verify.ts"

type BrowserPage = Awaited<ReturnType<BrowserSession["newPage"]>>

export interface ErpAdapter {
  readonly workerUrl: URL
  readonly verifierUrl: URL
  assertReady(): void
  probeWorkerRestrictions(page: BrowserPage): Promise<Pick<PermissionEvidence, "workerCannotValidate" | "workerCannotPay">>
  writeDrafts(page: BrowserPage, invoices: readonly ExpectedInvoice[]): Promise<void>
  probeVerifierRestrictions(page: BrowserPage): Promise<Pick<PermissionEvidence, "verifierCannotMutate">>
  readDrafts(page: BrowserPage): Promise<unknown>
}

export interface PermissionEvidence {
  workerCannotValidate: boolean
  workerCannotPay: boolean
  verifierCannotMutate: boolean
}

export interface LiveRunResult {
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

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required in live mode`)
  return value
}

function httpUrl(env: NodeJS.ProcessEnv, name: string): URL {
  const url = new URL(required(env, name))
  if (url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS`)
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must not contain credentials, query parameters, or fragments`)
  }
  return url
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

  return {
    workerUrl,
    verifierUrl,
    assertReady() {
      throw new Error(
        "Live Dolibarr adapter is disabled: selectors and role permissions have not been validated. Fixture mode remains available.",
      )
    },
    async writeDrafts() {
      throw new Error("Unvalidated Dolibarr worker adapter")
    },
    async probeWorkerRestrictions() {
      throw new Error("Unvalidated Dolibarr worker permission probes")
    },
    async probeVerifierRestrictions() {
      throw new Error("Unvalidated Dolibarr verifier permission probes")
    },
    async readDrafts() {
      throw new Error("Unvalidated Dolibarr verifier adapter")
    },
  }
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
  const opened = new Set<BrowserSession>()
  let sandbox: Sandbox | undefined
  let output: Omit<LiveRunResult, "lifecycle"> | undefined

  try {
    const worker = await browsers.launch({ profileId: config.workerProfileId })
    opened.add(worker)
    const workerPage = await worker.newPage()
    await workerPage.goto(adapter.workerUrl.href)
    const workerPermissions = await adapter.probeWorkerRestrictions(workerPage)
    await adapter.writeDrafts(workerPage, groundTruth)
    await releaseBrowser(browsers, worker)
    opened.delete(worker)

    const verifier = await browsers.launch({ profileId: config.verifierProfileId })
    opened.add(verifier)
    if (verifier.id === worker.id) throw new Error("Solari returned the same browser session twice")
    const verifierPage = await verifier.newPage()
    await verifierPage.goto(adapter.verifierUrl.href)
    const verifierPermissions = await adapter.probeVerifierRestrictions(verifierPage)
    const observed = validateObservedBatch(await adapter.readDrafts(verifierPage))
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

    const local = verifyBatch(groundTruth, observed)
    const remote = await compareInSandbox(sandbox, groundTruth, observed)
    if (!isDeepStrictEqual(local, remote)) throw new Error("Local and sandbox verdicts disagree")
    output = { summary: remote, observed, permissions }
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
