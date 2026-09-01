import { createHash } from "node:crypto";

import type {
  Difference,
  ExpectedInvoice,
  ObservedBatch,
  ObservedInvoice,
  ReasonCode,
  Verification,
  VerificationSummary,
} from "./types.ts";

const UNKNOWN_REASON = {
  timeout: "READ_TIMEOUT",
  stale: "STALE_STATE",
  export_unavailable: "EXPORT_UNAVAILABLE",
  erp_unavailable: "ERP_UNAVAILABLE",
} as const satisfies Record<Exclude<ObservedBatch["state"], "fresh">, ReasonCode>;

const comparedFields = [
  "supplierId",
  "invoiceNumber",
  "issueDate",
  "dueDate",
  "currency",
  "netCents",
  "taxCents",
  "grossCents",
] as const;

function normalize(value: string): string {
  return value.trim().toUpperCase();
}

function unknown(jobId: string, reasonCode: ReasonCode): Verification {
  return { jobId, state: "unknown", reasonCode, recordIds: [], differences: [] };
}

export function hashObservedRecords(records: ObservedBatch["records"]): string {
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

function differences(expected: ExpectedInvoice, observed: ObservedInvoice): Difference[] {
  return comparedFields.flatMap((field) => {
    const expectedValue = expected[field];
    const observedValue = observed[field];
    const matches =
      typeof expectedValue === "string" && typeof observedValue === "string"
        ? normalize(expectedValue) === normalize(observedValue)
        : expectedValue === observedValue;

    return matches ? [] : [{ field, expected: expectedValue, observed: observedValue }];
  });
}

function verifyInvoice(
  expected: ExpectedInvoice,
  batch: ObservedBatch,
): Verification {
  if (!expected.truthAvailable) {
    return unknown(expected.jobId, "GROUND_TRUTH_UNAVAILABLE");
  }

  if (batch.state !== "fresh") {
    return unknown(expected.jobId, UNKNOWN_REASON[batch.state]);
  }

  if (
    typeof batch.runId !== "string" ||
    !batch.runId.trim() ||
    typeof batch.observedAt !== "string" ||
    Number.isNaN(Date.parse(batch.observedAt)) ||
    typeof batch.exportHash !== "string" ||
    !/^[a-f0-9]{64}$/i.test(batch.exportHash) ||
    hashObservedRecords(batch.records) !== batch.exportHash
  ) {
    return unknown(expected.jobId, "ERP_UNAVAILABLE");
  }

  const records = batch.records.filter((record) => record.jobId === expected.jobId);
  const recordIds = records.map(({ recordId }) => recordId);

  if (records.length === 0) {
    return {
      jobId: expected.jobId,
      state: "exception",
      reasonCode: "RECORD_MISSING",
      recordIds,
      differences: [],
    };
  }

  if (records.length > 1) {
    return {
      jobId: expected.jobId,
      state: "exception",
      reasonCode: "DUPLICATE_RECORD",
      recordIds,
      differences: [],
    };
  }

  const [record] = records;
  if (record.state !== "draft") {
    return {
      jobId: expected.jobId,
      state: "exception",
      reasonCode: "NOT_DRAFT",
      recordIds,
      differences: [],
    };
  }

  const mismatches = differences(expected, record);
  const reasonCode = mismatches.some(({ field }) => field === "taxCents")
    ? "TAX_MISMATCH"
    : "FIELD_MISMATCH";

  return mismatches.length === 0
    ? {
        jobId: expected.jobId,
        state: "verified",
        reasonCode: "EXACT_MATCH",
        recordIds,
        differences: [],
      }
    : {
        jobId: expected.jobId,
        state: "exception",
        reasonCode,
        recordIds,
        differences: mismatches,
      };
}

export function verifyBatch(
  groundTruth: readonly ExpectedInvoice[],
  observed: ObservedBatch,
): VerificationSummary {
  const results = groundTruth.map((expected) => verifyInvoice(expected, observed));

  return {
    total: results.length,
    verified: results.filter(({ state }) => state === "verified").length,
    exceptions: results.filter(({ state }) => state === "exception").length,
    unknown: results.filter(({ state }) => state === "unknown").length,
    results,
  };
}
