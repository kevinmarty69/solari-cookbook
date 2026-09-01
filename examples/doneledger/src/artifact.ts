import { randomUUID } from "node:crypto"

import type { ExpectedInvoice, ObservedBatch, VerificationSummary } from "./types.ts"

export interface RunArtifact {
  runId: string
  mode: "fixture" | "live"
  authorityModel: "simulation" | "seeded_worker" | "read_only_verifier"
  synthetic: boolean
  generatedAt: string
  manifestHash: string
  exportHash?: string
  summary: { claimed: number; verified: number; exceptions: number; unknown: number }
  items: Array<{
    jobId: string
    status: "verified" | "exception" | "unknown"
    reasonCode: string
    expectedTotal?: number
    observedTotal?: number
    currency?: string
    recordIds: string[]
    differences: VerificationSummary["results"][number]["differences"]
  }>
  permissionEvidence?: {
    workerCannotValidate?: boolean
    workerCannotPay?: boolean
    verifierCannotMutate?: boolean
    verifierCannotPay?: boolean
  }
  lifecycle?: { browsersReleased?: boolean; sandboxKilled?: boolean }
  disclaimer: string
}

export function buildArtifact(options: {
  mode: RunArtifact["mode"]
  authorityModel?: RunArtifact["authorityModel"]
  synthetic: boolean
  summary: VerificationSummary
  manifest: readonly ExpectedInvoice[]
  manifestHash: string
  observed?: ObservedBatch
  permissionEvidence?: RunArtifact["permissionEvidence"]
  lifecycle?: RunArtifact["lifecycle"]
  now?: Date
  runId?: string
}): RunArtifact {
  const expected = new Map(options.manifest.map((invoice) => [invoice.jobId, invoice]))
  const observed = new Map(options.observed?.records.map((invoice) => [invoice.jobId, invoice]) ?? [])
  return {
    runId: options.runId ?? randomUUID(),
    mode: options.mode,
    authorityModel: options.authorityModel ?? (options.mode === "fixture" ? "simulation" : "read_only_verifier"),
    synthetic: options.synthetic,
    generatedAt: (options.now ?? new Date()).toISOString(),
    manifestHash: options.manifestHash,
    exportHash: options.observed?.exportHash,
    summary: {
      claimed: options.summary.total,
      verified: options.summary.verified,
      exceptions: options.summary.exceptions,
      unknown: options.summary.unknown,
    },
    items: options.summary.results.map((result) => {
      const wanted = expected.get(result.jobId)
      const found = observed.get(result.jobId)
      return {
        jobId: result.jobId,
        status: result.state,
        reasonCode: result.reasonCode,
        expectedTotal: wanted && wanted.grossCents / 100,
        observedTotal: found && found.grossCents / 100,
        currency: wanted?.currency,
        recordIds: result.recordIds,
        differences: result.differences,
      }
    }),
    permissionEvidence: options.permissionEvidence,
    lifecycle: options.lifecycle,
    disclaimer: options.synthetic
      ? `${options.mode === "fixture" ? "Simulated demo" : "Synthetic live run"}; not production finance evidence.`
      : "Verification evidence only; not an approval, payment authorization, or compliance assessment.",
  }
}
