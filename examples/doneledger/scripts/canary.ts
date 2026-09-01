import { readFile } from "node:fs/promises"

import { dolibarrAdapterFromEnv, liveConfigFromEnv, runLive } from "../src/solari.ts"
import type { ExpectedInvoice } from "../src/types.ts"

const invoices = JSON.parse(await readFile(new URL("../fixtures/ground-truth.json", import.meta.url), "utf8")) as ExpectedInvoice[]
const result = await runLive([invoices[0]], dolibarrAdapterFromEnv(), liveConfigFromEnv())
if (result.summary.verified !== 1 || result.summary.unknown || result.summary.exceptions) {
  throw new Error("Canary did not verify exactly one invoice")
}
console.log("DoneLedger canary: 1/1 verified; permissions and cleanup passed")
