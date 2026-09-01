import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import type { Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { parseInvoiceCsv } from "../src/csv.ts"
import { createDoneLedgerServer } from "../src/server.ts"
import type { ObservedBatch } from "../src/types.ts"
import { verifyBatch } from "../src/verify.ts"

const HEADER = "job_id,supplier_id,invoice_number,issue_date,due_date,currency,net,tax,gross"
const ROW = 'JOB-1,"SUP, 1",INV-1,2026-09-01,2026-09-30,eur,100.00,20.00,120.00'

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address === "object")
  return `http://127.0.0.1:${address.port}`
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

test("CSV import handles quoted fields and rejects unsafe manifests", () => {
  const invoices = parseInvoiceCsv(`${HEADER}\n${ROW}\n`)
  assert.equal(invoices[0].supplierId, "SUP, 1")
  assert.equal(invoices[0].grossCents, 12_000)
  assert.throws(() => parseInvoiceCsv(`${HEADER}\n${ROW.replace("120.00", "121.00")}`), /gross must equal/)
  assert.throws(() => parseInvoiceCsv(`${HEADER}\n${Array.from({ length: 26 }, (_, index) => ROW.replace("JOB-1", `JOB-${index}`)).join("\n")}`), /at most 25/)
})

test("demo history is owner-scoped, shareable, revocable, atomic and expirable", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "doneledger-test-"))
  let time = Date.parse("2026-09-01T12:00:00Z")
  const server = createDoneLedgerServer({ dataDir, retentionMs: 1_000, now: () => time })
  const origin = await listen(server)
  try {
    const createdResponse = await fetch(`${origin}/api/demo-runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
    assert.equal(createdResponse.status, 201)
    const cookie = createdResponse.headers.get("set-cookie")?.split(";", 1)[0]
    assert(cookie)
    const created = await createdResponse.json() as { run: { runId: string; summary: { verified: number } } }
    assert.equal(created.run.summary.verified, 17)

    assert.equal((await fetch(`${origin}/api/runs/${created.run.runId}`)).status, 404)
    assert.equal((await fetch(`${origin}/api/runs/${created.run.runId}`, { headers: { Cookie: cookie } })).status, 200)

    const shareResponse = await fetch(`${origin}/api/runs/${created.run.runId}/share`, { method: "POST", headers: { Cookie: cookie } })
    assert.equal(shareResponse.status, 201)
    const shared = await shareResponse.json() as { url: string }
    const token = shared.url.split("#")[1]
    assert(token)
    assert.equal(((await (await fetch(`${origin}/api/runs/${created.run.runId}`, { headers: { Cookie: cookie } })).json()) as { run: { shared: boolean } }).run.shared, true)
    const storedFile = (await readdir(dataDir)).find((name) => name.endsWith(".json"))
    assert(storedFile)
    const storedSource = await readFile(join(dataDir, storedFile), "utf8")
    assert(!storedSource.includes(cookie.split("=")[1]))
    assert(!storedSource.includes(token))
    assert.deepEqual((await readdir(dataDir)).filter((name) => name.endsWith(".tmp")), [])

    assert.equal((await fetch(`${origin}/api/reports/${created.run.runId}/access`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    })).status, 200)
    assert.equal((await fetch(`${origin}/api/runs/${created.run.runId}/share`, { method: "DELETE", headers: { Cookie: cookie } })).status, 204)
    assert.equal(((await (await fetch(`${origin}/api/runs/${created.run.runId}`, { headers: { Cookie: cookie } })).json()) as { run: { shared: boolean } }).run.shared, false)
    assert.equal((await fetch(`${origin}/api/reports/${created.run.runId}/access`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    })).status, 404)

    time += 1_001
    const history = await fetch(`${origin}/api/runs`, { headers: { Cookie: cookie } })
    assert.deepEqual(await history.json(), { runs: [] })
    assert.deepEqual((await readdir(dataDir)).filter((name) => name.endsWith(".json")), [])
  } finally {
    await close(server)
    await rm(dataDir, { recursive: true, force: true })
  }
})

test("live API fails closed without a connector and never persists submitted secrets", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "doneledger-live-test-"))
  const server = createDoneLedgerServer({ dataDir })
  const origin = await listen(server)
  try {
    const response = await fetch(`${origin}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        csv: `${HEADER}\n${ROW}`,
        dolibarr: { baseUrl: "https://erp.example", username: "reader", password: "do-not-store" },
        accessCode: "invite",
      }),
    })
    assert.equal(response.status, 503)
    assert.deepEqual(await readdir(dataDir), [])
  } finally {
    await close(server)
    await rm(dataDir, { recursive: true, force: true })
  }
})

test("configured live runs persist evidence but not Dolibarr credentials", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "doneledger-live-ok-test-"))
  const observed = JSON.parse(await readFile(new URL("../fixtures/observed-canonical.json", import.meta.url), "utf8")) as ObservedBatch
  const server = createDoneLedgerServer({
    dataDir,
    liveAccessCode: "invite-only",
    liveRunner: async ({ runId, manifest, dolibarr }) => {
      assert.equal(dolibarr.password, "do-not-store")
      const current = { ...observed, runId }
      return {
        runId,
        summary: verifyBatch(manifest, current),
        observed: current,
        synthetic: true,
        permissionEvidence: { verifierCannotMutate: true, verifierCannotPay: true },
        lifecycle: { browsersReleased: true, sandboxKilled: true },
      }
    },
  })
  const origin = await listen(server)
  try {
    const response = await fetch(`${origin}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        csv: `${HEADER}\nDL-001,SUP-001,INV-1001,2026-08-01,2026-08-31,EUR,100.00,20.00,120.00`,
        dolibarr: { baseUrl: "https://erp.example", username: "reader", password: "do-not-store" },
        accessCode: "invite-only",
      }),
    })
    assert.equal(response.status, 202)
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0]
    assert(cookie)
    const started = await response.json() as { job: { runId: string } }
    let status = "running"
    for (let attempt = 0; attempt < 50 && status === "running"; attempt += 1) {
      const polled = await fetch(`${origin}/api/jobs/${started.job.runId}`, { headers: { Cookie: cookie } })
      status = ((await polled.json()) as { job: { status: string } }).job.status
      if (status === "running") await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(status, "complete")
    const stored = await readFile(join(dataDir, (await readdir(dataDir))[0]), "utf8")
    for (const secret of ["reader", "do-not-store", "invite-only"]) assert(!stored.includes(secret))

    const oversized = await fetch(`${origin}/api/demo-runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv: "x".repeat(256 * 1024) }),
    })
    assert.equal(oversized.status, 413)
  } finally {
    await close(server)
    await rm(dataDir, { recursive: true, force: true })
  }
})
