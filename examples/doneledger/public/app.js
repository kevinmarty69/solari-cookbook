const FILTERS = new Set(["all", "exceptions", "verified", "unknown"])
const STATUSES = new Set(["verified", "exception", "unknown"])
const REQUIRED_HEADERS = ["job_id", "supplier_id", "invoice_number", "issue_date", "due_date", "currency", "net", "tax", "gross"]
const HASH = /^[a-f0-9]{64}$/i
const $ = (id) => document.getElementById(id)

const fallbackItems = Array.from({ length: 20 }, (_, index) => {
  const number = index + 1
  const exceptions = {
    18: { reasonCode: "TAX_MISMATCH", expectedTotal: 1176, observedTotal: 1014, differences: [{ field: "grossCents", expected: 117600, observed: 101400 }] },
    19: { reasonCode: "DUPLICATE_RECORD", expectedTotal: 192, observedTotal: 192, recordIds: ["ERP-019-A", "ERP-019-B"] },
    20: { reasonCode: "RECORD_MISSING", expectedTotal: 336, observedTotal: null, recordIds: [] },
  }
  const exception = exceptions[number]
  return { jobId: `DL-${String(number).padStart(3, "0")}`, status: exception ? "exception" : "verified", reasonCode: exception?.reasonCode ?? "EXACT_MATCH", expectedTotal: exception?.expectedTotal ?? 100 + index * 37.5, observedTotal: exception ? exception.observedTotal : 100 + index * 37.5, currency: "EUR", recordIds: exception?.recordIds ?? [`ERP-${String(number).padStart(3, "0")}`], differences: exception?.differences ?? [] }
})

const fallbackRun = {
  runId: "bundled-fallback", mode: "fixture", synthetic: true, generatedAt: "2026-09-01T00:00:00.000Z", manifestHash: null, exportHash: null,
  summary: { claimed: 20, verified: 17, exceptions: 3, unknown: 0 }, items: fallbackItems, permissionEvidence: null, lifecycle: null,
  disclaimer: "Bundled synthetic fixture; not production finance evidence.",
}

const state = { run: fallbackRun, filter: "exceptions", selectedJob: "DL-018", source: "fixture", csv: "", csvRows: [], fileName: "", step: 1, runs: [], publicAccess: false, currentShared: false, progressTimer: null, startedAt: 0 }
const sampleCsv = `job_id,supplier_id,invoice_number,issue_date,due_date,currency,net,tax,gross
DL-001,SUP-001,INV-1001,2026-08-01,2026-08-31,EUR,100.00,20.00,120.00
DL-002,SUP-002,INV-1002,2026-08-02,2026-09-01,EUR,180.00,36.00,216.00
DL-003,SUP-003,INV-1003,2026-08-03,2026-09-02,EUR,240.00,48.00,288.00`

function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value) }
function requiredText(value, name) { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is missing`); return value.trim() }
function optionalAmount(value, name) { if (value === undefined || value === null) return null; if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} is invalid`); return value }
function text(value) { return value === undefined || value === null || value === "" ? "Not recorded" : String(value) }
function shortHash(value) { return value ? `${value.slice(0, 12)}…${value.slice(-8)}` : "Not recorded" }
function element(tag, options = {}) { const node = document.createElement(tag); if (options.className) node.className = options.className; if (options.text !== undefined) node.textContent = options.text; return node }
function badge(status) { return element("span", { className: `status-badge ${status}`, text: status }) }
function formatAmount(value, currency) { if (value === null || value === undefined) return "Not recorded"; try { return new Intl.NumberFormat("en", currency ? { style: "currency", currency } : { maximumFractionDigits: 2 }).format(value) } catch { return `${value.toFixed(2)} ${currency ?? ""}`.trim() } }
function formatDate(value) { if (!value || Number.isNaN(Date.parse(value))) return "Not recorded"; return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) }

function normalizeDifference(value, index) {
  if (!record(value)) throw new Error(`difference ${index + 1} is invalid`)
  const expected = value.expected, observed = value.observed
  if (!["string", "number"].includes(typeof expected) || !["string", "number"].includes(typeof observed)) throw new Error(`difference ${index + 1} values are invalid`)
  return { field: requiredText(value.field, `difference ${index + 1} field`), expected, observed }
}

function normalizeItem(value, index) {
  if (!record(value)) throw new Error(`item ${index + 1} is invalid`)
  const status = requiredText(value.status ?? value.state, `item ${index + 1} status`).toLowerCase()
  if (!STATUSES.has(status)) throw new Error(`item ${index + 1} has an unknown status`)
  const recordIds = value.recordIds ?? []
  const differences = value.differences ?? []
  if (!Array.isArray(recordIds) || !Array.isArray(differences)) throw new Error(`item ${index + 1} evidence is invalid`)
  const reasonCode = requiredText(value.reasonCode, `item ${index + 1} reasonCode`)
  if (status === "verified" && (reasonCode !== "EXACT_MATCH" || differences.length || !recordIds.length)) throw new Error(`item ${index + 1} does not prove a verified verdict`)
  if (status !== "verified" && reasonCode === "EXACT_MATCH") throw new Error(`item ${index + 1} contradicts its verdict`)
  return { jobId: requiredText(value.jobId, `item ${index + 1} jobId`), status, reasonCode, expectedTotal: optionalAmount(value.expectedTotal, "expectedTotal"), observedTotal: optionalAmount(value.observedTotal, "observedTotal"), currency: typeof value.currency === "string" ? value.currency : null, recordIds: recordIds.map(String), differences: differences.map(normalizeDifference) }
}

function normalizeRun(raw) {
  if (!record(raw) || !Array.isArray(raw.items) || !record(raw.summary)) throw new Error("run artifact is incomplete")
  const items = raw.items.map(normalizeItem)
  if (new Set(items.map(({ jobId }) => jobId)).size !== items.length) throw new Error("job IDs are not unique")
  const summary = { claimed: items.length, verified: items.filter(({ status }) => status === "verified").length, exceptions: items.filter(({ status }) => status === "exception").length, unknown: items.filter(({ status }) => status === "unknown").length }
  for (const [key, count] of Object.entries(summary)) if (raw.summary[key] !== count) throw new Error(`summary.${key} does not match evidence`)
  if (raw.manifestHash != null && !HASH.test(raw.manifestHash)) throw new Error("manifest hash is invalid")
  if (raw.exportHash != null && !HASH.test(raw.exportHash)) throw new Error("export hash is invalid")
  const generatedAt = requiredText(raw.generatedAt, "generatedAt")
  if (Number.isNaN(Date.parse(generatedAt))) throw new Error("generatedAt is invalid")
  const liveGates = raw.mode !== "live" || (raw.authorityModel === "read_only_verifier" && raw.manifestHash && raw.exportHash && raw.permissionEvidence?.verifierCannotMutate === true && raw.permissionEvidence?.verifierCannotPay === true && raw.lifecycle?.browsersReleased === true && raw.lifecycle?.sandboxKilled === true)
  if (!liveGates) throw new Error("live artifact is missing a proof gate")
  return { ...raw, runId: requiredText(raw.runId, "runId"), generatedAt, synthetic: raw.synthetic === true, summary, items, permissionEvidence: record(raw.permissionEvidence) ? raw.permissionEvidence : null, lifecycle: record(raw.lifecycle) ? raw.lifecycle : null, disclaimer: typeof raw.disclaimer === "string" ? raw.disclaimer : "Verification evidence; not payment authorization." }
}

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...options, headers: { "Content-Type": "application/json", ...(options.headers ?? {}) } })
  if (response.status === 204) return null
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`)
  return body
}

function parseCsv(source) {
  const rows = []; let row = [], field = "", quoted = false
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    if (quoted && char === '"' && source[i + 1] === '"') { field += '"'; i += 1 }
    else if (char === '"') quoted = !quoted
    else if (char === "," && !quoted) { row.push(field.trim()); field = "" }
    else if ((char === "\n" || char === "\r") && !quoted) { if (char === "\r" && source[i + 1] === "\n") i += 1; row.push(field.trim()); if (row.some(Boolean)) rows.push(row); row = []; field = "" }
    else field += char
  }
  row.push(field.trim()); if (row.some(Boolean)) rows.push(row)
  if (quoted) throw new Error("CSV contains an unclosed quote")
  if (rows.length < 2) throw new Error("CSV must contain a header and at least 1 row")
  const headers = rows[0].map((value) => value.toLowerCase())
  const missing = REQUIRED_HEADERS.filter((header) => !headers.includes(header))
  if (missing.length) throw new Error(`Missing columns: ${missing.join(", ")}`)
  if (rows.length - 1 > 25) throw new Error("CSV is limited to 25 invoice rows")
  for (let index = 1; index < rows.length; index += 1) if (rows[index].length !== headers.length || rows[index].some((value) => !value)) throw new Error(`Row ${index + 1} has a missing or extra value`)
  return { headers, rows: rows.slice(1) }
}

function setStep(step) {
  state.step = step
  document.querySelectorAll(".wizard-step").forEach((node) => { node.hidden = Number(node.dataset.step) !== step })
  document.querySelectorAll("[data-step-indicator]").forEach((node) => { const value = Number(node.dataset.stepIndicator); node.classList.toggle("active", value === step); node.classList.toggle("complete", value < step) })
  const heading = document.querySelector(`.wizard-step[data-step="${step}"] h2`)
  heading?.setAttribute("tabindex", "-1"); heading?.focus({ preventScroll: true })
}

function loadCsv(source, name) {
  if (!name.toLowerCase().endsWith(".csv")) throw new Error("Choose a .csv file")
  if (new Blob([source]).size > 2 * 1024 * 1024) throw new Error("CSV must be 2 MB or smaller")
  const parsed = parseCsv(source)
  state.csv = source; state.csvRows = parsed.rows; state.fileName = name
  $("file-error").textContent = ""; $("file-name").textContent = name; $("row-count").textContent = `${parsed.rows.length} row${parsed.rows.length === 1 ? "" : "s"}`
  const headRow = element("tr"); parsed.headers.forEach((header) => headRow.append(element("th", { text: header }))); $("preview-head").replaceChildren(headRow)
  $("preview-body").replaceChildren(...parsed.rows.slice(0, 5).map((values) => { const row = element("tr"); values.forEach((value) => row.append(element("td", { text: value }))); return row }))
  $("import-preview").hidden = false
}

function clearCsv() { state.csv = ""; state.csvRows = []; state.fileName = ""; $("manifest-file").value = ""; $("import-preview").hidden = true }

function validateConnection() {
  const fields = [$("erp-url"), $("erp-username"), $("erp-password"), $("access-code")]
  const invalid = fields.find((field) => !field.checkValidity())
  if (invalid) { $("connection-error").textContent = invalid.validationMessage; invalid.focus(); return false }
  try {
    const url = new URL($("erp-url").value)
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error()
    $("connected-host").textContent = url.host; $("connection-proof").hidden = false; $("connection-error").textContent = ""; return true
  } catch { $("connection-error").textContent = "Use a public HTTPS URL without credentials, query or fragment."; $("erp-url").focus(); return false }
}

function prepareReview() {
  if (!validateConnection()) return
  $("review-file").textContent = state.fileName; $("review-rows").textContent = `${state.csvRows.length} expected invoice rows`; $("review-host").textContent = new URL($("erp-url").value).host; setStep(3)
}

function showView(id) {
  document.querySelectorAll(".view").forEach((view) => { view.hidden = view.id !== id })
  window.scrollTo({ top: 0, behavior: "auto" })
}

function routeTo(hash) { location.hash = hash }

async function handleRoute() {
  if (/^\/report\/[0-9a-f-]+$/i.test(location.pathname)) return loadPublicReport()
  const route = location.hash.replace(/^#/, "") || "/"
  if (route === "/new") { showView("wizard-view"); setStep(state.step); return }
  if (route === "/runs") { showView("runs-view"); await loadRuns(); return }
  const match = route.match(/^\/runs\/([0-9a-f-]+)$/i)
  if (match) { showView("report-view"); await loadOwnedReport(match[1]); return }
  showView("landing-view")
}

function startProgress(runId = "allocating") {
  showView("progress-view"); $("progress-run-id").textContent = runId; state.startedAt = Date.now(); let index = 0
  const keys = ["validate", "browser", "compare", "cleanup", "report"]
  document.querySelectorAll("[data-run-step]").forEach((node) => { node.className = ""; node.querySelector("em").textContent = "Pending" })
  clearInterval(state.progressTimer)
  const update = () => {
    const elapsed = Math.floor((Date.now() - state.startedAt) / 1000); $("progress-time").textContent = `${elapsed}s`
    const current = document.querySelector(`[data-run-step="${keys[Math.min(index, keys.length - 1)]}"]`)
    if (current && !current.classList.contains("running")) { current.classList.add("running"); current.querySelector("em").textContent = "Running"; $("progress-label").textContent = current.querySelector("strong").textContent; $("progress-status").textContent = `${current.querySelector("strong").textContent} is in progress.` }
    $("progress-fill").style.width = `${Math.min(90, 10 + index * 18)}%`; document.querySelector(".progress-bar").setAttribute("aria-valuenow", String(Math.min(90, 10 + index * 18)))
    if (index < 2 && elapsed >= (index + 1) * 2) { current.className = "complete"; current.querySelector("em").textContent = "Passed"; index += 1 }
  }
  update(); state.progressTimer = setInterval(update, 1000)
}

function finishProgress(run) {
  clearInterval(state.progressTimer); state.progressTimer = null
  document.querySelectorAll("[data-run-step]").forEach((node) => { node.className = "complete"; node.querySelector("em").textContent = "Passed" })
  $("progress-fill").style.width = "100%"; document.querySelector(".progress-bar").setAttribute("aria-valuenow", "100"); $("progress-label").textContent = "Verification Complete"; $("progress-status").textContent = `Verdict ready: ${run.summary.verified} verified, ${run.summary.exceptions} exceptions.`
}

function failProgress(message) {
  clearInterval(state.progressTimer); state.progressTimer = null
  const running = document.querySelector("[data-run-step].running"); if (running) { running.className = "failed"; running.querySelector("em").textContent = "Failed" }
  $("progress-label").textContent = "Verification Failed Safely"; $("progress-status").textContent = `${message} No completed verdict was published.`
}

function syncJobProgress(step) {
  const order = ["validate", "browser", "compare", "cleanup", "report"]
  const aliases = { queued: "validate", validating: "validate", reading: "browser", browser: "browser", comparing: "compare", cleanup: "cleanup", reporting: "report" }
  const active = aliases[String(step).toLowerCase()] ?? "browser", activeIndex = order.indexOf(active)
  order.forEach((key, index) => { const node = document.querySelector(`[data-run-step="${key}"]`); node.className = index < activeIndex ? "complete" : index === activeIndex ? "running" : ""; node.querySelector("em").textContent = index < activeIndex ? "Passed" : index === activeIndex ? "Running" : "Pending" })
  const percent = Math.max(10, activeIndex * 20 + 10); $("progress-fill").style.width = `${percent}%`; document.querySelector(".progress-bar").setAttribute("aria-valuenow", String(percent)); $("progress-status").textContent = `${document.querySelector(`[data-run-step="${active}"] strong`).textContent} is in progress.`
}

async function pollJob(runId) {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const { job } = await api(`/api/jobs/${encodeURIComponent(runId)}`)
    $("progress-run-id").textContent = runId; syncJobProgress(job.step ?? job.status)
    if (job.status === "complete") { const { run } = await api(`/api/runs/${encodeURIComponent(runId)}`); return normalizeRun(run) }
    if (job.status === "failed") throw new Error(job.error || "Live verification failed safely")
  }
}

async function createDemo() {
  startProgress("sample")
  try { const { run } = await api("/api/demo-runs", { method: "POST", body: JSON.stringify({}) }); const normalized = normalizeRun(run); finishProgress(normalized); setTimeout(() => routeTo(`/runs/${normalized.runId}`), 450) }
  catch {
    try { const response = await fetch("/results/run.json", { cache: "no-store" }); const run = normalizeRun(await response.json()); state.run = run; state.source = run.mode; finishProgress(run); setTimeout(() => { showView("report-view"); renderRun() }, 450) }
    catch (error) { failProgress(error.message) }
  }
}

async function submitRun(event) {
  event.preventDefault(); $("submit-error").textContent = ""
  if (!$("scope-confirm").checked) { $("submit-error").textContent = "Confirm the read-only scope before starting."; $("scope-confirm").focus(); return }
  const dolibarr = { baseUrl: $("erp-url").value, username: $("erp-username").value, password: $("erp-password").value }
  const accessCode = $("access-code").value
  startProgress("allocating")
  try {
    const response = await api("/api/runs", { method: "POST", body: JSON.stringify({ csv: state.csv, dolibarr, accessCode }) })
    $("erp-password").value = ""; $("access-code").value = ""
    const normalized = response.job ? await pollJob(response.job.runId) : normalizeRun(response.run)
    $("progress-run-id").textContent = normalized.runId; finishProgress(normalized); setTimeout(() => routeTo(`/runs/${normalized.runId}`), 450)
  } catch (error) { $("erp-password").value = ""; $("access-code").value = ""; failProgress(error.message) }
}

async function loadRuns() {
  $("runs-error").textContent = ""
  try { const body = await api("/api/runs"); state.runs = body.runs.map((run) => ({ ...run, summary: run.summary ?? {} })); renderRuns() }
  catch (error) { state.runs = []; renderRuns(); $("runs-error").textContent = error.message }
}

function renderRuns() {
  const query = $("run-search").value.trim().toLowerCase()
  const runs = state.runs.filter((run) => `${run.runId} ${run.mode}`.toLowerCase().includes(query))
  $("runs-body").replaceChildren(...runs.map((run) => {
    const row = element("tr"); const runCell = element("td"); const link = element("a", { text: run.runId.slice(0, 12) }); link.href = `#/runs/${run.runId}`; runCell.append(link)
    const status = run.summary?.unknown > 0 ? "unknown" : run.summary?.exceptions > 0 ? "exception" : "verified"
    const actions = element("td"); const open = element("a", { className: "text-button", text: "Open" }); open.href = `#/runs/${run.runId}`; actions.append(open)
    row.append(runCell, element("td", { text: formatDate(run.generatedAt) }), element("td", { text: `${run.summary?.verified ?? 0}/${run.summary?.claimed ?? 0} verified` }), (() => { const cell = element("td"); cell.append(badge(status)); return cell })(), actions); return row
  }))
  $("empty-history").hidden = runs.length > 0; $("runs-body").closest(".table-scroll").hidden = runs.length === 0
}

async function loadOwnedReport(id) {
  try { const { run } = await api(`/api/runs/${encodeURIComponent(id)}`); state.run = normalizeRun(run); state.source = state.run.mode; state.publicAccess = false; state.currentShared = run.shared === true; renderRun() }
  catch (error) { rejectReport(error.message) }
}

async function loadPublicReport() {
  showView("report-view"); const id = location.pathname.split("/").pop(); const token = location.hash.slice(1)
  try { if (!token) throw new Error("This share link is incomplete"); const { run } = await api(`/api/reports/${encodeURIComponent(id)}/access`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{}" }); state.run = normalizeRun(run); state.source = state.run.mode; state.publicAccess = true; renderRun() }
  catch (error) { rejectReport(error.message) }
}

function rejectReport(message) { state.run = fallbackRun; state.source = "rejected"; state.publicAccess = true; $("validation-alert").hidden = false; $("validation-alert").textContent = `${message}. No live claim was accepted.`; renderRun() }

function filteredItems() { if (state.filter === "all") return state.run.items; const status = state.filter === "exceptions" ? "exception" : state.filter; return state.run.items.filter((item) => item.status === status) }
function selectedItem() { return state.run.items.find(({ jobId }) => jobId === state.selectedJob) ?? null }
function setFilter(filter) { state.filter = FILTERS.has(filter) ? filter : "exceptions"; const visible = filteredItems(); if (!visible.some(({ jobId }) => jobId === state.selectedJob)) state.selectedJob = visible[0]?.jobId ?? null; renderEvidence(); $("results-announcement").textContent = `${visible.length} evidence result${visible.length === 1 ? "" : "s"} shown.` }
function selectJob(jobId) { if (!state.run.items.some((item) => item.jobId === jobId)) return; state.selectedJob = jobId; renderEvidence(); $("results-announcement").textContent = `${jobId} selected.` }

function differencesNode(item) {
  if (!item.differences.length) return element("p", { className: "no-difference", text: "No field-level difference recorded." })
  const list = element("div", { className: "difference-list" }); for (const difference of item.differences) { const row = element("div", { className: "difference-row" }); row.append(element("strong", { text: difference.field }), element("span", { text: text(difference.expected) }), element("span", { text: "→" }), element("span", { text: text(difference.observed) })); list.append(row) } return list
}

function evidenceOutput(item) { return JSON.stringify({ runId: state.run.runId, mode: state.run.mode, generatedAt: state.run.generatedAt, manifestHash: state.run.manifestHash, exportHash: state.run.exportHash, item }, null, 2) }
async function copyText(value, statusNode) { try { await navigator.clipboard.writeText(value); statusNode.textContent = "Copied" } catch { statusNode.textContent = "Copy unavailable — download the JSON instead" } }

function mobileDetail(item) {
  const detail = element("div", { className: "mobile-detail" }), comparison = element("dl", { className: "comparison-grid" })
  for (const [label, value] of [["Expected", formatAmount(item.expectedTotal, item.currency)], ["Observed", formatAmount(item.observedTotal, item.currency)]]) { const group = element("div"); group.append(element("dt", { text: label }), element("dd", { text: value })); comparison.append(group) }
  const block = element("section", { className: "inspector-block" }); block.append(element("h4", { text: "Exact Differences" }), differencesNode(item)); const copy = element("button", { className: "button secondary mobile-copy", text: "Copy Evidence JSON" }); copy.type = "button"; copy.addEventListener("click", () => copyText(evidenceOutput(item), $("results-announcement"))); detail.append(comparison, block, copy); return detail
}

function renderEvidence() {
  const items = filteredItems(); $("empty-state").hidden = items.length > 0
  document.querySelectorAll("#filter-group button").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.filter === state.filter)))
  $("evidence-body").replaceChildren(...items.map((item) => { const row = element("tr"); if (item.jobId === state.selectedJob) row.classList.add("selected"); const job = element("td"), button = element("button", { className: "row-select", text: item.jobId }); button.type = "button"; button.setAttribute("aria-pressed", String(item.jobId === state.selectedJob)); button.setAttribute("aria-label", `Inspect evidence for ${item.jobId}`); button.addEventListener("click", () => selectJob(item.jobId)); job.append(button); const verdict = element("td"); verdict.append(badge(item.status)); row.append(job, element("td", { className: "reason-code", text: item.reasonCode }), element("td", { className: "amount", text: formatAmount(item.expectedTotal, item.currency) }), element("td", { className: "amount", text: formatAmount(item.observedTotal, item.currency) }), element("td", { className: "record-code", text: item.recordIds.length ? item.recordIds.join(", ") : "None found" }), verdict); return row }))
  $("mobile-cards").replaceChildren(...items.map((item) => { const article = element("article", { className: "mobile-card" }), details = element("details"), summary = element("summary"), title = element("span", { className: "mobile-card-title" }); title.append(element("strong", { text: item.jobId }), element("small", { text: item.reasonCode })); summary.append(title, badge(item.status)); details.open = item.jobId === state.selectedJob; details.addEventListener("toggle", () => { if (details.open) state.selectedJob = item.jobId }); details.append(summary, mobileDetail(item)); article.append(details); return article }))
  renderInspector(selectedItem())
}

function renderInspector(item) {
  $("inspector").hidden = !item; if (!item) return
  $("inspector-title").textContent = item.jobId; $("inspector-reason").textContent = item.reasonCode; $("inspector-expected").textContent = formatAmount(item.expectedTotal, item.currency); $("inspector-observed").textContent = formatAmount(item.observedTotal, item.currency); $("inspector-records").textContent = item.recordIds.length ? item.recordIds.join(", ") : "None found"; $("inspector-manifest").textContent = shortHash(state.run.manifestHash); $("inspector-export").textContent = shortHash(state.run.exportHash); $("inspector-differences").replaceChildren(differencesNode(item)); $("inspector-status").className = `status-badge ${item.status}`; $("inspector-status").textContent = item.status
}

function proofLabel(value) { return value === true ? ["Proven", "proven"] : value === false ? ["Not Proven", "unproven"] : ["Not Recorded", ""] }
function renderProof(id, value) { const [label, className] = proofLabel(value); $(id).textContent = label; $(id).className = className }

function renderRun() {
  showView("report-view"); const { run } = state, summary = run.summary
  if (state.source !== "rejected") { $("validation-alert").hidden = true; $("validation-alert").textContent = "" }
  for (const [id, value] of [["hero-claimed", summary.claimed], ["hero-exceptions", summary.exceptions], ["claimed-count", summary.claimed], ["verified-count", summary.verified], ["exception-count", summary.exceptions], ["unknown-count", summary.unknown], ["filter-all-count", summary.claimed], ["filter-verified-count", summary.verified], ["filter-exceptions-count", summary.exceptions], ["filter-unknown-count", summary.unknown]]) $(id).textContent = value
  $("inspect-cta").textContent = `Inspect ${summary.exceptions} Exception${summary.exceptions === 1 ? "" : "s"}`; $("run-id").textContent = run.runId; $("source-badge").dataset.mode = state.source; $("source-badge").textContent = state.source === "live" ? "Validated Live Run" : state.source === "rejected" ? "Artifact Rejected" : "Synthetic Sample"
  const retention = run.expiresAt ? ` Saved until ${formatDate(run.expiresAt)}.` : ""
  $("evidence-boundary").textContent = (state.source === "live" ? "Read-only live artifact: hashes, cleanup and the recorded negative permission probes passed." : state.source === "rejected" ? "The requested artifact failed validation. The bundled sample is shown without a live claim." : "Synthetic sample. This is not a customer result, compliance assessment or payment authorization.") + retention
  $("manifest-hash").textContent = text(run.manifestHash); $("export-hash").textContent = text(run.exportHash); $("artifact-validation").textContent = state.source === "live" ? "Schema, counters and live gates passed" : state.source === "rejected" ? "Requested artifact rejected" : "Schema and counters passed; sample boundary enforced"; $("generated-at").textContent = formatDate(run.generatedAt); $("disclaimer-copy").textContent = run.disclaimer
  renderProof("permission-mutate", run.permissionEvidence?.verifierCannotMutate); renderProof("permission-validate", Boolean(run.exportHash) || undefined); renderProof("permission-pay", run.permissionEvidence?.verifierCannotPay); renderProof("lifecycle-browsers", run.lifecycle?.browsersReleased); renderProof("lifecycle-sandbox", run.lifecycle?.sandboxKilled)
  const ownedRun = !state.publicAccess && /^[0-9a-f-]{36}$/i.test(run.runId)
  $("share-run").hidden = !ownedRun || state.currentShared; $("revoke-share").hidden = !ownedRun || !state.currentShared; $("delete-run").hidden = !ownedRun; $("replay-claim-count").textContent = `${summary.claimed} manifest rows`; $("replay-verdict-count").textContent = `${summary.exceptions} exceptions`
  state.filter = summary.exceptions ? "exceptions" : "all"; state.selectedJob = filteredItems()[0]?.jobId ?? null; renderReplay("claim"); renderEvidence()
}

function renderReplay(stage) {
  document.querySelectorAll("[data-replay]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.replay === stage)))
  const { run } = state, data = {
    claim: ["Checkpoint 1", "Agent Claim", "The uploaded manifest defines exactly what the external agent claimed to have completed.", "Claimed Records", run.summary.claimed, "Manifest Fingerprint", shortHash(run.manifestHash), "Inspect Manifest Evidence", "all"],
    read: ["Checkpoint 2", "Fresh ERP Read", "An isolated read-only browser observed Dolibarr independently from the external agent.", "Observed Records", run.items.filter((item) => item.recordIds.length).length, "Export Fingerprint", shortHash(run.exportHash), "Inspect ERP Evidence", "all"],
    compare: ["Checkpoint 3", "Sandbox Compare", "Expected and observed fields were compared deterministically outside the ERP session.", "Exact Matches", run.summary.verified, "Unknown Results", run.summary.unknown, "Inspect Differences", "exceptions"],
    verdict: ["Checkpoint 4", "Evidence Verdict", "Exceptions remain visible as breaks in this run summary, with record references and exact field differences.", "Exceptions", run.summary.exceptions, "Verified", run.summary.verified, "Open Exceptions", "exceptions"],
  }[stage]
  for (const [id, value] of [["replay-kicker", data[0]], ["replay-heading", data[1]], ["replay-copy", data[2]], ["replay-label-a", data[3]], ["replay-value-a", data[4]], ["replay-label-b", data[5]], ["replay-value-b", data[6]], ["replay-action", data[7]]]) $(id).textContent = value
  $("replay-action").dataset.filter = data[8]
}

async function shareRun() {
  $("share-status").textContent = "Creating a private-to-public report link…"
  try { const { url } = await api(`/api/runs/${encodeURIComponent(state.run.runId)}/share`, { method: "POST", body: "{}" }); const absolute = new URL(url, location.origin).href; const link = element("a", { text: "Open Public Report" }); link.href = absolute; link.target = "_blank"; link.rel = "noopener"; state.currentShared = true; $("share-run").hidden = true; $("revoke-share").hidden = false; $("share-status").replaceChildren("Public link ready. ", link); try { await navigator.clipboard.writeText(absolute); $("share-status").prepend("Copied. ") } catch {} }
  catch (error) { $("share-status").textContent = error.message }
}

async function revokeShare() {
  try { await api(`/api/runs/${encodeURIComponent(state.run.runId)}/share`, { method: "DELETE", body: "{}" }); state.currentShared = false; $("share-run").hidden = false; $("revoke-share").hidden = true; $("share-status").textContent = "Public link revoked." }
  catch (error) { $("share-status").textContent = error.message }
}

async function deleteRun() { try { await api(`/api/runs/${encodeURIComponent(state.run.runId)}`, { method: "DELETE", body: "{}" }); $("delete-dialog").close(); routeTo("/runs") } catch (error) { $("delete-dialog").close(); $("share-status").textContent = error.message } }
function downloadRun() { const url = URL.createObjectURL(new Blob([`${JSON.stringify(state.run, null, 2)}\n`], { type: "application/json" })); const link = element("a"); link.href = url; link.download = `doneledger-${state.run.runId}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0) }

function bindEvents() {
  addEventListener("hashchange", handleRoute)
  document.addEventListener("click", (event) => { const action = event.target.closest("[data-action]")?.dataset.action; if (action === "demo") createDemo(); if (action === "refresh-runs") loadRuns(); if (action === "sample-csv") { try { loadCsv(sampleCsv, "doneledger-sample.csv") } catch {} } if (action === "remove-file") clearCsv() })
  $("manifest-file").addEventListener("change", async (event) => { const file = event.target.files[0]; if (!file) return; if (file.size > 2 * 1024 * 1024) return void ($("file-error").textContent = "CSV must be 2 MB or smaller."); try { loadCsv(await file.text(), file.name) } catch (error) { clearCsv(); $("file-error").textContent = error.message } })
  for (const type of ["dragenter", "dragover"]) $("drop-zone").addEventListener(type, (event) => { event.preventDefault(); $("drop-zone").classList.add("dragging") })
  for (const type of ["dragleave", "drop"]) $("drop-zone").addEventListener(type, (event) => { event.preventDefault(); $("drop-zone").classList.remove("dragging") })
  $("drop-zone").addEventListener("drop", async (event) => { const file = event.dataTransfer.files[0]; if (!file) return; try { loadCsv(await file.text(), file.name) } catch (error) { clearCsv(); $("file-error").textContent = error.message } })
  $("to-connect").addEventListener("click", () => { if (!state.csv) { $("file-error").textContent = "Choose a valid CSV before continuing."; $("manifest-file").focus(); return } setStep(2) })
  document.querySelectorAll("[data-back]").forEach((button) => button.addEventListener("click", () => setStep(Number(button.dataset.back))))
  $("to-review").addEventListener("click", prepareReview); $("run-form").addEventListener("submit", submitRun); $("run-search").addEventListener("input", renderRuns)
  $("filter-group").addEventListener("click", (event) => { const button = event.target.closest("button[data-filter]"); if (button) setFilter(button.dataset.filter) })
  $("copy-evidence").addEventListener("click", () => { const item = selectedItem(); if (item) copyText(evidenceOutput(item), $("copy-status")) })
  $("download-json").addEventListener("click", downloadRun); $("share-run").addEventListener("click", shareRun); $("revoke-share").addEventListener("click", revokeShare); $("delete-run").addEventListener("click", () => $("delete-dialog").showModal()); $("confirm-delete").addEventListener("click", (event) => { event.preventDefault(); deleteRun() })
  document.querySelectorAll("[data-replay]").forEach((button) => button.addEventListener("click", () => renderReplay(button.dataset.replay)))
  $("replay-action").addEventListener("click", () => { setFilter($("replay-action").dataset.filter); $("evidence").scrollIntoView() })
}

bindEvents()
handleRoute()
