export type ObservationState =
  | "fresh"
  | "timeout"
  | "stale"
  | "export_unavailable"
  | "erp_unavailable";

export type ReasonCode =
  | "EXACT_MATCH"
  | "TAX_MISMATCH"
  | "DUPLICATE_RECORD"
  | "RECORD_MISSING"
  | "FIELD_MISMATCH"
  | "NOT_DRAFT"
  | "READ_TIMEOUT"
  | "STALE_STATE"
  | "EXPORT_UNAVAILABLE"
  | "ERP_UNAVAILABLE"
  | "GROUND_TRUTH_UNAVAILABLE";

export interface InvoiceFields {
  jobId: string;
  supplierId: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  netCents: number;
  taxCents: number;
  grossCents: number;
}

export interface ExpectedInvoice extends InvoiceFields {
  truthAvailable: boolean;
}

export interface ObservedInvoice extends InvoiceFields {
  recordId: string;
  state: "draft" | "posted" | "paid";
}

export interface ObservedBatch {
  state: ObservationState;
  runId: string;
  observedAt: string;
  exportHash: string;
  records: readonly ObservedInvoice[];
}

export interface Difference {
  field: keyof Omit<InvoiceFields, "jobId">;
  expected: string | number;
  observed: string | number;
}

export interface Verification {
  jobId: string;
  state: "verified" | "exception" | "unknown";
  reasonCode: ReasonCode;
  recordIds: string[];
  differences: Difference[];
}

export interface VerificationSummary {
  total: number;
  verified: number;
  exceptions: number;
  unknown: number;
  results: Verification[];
}
