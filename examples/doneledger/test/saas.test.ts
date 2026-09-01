import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import { request as httpRequest, type Server } from "node:http"
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

async function signup(origin: string, email: string, password = "a-secure-passphrase"): Promise<string> {
  const response = await fetch(`${origin}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  })
  assert.equal(response.status, 201)
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0]
  assert(cookie)
  return cookie
}

test("CSV import handles quoted fields and rejects unsafe manifests", () => {
  const invoices = parseInvoiceCsv(`${HEADER}\n${ROW}\n`)
  assert.equal(invoices[0].supplierId, "SUP, 1")
  assert.equal(invoices[0].grossCents, 12_000)
  assert.throws(() => parseInvoiceCsv(`${HEADER}\n${ROW.replace("120.00", "121.00")}`), /gross must equal/)
  assert.throws(() => parseInvoiceCsv(`${HEADER}\n${Array.from({ length: 26 }, (_, index) => ROW.replace("JOB-1", `JOB-${index}`)).join("\n")}`), /at most 25/)
})

test("authenticated manifest validation reuses the server CSV contract without starting live work", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "doneledger-manifest-test-"))
  let liveCalls = 0
  const server = createDoneLedgerServer({
    dataDir,
    liveAccessCode: "private-access-code",
    allowedDolibarrOrigins: new Set(["https://erp.example.com"]),
    liveRunner: async () => {
      liveCalls += 1
      throw new Error("must not run")
    },
  })
  const origin = await listen(server)
  try {
    const csv = `${HEADER}\n${ROW}`
    const anonymous = await fetch(`${origin}/api/manifests/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv }),
    })
    assert.equal(anonymous.status, 401)

    const cookie = await signup(origin, "manifest@example.com")
    const valid = await fetch(`${origin}/api/manifests/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ csv }),
    })
    assert.equal(valid.status, 200)
    assert.deepEqual(await valid.json(), {
      headers: HEADER.split(","),
      rowCount: 1,
      preview: [["JOB-1", "SUP, 1", "INV-1", "2026-09-01", "2026-09-30", "EUR", "100.00", "20.00", "120.00"]],
    })

    const invalid = await fetch(`${origin}/api/manifests/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ csv: csv.replace("120.00", "121.00") }),
    })
    assert.equal(invalid.status, 400)
    assert.match((await invalid.json() as { error: string }).error, /gross must equal/)

    for (const [file, verified, claimed] of [["01-success-2-of-2.csv", 2, 2], ["02-mixed-3-verified-of-5.csv", 3, 5]] as const) {
      const fixtureCsv = await readFile(new URL(`../public/test-kit/${file}`, import.meta.url), "utf8")
      const demo = await fetch(`${origin}/api/demo-runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ csv: fixtureCsv }),
      })
      assert.equal(demo.status, 201)
      const run = (await demo.json() as { run: { mode: string; summary: { verified: number; claimed: number } } }).run
      assert.deepEqual({ mode: run.mode, verified: run.summary.verified, claimed: run.summary.claimed }, { mode: "fixture", verified, claimed })
    }
    assert.equal(liveCalls, 0)
  } finally {
    await close(server)
    await rm(dataDir, { recursive: true, force: true })
  }
})

test("signup, login and logout use persistent hashed accounts and expiring sessions", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "doneledger-auth-test-"))
  let time = Date.parse("2026-09-01T12:00:00Z")
  const server = createDoneLedgerServer({ dataDir, sessionMs: 1_000, now: () => time })
  const origin = await listen(server)
  try {
    const sample = await fetch(`${origin}/api/public-sample`)
    assert.equal(sample.status, 200)
    assert.equal(((await sample.json()) as { run: { summary: { verified: number } } }).run.summary.verified, 17)
    const anonymous = await fetch(`${origin}/api/demo-runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
    assert.equal(anonymous.status, 401)
    assert.deepEqual(await anonymous.json(), { error: "Authentication required" })
    const signupResponse = await fetch(`${origin}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alice Founder", email: " Alice@Example.com ", password: "a-secure-passphrase" }),
    })
    assert.equal(signupResponse.status, 201)
    const cookie = signupResponse.headers.get("set-cookie")?.split(";", 1)[0]
    assert(cookie)
    const me = await fetch(`${origin}/api/me`, { headers: { Cookie: cookie } })
    const identity = (await me.json() as { user: { id: string; name: string; email: string } }).user
    assert.deepEqual({ name: identity.name, email: identity.email }, { name: "Alice Founder", email: "alice@example.com" })
    assert.match(identity.id, /^[0-9a-f-]{36}$/i)

    const authFile = join(dataDir, "auth.json")
    const stored = await readFile(authFile, "utf8")
    assert(!stored.includes("a-secure-passphrase"))
    assert.match(stored, /passwordSalt/)
    assert.equal((await stat(authFile)).mode & 0o777, 0o600)

    const duplicate = await fetch(`${origin}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "alice@example.com", password: "another-passphrase" }),
    })
    assert.equal(duplicate.status, 409)
    const wrong = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "alice@example.com", password: "wrong-password" }),
    })
    assert.equal(wrong.status, 401)
    assert.deepEqual(await wrong.json(), { error: "Invalid email or password" })

    assert.equal((await fetch(`${origin}/api/auth/logout`, { method: "POST", headers: { Cookie: cookie } })).status, 204)
    assert.deepEqual(await (await fetch(`${origin}/api/me`, { headers: { Cookie: cookie } })).json(), { user: null })
    const login = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "alice@example.com", password: "a-secure-passphrase" }),
    })
    assert.equal(login.status, 200)
    assert(login.headers.get("set-cookie")?.includes("HttpOnly"))
    assert(login.headers.get("set-cookie")?.includes("SameSite=Strict"))
    const loginCookie = login.headers.get("set-cookie")?.split(";", 1)[0]
    assert(loginCookie)
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const rejected = await fetch(`${origin}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "alice@example.com", password: "wrong-password" }),
      })
      assert.equal(rejected.status, 401)
    }
    const blocked = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "alice@example.com", password: "wrong-password" }),
    })
    assert.equal(blocked.status, 429)
    time += 1_001
    assert.deepEqual(await (await fetch(`${origin}/api/me`, { headers: { Cookie: loginCookie } })).json(), { user: null })
  } finally {
    await close(server)
    await rm(dataDir, { recursive: true, force: true })
  }
})

test("demo history is user-isolated, shareable, revocable, atomic and expirable", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "doneledger-test-"))
  let time = Date.parse("2026-09-01T12:00:00Z")
  const server = createDoneLedgerServer({ dataDir, retentionMs: 1_000, now: () => time })
  const origin = await listen(server)
  try {
    const cookie = await signup(origin, "alice@example.com")
    const createdResponse = await fetch(`${origin}/api/demo-runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: "{}",
    })
    assert.equal(createdResponse.status, 201)
    const created = await createdResponse.json() as { run: { runId: string; summary: { verified: number } } }
    assert.equal(created.run.summary.verified, 17)

    assert.equal((await fetch(`${origin}/api/runs/${created.run.runId}`)).status, 401)
    const strangerCookie = await signup(origin, "bob@example.com")
    assert.equal((await fetch(`${origin}/api/runs/${created.run.runId}`, { headers: { Cookie: strangerCookie } })).status, 404)
    assert.equal((await fetch(`${origin}/api/runs/${created.run.runId}`, { headers: { Cookie: cookie } })).status, 200)

    const shareResponse = await fetch(`${origin}/api/runs/${created.run.runId}/share`, { method: "POST", headers: { Cookie: cookie } })
    assert.equal(shareResponse.status, 201)
    const shared = await shareResponse.json() as { url: string }
    const token = shared.url.split("#")[1]
    assert(token)
    assert.equal(((await (await fetch(`${origin}/api/runs/${created.run.runId}`, { headers: { Cookie: cookie } })).json()) as { run: { shared: boolean } }).run.shared, true)
    const storedFile = (await readdir(dataDir)).find((name) => /^[0-9a-f-]+\.json$/i.test(name))
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
    assert.deepEqual((await readdir(dataDir)).filter((name) => /^[0-9a-f-]+\.json$/i.test(name)), [])
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
    const cookie = await signup(origin, "alice@example.com")
    const response = await fetch(`${origin}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        csv: `${HEADER}\n${ROW}`,
        dolibarr: { baseUrl: "https://erp.example", username: "reader", password: "do-not-store" },
        accessCode: "invite",
      }),
    })
    assert.equal(response.status, 503)
    assert.deepEqual((await readdir(dataDir)).filter((name) => /^[0-9a-f-]+\.json$/i.test(name)), [])
    assert(!(await readFile(join(dataDir, "auth.json"), "utf8")).includes("do-not-store"))
  } finally {
    await close(server)
    await rm(dataDir, { recursive: true, force: true })
  }
})

test("live run admission stays atomic across slow request bodies", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "doneledger-live-lock-test-"))
  const observed = JSON.parse(await readFile(new URL("../fixtures/observed-canonical.json", import.meta.url), "utf8")) as ObservedBatch
  let calls = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const server = createDoneLedgerServer({
    dataDir,
    liveAccessCode: "invite-only",
    allowedDolibarrOrigins: new Set(["https://erp.example"]),
    liveRunner: async ({ runId, manifest }) => {
      calls += 1
      await gate
      const current = { ...observed, runId }
      return {
        runId,
        summary: verifyBatch(manifest, current),
        observed: current,
        permissionEvidence: { verifierCannotMutate: true, verifierCannotPay: true },
        lifecycle: { browsersReleased: true, sandboxKilled: true },
      }
    },
  })
  const origin = await listen(server)
  try {
    const cookie = await signup(origin, "alice@example.com")
    const body = JSON.stringify({
      csv: `${HEADER}\nDL-001,SUP-001,INV-1001,2026-08-01,2026-08-31,EUR,100.00,20.00,120.00`,
      dolibarr: { baseUrl: "https://erp.example", username: "reader", password: "do-not-store" },
      accessCode: "invite-only",
    })
    let finishSlowBody: () => void = () => assert.fail("Slow request did not start")
    const slowStatus = new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${origin}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Cookie: cookie },
      }, (response) => {
        response.resume()
        response.on("end", () => resolve(response.statusCode ?? 0))
      })
      request.on("error", reject)
      request.flushHeaders()
      request.write(body.slice(0, 12))
      finishSlowBody = () => request.end(body.slice(12))
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const fast = await fetch(`${origin}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body,
    })
    assert.equal(fast.status, 202)
    const started = await fast.json() as { job: { runId: string } }
    finishSlowBody()
    assert.equal(await slowStatus, 429)
    assert.equal(calls, 1)
    release?.()
    let status = "running"
    for (let attempt = 0; attempt < 50 && status === "running"; attempt += 1) {
      const polled = await fetch(`${origin}/api/jobs/${started.job.runId}`, { headers: { Cookie: cookie } })
      status = ((await polled.json()) as { job: { status: string } }).job.status
      if (status === "running") await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(status, "complete")
  } finally {
    release?.()
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
    allowedDolibarrOrigins: new Set(["https://erp.example"]),
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
    const cookie = await signup(origin, "alice@example.com")
    const response = await fetch(`${origin}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        csv: `${HEADER}\nDL-001,SUP-001,INV-1001,2026-08-01,2026-08-31,EUR,100.00,20.00,120.00`,
        dolibarr: { baseUrl: "https://erp.example", username: "reader", password: "do-not-store" },
        accessCode: "invite-only",
      }),
    })
    assert.equal(response.status, 202)
    const started = await response.json() as { job: { runId: string } }
    let status = "running"
    for (let attempt = 0; attempt < 50 && status === "running"; attempt += 1) {
      const polled = await fetch(`${origin}/api/jobs/${started.job.runId}`, { headers: { Cookie: cookie } })
      status = ((await polled.json()) as { job: { status: string } }).job.status
      if (status === "running") await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(status, "complete")
    const report = (await readdir(dataDir)).find((name) => /^[0-9a-f-]+\.json$/i.test(name))
    assert(report)
    const stored = await readFile(join(dataDir, report), "utf8")
    for (const secret of ["reader", "do-not-store", "invite-only"]) assert(!stored.includes(secret))

    const oversized = await fetch(`${origin}/api/demo-runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ csv: "x".repeat(256 * 1024) }),
    })
    assert.equal(oversized.status, 413)
  } finally {
    await close(server)
    await rm(dataDir, { recursive: true, force: true })
  }
})
