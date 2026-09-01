import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"

import { buildArtifact, type RunArtifact } from "./artifact.ts"
import { parseInvoiceCsv } from "./csv.ts"
import { runReadOnlyLive, safeDolibarrUrl } from "./solari.ts"
import type { ExpectedInvoice, ObservedBatch, VerificationSummary } from "./types.ts"
import { hashObservedRecords, verifyBatch } from "./verify.ts"

const BODY_LIMIT = 256 * 1024
const OWNER_COOKIE = "doneledger_owner"
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000

interface StoredRun {
  ownerHash: string
  shareHash?: string
  expiresAt: string
  artifact: RunArtifact
}

export interface LiveRunInput {
  runId: string
  manifest: readonly ExpectedInvoice[]
  dolibarr: { baseUrl: string; username: string; password: string }
  signal: AbortSignal
  onProgress: (step: "browser" | "compare" | "cleanup") => void
}

export interface LiveRunEvidence {
  runId: string
  summary: VerificationSummary
  observed: ObservedBatch
  synthetic?: boolean
  permissionEvidence?: RunArtifact["permissionEvidence"]
  lifecycle?: RunArtifact["lifecycle"]
}

export type LiveRunner = (input: LiveRunInput) => Promise<LiveRunEvidence>

export interface ServerOptions {
  dataDir?: string
  retentionMs?: number
  liveRunner?: LiveRunner
  liveAccessCode?: string
  now?: () => number
}

interface LiveJob {
  runId: string
  ownerHash: string
  status: "running" | "complete" | "failed"
  step: "validate" | "browser" | "compare" | "cleanup" | "report" | "failed"
  startedAt: string
  updatedAt: string
  error?: string
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function safeEqual(left: string, right: string): boolean {
  return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest())
}

function matchesHash(value: string, digest: string): boolean {
  return /^[a-f0-9]{64}$/i.test(digest) && timingSafeEqual(createHash("sha256").update(value).digest(), Buffer.from(digest, "hex"))
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  for (const pair of request.headers.cookie?.split(";") ?? []) {
    const separator = pair.indexOf("=")
    if (separator > 0 && pair.slice(0, separator).trim() === name) return pair.slice(separator + 1).trim()
  }
  return undefined
}

function owner(request: IncomingMessage, response: ServerResponse): string {
  const existing = cookieValue(request, OWNER_COOKIE)
  if (existing && /^[A-Za-z0-9_-]{32,128}$/.test(existing)) return existing
  const token = randomBytes(32).toString("base64url")
  const secure = request.headers["x-forwarded-proto"] === "https" || process.env.NODE_ENV === "production"
  response.setHeader("Set-Cookie", `${OWNER_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure ? "; Secure" : ""}`)
  return token
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  })
  response.end(JSON.stringify(value))
}

async function staticResponse(pathname: string, response: ServerResponse): Promise<boolean> {
  const routes: Record<string, [string, string]> = {
    "/app.js": ["../public/app.js", "text/javascript; charset=utf-8"],
    "/styles.css": ["../public/styles.css", "text/css; charset=utf-8"],
    "/doneledger-live-proof.png": ["../public/doneledger-live-proof.png", "image/png"],
    "/sample.csv": ["../public/sample.csv", "text/csv; charset=utf-8"],
    "/results/run.json": ["../results/run.json", "application/json; charset=utf-8"],
  }
  const route = routes[pathname]
  const page = pathname === "/" || pathname === "/app" || /^\/report\/[0-9a-f-]+$/i.test(pathname)
  if (!route && !page) return false
  try {
    const [file, contentType] = route ?? ["../public/index.html", "text/html; charset=utf-8"]
    const body = await readFile(new URL(file, import.meta.url))
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": contentType.startsWith("image/") ? "public, max-age=86400" : "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    })
    response.end(body)
  } catch {
    throw new HttpError(404, "Not found")
  }
  return true
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json")
  }
  const declared = Number(request.headers["content-length"] ?? 0)
  if (Number.isFinite(declared) && declared > BODY_LIMIT) {
    request.resume()
    throw new HttpError(413, "Request body is too large")
  }
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > BODY_LIMIT) throw new HttpError(413, "Request body is too large")
    chunks.push(buffer)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
    return value as Record<string, unknown>
  } catch {
    throw new HttpError(400, "Request body must be a JSON object")
  }
}

function csv(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "csv must be a string")
  return value
}

function publicRun(stored: StoredRun): RunArtifact & { expiresAt: string } {
  return { ...stored.artifact, expiresAt: stored.expiresAt }
}

function validateDolibarr(value: unknown): LiveRunInput["dolibarr"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "dolibarr is required")
  const input = value as Record<string, unknown>
  if (typeof input.baseUrl !== "string" || typeof input.username !== "string" || typeof input.password !== "string") {
    throw new HttpError(400, "Dolibarr baseUrl, username and password are required")
  }
  if (!input.username.trim() || input.username.length > 200 || !input.password || input.password.length > 500) {
    throw new HttpError(400, "Dolibarr credentials are invalid")
  }
  let baseUrl: URL
  try {
    baseUrl = safeDolibarrUrl(input.baseUrl)
  } catch {
    throw new HttpError(400, "Dolibarr baseUrl must be a public HTTPS URL without credentials, query or fragment")
  }
  return { baseUrl: baseUrl.origin + baseUrl.pathname.replace(/\/$/, ""), username: input.username.trim(), password: input.password }
}

async function demoSources(csvSource: unknown): Promise<{ manifest: ExpectedInvoice[]; source: string; observed: ObservedBatch }> {
  const fixtureUrl = new URL("../fixtures/ground-truth.json", import.meta.url)
  const observedUrl = new URL("../fixtures/observed-canonical.json", import.meta.url)
  const source = csvSource === undefined ? await readFile(fixtureUrl, "utf8") : csv(csvSource)
  const manifest = csvSource === undefined
    ? JSON.parse(source) as ExpectedInvoice[]
    : parseInvoiceCsv(source)
  if (csvSource === undefined) {
    const fixture = JSON.parse(await readFile(observedUrl, "utf8")) as ObservedBatch
    const observed = { ...fixture, runId: randomUUID(), observedAt: new Date().toISOString() }
    return { manifest, source, observed }
  }
  const records = manifest.flatMap((invoice, index) => {
    if (manifest.length >= 3 && index === manifest.length - 1) return []
    const taxCents = manifest.length >= 3 && index === manifest.length - 2
      ? Math.max(0, invoice.taxCents - 100)
      : invoice.taxCents
    return [{
      ...invoice,
      taxCents,
      grossCents: invoice.netCents + taxCents,
      recordId: `SIM-${String(index + 1).padStart(3, "0")}`,
      state: "draft" as const,
    }]
  })
  const observed = {
    state: "fresh" as const,
    runId: randomUUID(),
    observedAt: new Date().toISOString(),
    exportHash: hashObservedRecords(records),
    records,
  }
  return { manifest, source, observed }
}

export function createDoneLedgerServer(options: ServerOptions = {}): Server {
  const dataDir = options.dataDir ?? fileURLToPath(new URL("../data/", import.meta.url))
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS
  const now = options.now ?? Date.now
  let liveBusy = false
  const attempts = new Map<string, number[]>()
  const jobs = new Map<string, LiveJob>()

  const rateLimit = (request: IncomingMessage, limit: number, windowMs: number) => {
    const key = request.socket.remoteAddress ?? "unknown"
    const cutoff = now() - windowMs
    const recent = (attempts.get(key) ?? []).filter((timestamp) => timestamp > cutoff)
    if (recent.length >= limit) throw new HttpError(429, "Too many requests; retry later")
    recent.push(now())
    attempts.set(key, recent)
  }

  const pathFor = (runId: string) => `${dataDir}/${runId}.json`
  const readStored = async (runId: string): Promise<StoredRun | undefined> => {
    try {
      return JSON.parse(await readFile(pathFor(runId), "utf8")) as StoredRun
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }
  const writeStored = async (stored: StoredRun): Promise<void> => {
    await mkdir(dataDir, { recursive: true })
    const destination = pathFor(stored.artifact.runId)
    const temporary = `${destination}.${randomBytes(8).toString("hex")}.tmp`
    await writeFile(temporary, `${JSON.stringify(stored)}\n`, { mode: 0o600 })
    await rename(temporary, destination)
  }
  const purgeExpired = async (): Promise<void> => {
    await mkdir(dataDir, { recursive: true })
    for (const name of await readdir(dataDir)) {
      if (!/^[0-9a-f-]+\.json$/i.test(name)) continue
      const stored = await readStored(name.slice(0, -5))
      if (stored && Date.parse(stored.expiresAt) <= now()) await rm(`${dataDir}/${name}`, { force: true })
    }
  }
  const save = async (artifact: RunArtifact, ownerToken: string): Promise<StoredRun> => {
    const stored: StoredRun = {
      ownerHash: hash(ownerToken),
      expiresAt: new Date(now() + retentionMs).toISOString(),
      artifact,
    }
    await writeStored(stored)
    return stored
  }
  const owned = async (runId: string, ownerToken: string): Promise<StoredRun> => {
    const stored = await readStored(runId)
    if (!stored || stored.ownerHash !== hash(ownerToken) || Date.parse(stored.expiresAt) <= now()) {
      throw new HttpError(404, "Run not found")
    }
    return stored
  }

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://doneledger.local")
      const method = request.method ?? "GET"
      if (method === "GET" && await staticResponse(url.pathname, response)) return
      if (method === "GET" && url.pathname === "/api/health") return json(response, 200, { ok: true })
      if (!url.pathname.startsWith("/api/")) throw new HttpError(404, "Not found")
      if (!["GET", "HEAD"].includes(method) && request.headers.origin) {
        let origin: URL
        try {
          origin = new URL(request.headers.origin)
        } catch {
          throw new HttpError(403, "Cross-origin requests are not allowed")
        }
        if (origin.host !== request.headers.host) throw new HttpError(403, "Cross-origin requests are not allowed")
      }
      const ownerToken = owner(request, response)
      await purgeExpired()

      if (method === "POST" && url.pathname === "/api/demo-runs") {
        rateLimit(request, 30, 10 * 60_000)
        const body = await readJson(request)
        let sources: Awaited<ReturnType<typeof demoSources>>
        try {
          sources = await demoSources(body.csv)
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : "CSV is invalid")
        }
        const summary = verifyBatch(sources.manifest, sources.observed)
        const artifact = buildArtifact({
          mode: "fixture",
          synthetic: true,
          summary,
          manifest: sources.manifest,
          manifestHash: hash(sources.source),
          observed: sources.observed,
          now: new Date(now()),
          runId: sources.observed.runId,
        })
        return json(response, 201, { run: publicRun(await save(artifact, ownerToken)) })
      }

      if (method === "POST" && url.pathname === "/api/runs") {
        rateLimit(request, 3, 60 * 60_000)
        const liveRunner = options.liveRunner
        if (!liveRunner || !options.liveAccessCode) throw new HttpError(503, "Live verification is not configured")
        if (liveBusy) throw new HttpError(429, "A live verification is already running")
        const body = await readJson(request)
        if (typeof body.accessCode !== "string" || !safeEqual(body.accessCode, options.liveAccessCode)) {
          throw new HttpError(403, "Live access code is invalid")
        }
        let manifest: ExpectedInvoice[]
        try {
          manifest = parseInvoiceCsv(csv(body.csv))
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : "CSV is invalid")
        }
        const dolibarr = validateDolibarr(body.dolibarr)
        const csvSource = csv(body.csv)
        const runId = randomUUID()
        const timestamp = new Date(now()).toISOString()
        const job: LiveJob = {
          runId,
          ownerHash: hash(ownerToken),
          status: "running",
          step: "validate",
          startedAt: timestamp,
          updatedAt: timestamp,
        }
        jobs.set(runId, job)
        liveBusy = true
        void (async () => {
          try {
            const signal = AbortSignal.timeout(6 * 60_000)
            const evidence = await liveRunner({
              runId,
              manifest,
              dolibarr,
              signal,
              onProgress(step) {
                job.step = step
                job.updatedAt = new Date(now()).toISOString()
              },
            })
            if (evidence.runId !== runId || evidence.observed.runId !== runId) throw new Error("Run identity mismatch")
            if (
              evidence.permissionEvidence?.verifierCannotMutate !== true ||
              evidence.permissionEvidence?.verifierCannotPay !== true ||
              evidence.lifecycle?.browsersReleased !== true ||
              evidence.lifecycle?.sandboxKilled !== true
            ) throw new Error("Live proof gates are incomplete")
            job.step = "report"
            job.updatedAt = new Date(now()).toISOString()
            const artifact = buildArtifact({
              mode: "live",
              authorityModel: "read_only_verifier",
              synthetic: evidence.synthetic ?? false,
              summary: evidence.summary,
              manifest,
              manifestHash: hash(csvSource),
              observed: evidence.observed,
              permissionEvidence: evidence.permissionEvidence,
              lifecycle: evidence.lifecycle,
              runId,
              now: new Date(now()),
            })
            await save(artifact, ownerToken)
            job.status = "complete"
          } catch {
            job.status = "failed"
            job.step = "failed"
            job.error = "Live verification failed safely"
          } finally {
            job.updatedAt = new Date(now()).toISOString()
            liveBusy = false
          }
        })()
        return json(response, 202, { job: { runId, status: job.status, step: job.step, startedAt: job.startedAt } })
      }

      const jobMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)$/i)
      if (jobMatch && method === "GET") {
        const job = jobs.get(jobMatch[1])
        if (!job || job.ownerHash !== hash(ownerToken)) throw new HttpError(404, "Job not found")
        return json(response, 200, { job: {
          runId: job.runId,
          status: job.status,
          step: job.step,
          startedAt: job.startedAt,
          updatedAt: job.updatedAt,
          error: job.error,
        } })
      }

      if (method === "GET" && url.pathname === "/api/runs") {
        const runs: Array<ReturnType<typeof publicRun> & { shared: boolean }> = []
        for (const name of await readdir(dataDir)) {
          if (!/^[0-9a-f-]+\.json$/i.test(name)) continue
          const stored = await readStored(name.slice(0, -5))
          if (stored?.ownerHash === hash(ownerToken)) runs.push({ ...publicRun(stored), shared: Boolean(stored.shareHash) })
        }
        runs.sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))
        return json(response, 200, { runs })
      }

      const runMatch = url.pathname.match(/^\/api\/runs\/([0-9a-f-]+)$/i)
      if (runMatch && method === "GET") {
        const stored = await owned(runMatch[1], ownerToken)
        return json(response, 200, { run: { ...publicRun(stored), shared: Boolean(stored.shareHash) } })
      }
      if (runMatch && method === "DELETE") {
        await owned(runMatch[1], ownerToken)
        await rm(pathFor(runMatch[1]), { force: true })
        response.writeHead(204).end()
        return
      }

      const shareMatch = url.pathname.match(/^\/api\/runs\/([0-9a-f-]+)\/share$/i)
      if (shareMatch && method === "POST") {
        const stored = await owned(shareMatch[1], ownerToken)
        const token = randomBytes(32).toString("base64url")
        stored.shareHash = hash(token)
        await writeStored(stored)
        return json(response, 201, { url: `/report/${stored.artifact.runId}#${token}` })
      }
      if (shareMatch && method === "DELETE") {
        const stored = await owned(shareMatch[1], ownerToken)
        delete stored.shareHash
        await writeStored(stored)
        response.writeHead(204).end()
        return
      }

      const reportMatch = url.pathname.match(/^\/api\/reports\/([0-9a-f-]+)\/access$/i)
      if (reportMatch && method === "POST") {
        const token = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/)?.[1]
        const stored = await readStored(reportMatch[1])
        if (!token || !stored?.shareHash || !matchesHash(token, stored.shareHash) || Date.parse(stored.expiresAt) <= now()) {
          throw new HttpError(404, "Report not found")
        }
        return json(response, 200, { run: publicRun(stored) })
      }

      throw new HttpError(404, "Not found")
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      json(response, status, { error: error instanceof HttpError ? error.message : "Internal server error" })
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000)
  const apiKey = process.env.SOLARI_API_KEY?.trim()
  const liveAccessCode = process.env.DONELEDGER_LIVE_ACCESS_CODE?.trim()
  const liveRunner: LiveRunner | undefined = apiKey && liveAccessCode
    ? async ({ runId, manifest, dolibarr, signal, onProgress }) => {
        const live = await runReadOnlyLive(manifest, dolibarr, apiKey, { runId, signal, onProgress })
        return {
          runId: live.runId,
          summary: live.summary,
          observed: live.observed,
          synthetic: false,
          permissionEvidence: live.permissions,
          lifecycle: live.lifecycle,
        }
      }
    : undefined
  const server = createDoneLedgerServer({ liveAccessCode, liveRunner })
  server.listen(port, "0.0.0.0", () => console.log(`DoneLedger listening on http://0.0.0.0:${port}`))
}
