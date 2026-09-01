import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import type { ExpectedInvoice, ObservedBatch, VerificationSummary } from "./types.ts"
import { verifyBatch } from "./verify.ts"
import {
  dolibarrAdapterFromEnv,
  liveConfigFromEnv,
  runLive,
  type LiveRunResult,
  type PermissionEvidence,
} from "./solari.ts"

type Mode = "fixture" | "live"

async function fixture<T>(name: string): Promise<T> {
  const url = new URL(`../fixtures/${name}`, import.meta.url)
  return JSON.parse(await readFile(url, "utf8")) as T
}

async function fixtureSource(name: string): Promise<string> {
  return readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8")
}

function mode(): Mode {
  if (process.argv.includes("--live")) return "live"
  if (process.argv.includes("--fixture")) return "fixture"
  const value = process.env.DONELEDGER_MODE?.trim() || "fixture"
  if (value !== "fixture" && value !== "live") {
    throw new Error("DONELEDGER_MODE must be fixture or live")
  }
  return value
}

async function writeResult(
  runMode: Mode,
  summary: VerificationSummary,
  groundTruth: readonly ExpectedInvoice[],
  manifestHash: string,
  observed?: ObservedBatch,
  permissions?: PermissionEvidence,
  lifecycle?: LiveRunResult["lifecycle"],
): Promise<void> {
  const resultsDir = fileURLToPath(new URL("../results/", import.meta.url))
  await mkdir(resultsDir, { recursive: true })
  const expected = new Map(groundTruth.map((invoice) => [invoice.jobId, invoice]))
  const observedByJob = new Map(
    observed?.records.map((invoice) => [invoice.jobId, invoice]) ?? [],
  )
  const artifact = {
    runId: runMode === "fixture" ? "fixture-canonical" : randomUUID(),
    mode: runMode,
    synthetic: true,
    generatedAt: runMode === "fixture" ? "2026-09-01T00:00:00.000Z" : new Date().toISOString(),
    manifestHash,
    exportHash: observed?.exportHash,
    summary: {
      claimed: summary.total,
      verified: summary.verified,
      exceptions: summary.exceptions,
      unknown: summary.unknown,
    },
    items: summary.results.map((result) => {
      const expectedInvoice = expected.get(result.jobId)
      const observedInvoice = observedByJob.get(result.jobId)
      return {
        jobId: result.jobId,
        status: result.state,
        reasonCode: result.reasonCode,
        expectedTotal: expectedInvoice && expectedInvoice.grossCents / 100,
        observedTotal: observedInvoice && observedInvoice.grossCents / 100,
        currency: expectedInvoice?.currency,
        recordIds: result.recordIds,
        differences: result.differences,
      }
    }),
    permissionEvidence: permissions,
    lifecycle,
    disclaimer: runMode === "fixture"
      ? "Synthetic fixture; not production finance evidence."
      : "Synthetic live run; not production finance evidence.",
  }
  await writeFile(
    new URL("../results/run.json", import.meta.url),
    `${JSON.stringify(artifact, null, 2)}\n`,
  )
}

async function main(): Promise<void> {
  const runMode = mode()
  const groundTruthSource = await fixtureSource("ground-truth.json")
  const groundTruth = JSON.parse(groundTruthSource) as ExpectedInvoice[]
  const manifestHash = createHash("sha256").update(groundTruthSource).digest("hex")
  let summary: VerificationSummary
  let observed: ObservedBatch | undefined
  let live: LiveRunResult | undefined

  if (runMode === "live") {
    live = await runLive(
      groundTruth,
      dolibarrAdapterFromEnv(),
      liveConfigFromEnv(),
    )
    summary = live.summary
    observed = live.observed
  } else {
    observed = await fixture<ObservedBatch>("observed-canonical.json")
    summary = verifyBatch(groundTruth, observed)
  }

  await writeResult(runMode, summary, groundTruth, manifestHash, observed, live?.permissions, live?.lifecycle)
  console.log(
    `DoneLedger: ${summary.verified}/${summary.total} verified, ${summary.exceptions} exceptions, ${summary.unknown} unknown`,
  )
}

await main().catch(() => {
  console.error("DoneLedger failed without allocating further resources. Check the local configuration and retry once.")
  process.exitCode = 1
})
