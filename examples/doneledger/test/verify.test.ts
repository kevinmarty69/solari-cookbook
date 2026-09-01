import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { ExpectedInvoice, ObservedBatch, ReasonCode } from "../src/types.ts";
import { dateToIso, dolibarrAdapterFromEnv, liveConfigFromEnv, moneyToCents } from "../src/solari.ts";
import { hashObservedRecords, verifyBatch } from "../src/verify.ts";

function fixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8"),
  ) as T;
}

const groundTruth = fixture<ExpectedInvoice[]>("ground-truth.json");
const canonical = fixture<ObservedBatch>("observed-canonical.json");

test("canonical batch returns 17 exact matches and three explicit exceptions", () => {
  const result = verifyBatch(groundTruth, canonical);

  assert.deepEqual(
    { total: result.total, verified: result.verified, exceptions: result.exceptions, unknown: result.unknown },
    { total: 20, verified: 17, exceptions: 3, unknown: 0 },
  );
  assert.equal(result.results.find(({ jobId }) => jobId === "DL-018")?.reasonCode, "TAX_MISMATCH");
  assert.equal(result.results.find(({ jobId }) => jobId === "DL-019")?.reasonCode, "DUPLICATE_RECORD");
  assert.equal(result.results.find(({ jobId }) => jobId === "DL-020")?.reasonCode, "RECORD_MISSING");
  assert.equal(result.results.filter(({ reasonCode }) => reasonCode === "EXACT_MATCH").length, 17);
});

test("unavailable or stale truth fails closed to unknown", () => {
  const expectedReasons: Array<[ObservedBatch["state"], ReasonCode]> = [
    ["timeout", "READ_TIMEOUT"],
    ["stale", "STALE_STATE"],
    ["export_unavailable", "EXPORT_UNAVAILABLE"],
    ["erp_unavailable", "ERP_UNAVAILABLE"],
  ];

  for (const [state, reasonCode] of expectedReasons) {
    const result = verifyBatch([groundTruth[0]], { ...canonical, state, records: [] });
    assert.equal(result.unknown, 1);
    assert.equal(result.results[0].reasonCode, reasonCode);
  }

  const result = verifyBatch([{ ...groundTruth[0], truthAvailable: false }], canonical);
  assert.equal(result.unknown, 1);
  assert.equal(result.results[0].reasonCode, "GROUND_TRUTH_UNAVAILABLE");
});

test("the frozen field contract and draft boundary are enforced", () => {
  const record = canonical.records[0];
  const mismatchedRecords = [{ ...record, dueDate: "2026-09-30" }];
  const postedRecords = [{ ...record, state: "posted" as const }];
  const fieldMismatch = verifyBatch([groundTruth[0]], {
    ...canonical,
    records: mismatchedRecords,
    exportHash: hashObservedRecords(mismatchedRecords),
  });
  const posted = verifyBatch([groundTruth[0]], {
    ...canonical,
    records: postedRecords,
    exportHash: hashObservedRecords(postedRecords),
  });

  assert.equal(fieldMismatch.results[0].reasonCode, "FIELD_MISMATCH");
  assert.equal(posted.results[0].reasonCode, "NOT_DRAFT");
});

test("comparison is deterministic and does not mutate its inputs", () => {
  const truthBefore = structuredClone(groundTruth);
  const observedBefore = structuredClone(canonical);

  assert.deepEqual(verifyBatch(groundTruth, canonical), verifyBatch(groundTruth, canonical));
  assert.deepEqual(groundTruth, truthBefore);
  assert.deepEqual(canonical, observedBefore);
});

test("a matching invoice from a prior run never satisfies the current job", () => {
  const priorRun = {
    ...canonical.records[0],
    jobId: "PRIOR-RUN",
  };
  const result = verifyBatch([groundTruth[0]], {
    ...canonical,
    records: [priorRun],
    exportHash: hashObservedRecords([priorRun]),
  });

  assert.equal(result.results[0].reasonCode, "RECORD_MISSING");
});

test("fresh observations without evidence metadata fail closed", () => {
  const result = verifyBatch([groundTruth[0]], {
    ...canonical,
    exportHash: "not-a-hash",
  });

  assert.equal(result.results[0].state, "unknown");
  assert.equal(result.results[0].reasonCode, "ERP_UNAVAILABLE");
});

test("live configuration rejects embedded secrets and shared profiles before allocation", () => {
  assert.throws(() => dolibarrAdapterFromEnv({
    DONELEDGER_WORKER_URL: "https://erp.example/invoices?token=secret",
    DONELEDGER_VERIFIER_URL: "https://erp.example/invoices",
  }), /must not contain credentials/);
  assert.throws(() => liveConfigFromEnv({
    SOLARI_API_KEY: "redacted",
    DONELEDGER_WORKER_PROFILE_ID: "same",
    DONELEDGER_VERIFIER_PROFILE_ID: "same",
  }), /different Solari profiles/);
});

test("Dolibarr money and date values normalize without locale drift", () => {
  assert.equal(moneyToCents("€1,176.00"), 117600);
  assert.equal(moneyToCents("1 176,00 €"), 117600);
  assert.throws(() => moneyToCents(""), /Invalid money value/);
  assert.equal(dateToIso("Invoice date 08/18/2026"), "2026-08-18");
  assert.equal(dateToIso("Date de facture 18/08/2026"), "2026-08-18");
});
