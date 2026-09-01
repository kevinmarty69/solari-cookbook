const FILTERS = new Set(["all", "exceptions", "verified", "unknown"])
const STATUSES = new Set(["verified", "exception", "unknown"])
const HASH = /^[a-f0-9]{64}$/i

const fallbackItems = Array.from({ length: 20 }, (_, index) => {
  const number = index + 1
  const exceptions = {
    18: { reasonCode: "TAX_MISMATCH", expectedTotal: 1176, observedTotal: 1176, differences: [{ field: "taxCents", expected: 19600, observed: 16900 }] },
    19: { reasonCode: "DUPLICATE_RECORD", expectedTotal: 192, observedTotal: 192, recordIds: ["ERP-019-A", "ERP-019-B"] },
    20: { reasonCode: "RECORD_MISSING", expectedTotal: 336, observedTotal: null, recordIds: [] },
  }
  const exception = exceptions[number]
  return {
    jobId: `DL-${String(number).padStart(3, "0")}`,
    status: exception ? "exception" : "verified",
    reasonCode: exception?.reasonCode ?? "EXACT_MATCH",
    expectedTotal: exception?.expectedTotal ?? 100 + index * 37.5,
    observedTotal: exception ? exception.observedTotal : 100 + index * 37.5,
    currency: "EUR",
    recordIds: exception?.recordIds ?? [`ERP-${String(number).padStart(3, "0")}`],
    differences: exception?.differences ?? [],
  }
})

const fallbackRun = {
  runId: "bundled-fallback",
  mode: "fixture",
  synthetic: true,
  generatedAt: null,
  manifestHash: null,
  exportHash: null,
  summary: { claimed: 20, verified: 17, exceptions: 3, unknown: 0 },
  items: fallbackItems,
  permissionEvidence: null,
  lifecycle: null,
  disclaimer: "Bundled synthetic fixture; not production finance evidence.",
}

const state = { run: fallbackRun, filter: "exceptions", selectedJob: "DL-018", source: "fixture" }
const $ = (id) => document.getElementById(id)

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is missing`)
  return value.trim()
}

function optionalAmount(value, name) {
  if (value === undefined || value === null) return null
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} is invalid`)
  return value
}

function normalizeDifference(value, index) {
  if (!record(value)) throw new Error(`difference ${index + 1} is invalid`)
  const field = requiredText(value.field, `difference ${index + 1} field`)
  const expected = value.expected
  const observed = value.observed
  if (!["string", "number"].includes(typeof expected) || !["string", "number"].includes(typeof observed)) {
    throw new Error(`difference ${index + 1} values are invalid`)
  }
  return { field, expected, observed }
}

function normalizeItem(value, index) {
  if (!record(value)) throw new Error(`item ${index + 1} is invalid`)
  const status = requiredText(value.status, `item ${index + 1} status`).toLowerCase()
  if (!STATUSES.has(status)) throw new Error(`item ${index + 1} has an unknown status`)
  if (!Array.isArray(value.recordIds) || value.recordIds.some((id) => typeof id !== "string" || !id.trim())) {
    throw new Error(`item ${index + 1} recordIds are invalid`)
  }
  if (!Array.isArray(value.differences)) throw new Error(`item ${index + 1} differences are invalid`)
  const reasonCode = requiredText(value.reasonCode, `item ${index + 1} reasonCode`)
  const differences = value.differences.map(normalizeDifference)
  if (status === "verified" && (reasonCode !== "EXACT_MATCH" || differences.length > 0 || value.recordIds.length === 0)) {
    throw new Error(`item ${index + 1} does not prove a verified verdict`)
  }
  if (status !== "verified" && reasonCode === "EXACT_MATCH") {
    throw new Error(`item ${index + 1} contradicts its verdict`)
  }
  if (value.currency !== undefined && (typeof value.currency !== "string" || !value.currency.trim())) {
    throw new Error(`item ${index + 1} currency is invalid`)
  }
  return {
    jobId: requiredText(value.jobId, `item ${index + 1} jobId`),
    status,
    reasonCode,
    expectedTotal: optionalAmount(value.expectedTotal, `item ${index + 1} expectedTotal`),
    observedTotal: optionalAmount(value.observedTotal, `item ${index + 1} observedTotal`),
    currency: value.currency?.trim() || null,
    recordIds: value.recordIds.map((id) => id.trim()),
    differences,
  }
}

function normalizeRun(raw) {
  if (!record(raw)) throw new Error("artifact root is invalid")
  if (raw.mode !== "fixture" && raw.mode !== "live") throw new Error("mode must be fixture or live")
  if (raw.synthetic !== true) throw new Error("public artifact must declare synthetic: true")
  if (!Array.isArray(raw.items) || raw.items.length === 0) throw new Error("artifact contains no evidence items")
  if (!record(raw.summary)) throw new Error("summary is missing")

  const items = raw.items.map(normalizeItem)
  const jobIds = new Set(items.map(({ jobId }) => jobId))
  if (jobIds.size !== items.length) throw new Error("job IDs are not unique")

  const counted = {
    claimed: items.length,
    verified: items.filter(({ status }) => status === "verified").length,
    exceptions: items.filter(({ status }) => status === "exception").length,
    unknown: items.filter(({ status }) => status === "unknown").length,
  }
  for (const [key, count] of Object.entries(counted)) {
    if (!Number.isInteger(raw.summary[key]) || raw.summary[key] !== count) {
      throw new Error(`summary.${key} does not match recomputed evidence`)
    }
  }

  const manifestHash = raw.manifestHash ?? null
  const exportHash = raw.exportHash ?? null
  if (manifestHash !== null && !HASH.test(manifestHash)) throw new Error("manifestHash is invalid")
  if (exportHash !== null && !HASH.test(exportHash)) throw new Error("exportHash is invalid")

  const generatedAt = requiredText(raw.generatedAt, "generatedAt")
  if (Number.isNaN(Date.parse(generatedAt))) throw new Error("generatedAt is invalid")
  const permissionEvidence = record(raw.permissionEvidence) ? raw.permissionEvidence : null
  const lifecycle = record(raw.lifecycle) ? raw.lifecycle : null
  const liveGates = raw.mode === "live" &&
    manifestHash !== null && exportHash !== null &&
    lifecycle?.browsersReleased === true && lifecycle?.sandboxKilled === true &&
    permissionEvidence?.workerCannotValidate === true &&
    permissionEvidence?.workerCannotPay === true &&
    permissionEvidence?.verifierCannotMutate === true
  if (raw.mode === "live" && !liveGates) throw new Error("live artifact is missing a required proof gate")

  return {
    runId: requiredText(raw.runId, "runId"),
    mode: raw.mode,
    synthetic: true,
    generatedAt,
    manifestHash,
    exportHash,
    summary: counted,
    items,
    permissionEvidence,
    lifecycle,
    disclaimer: typeof raw.disclaimer === "string" && raw.disclaimer.trim()
      ? raw.disclaimer.trim()
      : "Synthetic demonstration; not production finance evidence.",
  }
}

function text(value) {
  return value === undefined || value === null || value === "" ? "Not recorded" : String(value)
}

function formatAmount(value, currency) {
  if (value === null || value === undefined) return "Not recorded"
  if (!currency) return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value) }
  catch { return `${value.toFixed(2)} ${currency}` }
}

function shortHash(value) {
  return value ? `${value.slice(0, 12)}…${value.slice(-8)}` : "Not recorded"
}

function element(tag, options = {}) {
  const node = document.createElement(tag)
  if (options.className) node.className = options.className
  if (options.text !== undefined) node.textContent = options.text
  return node
}

function badge(status) {
  return element("span", { className: `status-badge ${status}`, text: status })
}

function differencesNode(item) {
  if (!item.differences.length) return element("p", { className: "no-difference", text: "No field-level difference recorded." })
  const list = element("div", { className: "difference-list" })
  for (const difference of item.differences) {
    const row = element("div", { className: "difference-row" })
    row.append(
      element("strong", { text: difference.field }),
      element("span", { text: text(difference.expected) }),
      element("span", { text: "→" }),
      element("span", { text: text(difference.observed) }),
    )
    list.append(row)
  }
  return list
}

function filteredItems() {
  if (state.filter === "all") return state.run.items
  const status = state.filter === "exceptions" ? "exception" : state.filter
  return state.run.items.filter((item) => item.status === status)
}

function selectedItem() {
  return state.run.items.find(({ jobId }) => jobId === state.selectedJob) ?? null
}

function route(replace = false) {
  const url = new URL(location.href)
  url.searchParams.set("status", state.filter)
  if (state.selectedJob) url.searchParams.set("job", state.selectedJob)
  else url.searchParams.delete("job")
  history[replace ? "replaceState" : "pushState"](null, "", url)
}

function applyRoute() {
  const params = new URLSearchParams(location.search)
  const requestedFilter = params.get("status")
  state.filter = FILTERS.has(requestedFilter) ? requestedFilter : "exceptions"
  const visible = filteredItems()
  const requestedJob = params.get("job")
  const preferred = visible.find(({ jobId }) => jobId === requestedJob)
    ?? visible.find(({ jobId }) => jobId === "DL-018")
    ?? visible[0]
    ?? null
  state.selectedJob = preferred?.jobId ?? null
}

function setFilter(filter, updateRoute = true) {
  state.filter = FILTERS.has(filter) ? filter : "exceptions"
  const visible = filteredItems()
  const currentVisible = visible.some(({ jobId }) => jobId === state.selectedJob)
  if (!currentVisible) state.selectedJob = visible.find(({ jobId }) => jobId === "DL-018")?.jobId ?? visible[0]?.jobId ?? null
  if (updateRoute) route()
  renderEvidence()
}

function selectJob(jobId, updateRoute = true) {
  if (!state.run.items.some((item) => item.jobId === jobId)) return
  state.selectedJob = jobId
  if (updateRoute) route()
  renderEvidence()
}

function renderTable(items) {
  const body = $("evidence-body")
  body.replaceChildren(...items.map((item) => {
    const row = element("tr")
    row.dataset.job = item.jobId
    if (item.jobId === state.selectedJob) row.classList.add("selected")
    const jobCell = element("td")
    const button = element("button", { className: "row-select", text: item.jobId })
    button.type = "button"
    button.dataset.job = item.jobId
    button.setAttribute("aria-pressed", String(item.jobId === state.selectedJob))
    button.setAttribute("aria-label", `Inspect evidence for ${item.jobId}`)
    jobCell.append(button)
    const reason = element("td", { className: "reason-code", text: item.reasonCode })
    const expected = element("td", { className: "amount", text: formatAmount(item.expectedTotal, item.currency) })
    const observed = element("td", { className: "amount", text: formatAmount(item.observedTotal, item.currency) })
    const records = element("td", { className: "record-code", text: item.recordIds.length ? item.recordIds.join(", ") : "None found" })
    const verdict = element("td")
    verdict.append(badge(item.status))
    row.append(jobCell, reason, expected, observed, records, verdict)
    return row
  }))
}

function mobileDetail(item) {
  const detail = element("div", { className: "mobile-detail" })
  const comparison = element("dl", { className: "comparison-grid" })
  for (const [label, value] of [
    ["Expected", formatAmount(item.expectedTotal, item.currency)],
    ["Observed", formatAmount(item.observedTotal, item.currency)],
  ]) {
    const group = element("div")
    group.append(element("dt", { text: label }), element("dd", { text: value }))
    comparison.append(group)
  }
  const differenceBlock = element("section", { className: "inspector-block" })
  differenceBlock.append(element("h4", { text: "Exact differences" }), differencesNode(item))
  const provenance = element("dl", { className: "detail-list" })
  for (const [label, value] of [
    ["ERP records", item.recordIds.length ? item.recordIds.join(", ") : "None found"],
    ["Manifest", shortHash(state.run.manifestHash)],
    ["Export", shortHash(state.run.exportHash)],
  ]) {
    const group = element("div")
    group.append(element("dt", { text: label }), element("dd", { text: value }))
    provenance.append(group)
  }
  detail.append(comparison, differenceBlock, provenance)
  return detail
}

function renderMobile(items) {
  const container = $("mobile-cards")
  container.replaceChildren(...items.map((item) => {
    const article = element("article", { className: "mobile-card" })
    const details = element("details")
    details.dataset.job = item.jobId
    details.open = item.jobId === state.selectedJob
    const summary = element("summary")
    const title = element("span", { className: "mobile-card-title" })
    title.append(element("strong", { text: item.jobId }), element("small", { text: item.reasonCode }))
    summary.append(title, badge(item.status))
    details.append(summary, mobileDetail(item))
    details.addEventListener("toggle", () => {
      if (details.open && state.selectedJob !== item.jobId) selectJob(item.jobId)
    })
    article.append(details)
    return article
  }))
}

function renderInspector(item) {
  const inspector = $("inspector")
  inspector.hidden = !item
  if (!item) return
  $("inspector-title").textContent = item.jobId
  $("inspector-reason").textContent = item.reasonCode
  $("inspector-expected").textContent = formatAmount(item.expectedTotal, item.currency)
  $("inspector-observed").textContent = formatAmount(item.observedTotal, item.currency)
  $("inspector-records").textContent = item.recordIds.length ? item.recordIds.join(", ") : "None found"
  for (const [id, value] of [["inspector-manifest", state.run.manifestHash], ["inspector-export", state.run.exportHash]]) {
    $(id).textContent = shortHash(value)
    $(id).title = value ?? ""
  }
  $("inspector-differences").replaceChildren(differencesNode(item))
  const status = $("inspector-status")
  status.className = `status-badge ${item.status}`
  status.textContent = item.status
}

function renderEvidence() {
  const items = filteredItems()
  for (const button of $("filter-group").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.filter === state.filter))
  }
  $("empty-state").hidden = items.length > 0
  renderTable(items)
  renderMobile(items)
  renderInspector(selectedItem())
}

function proofLabel(value) {
  if (value === true) return ["Proven", "proven"]
  if (value === false) return ["Not proven", "unproven"]
  return ["Not recorded", ""]
}

function renderProof(id, value) {
  const [label, className] = proofLabel(value)
  const node = $(id)
  node.textContent = label
  node.className = className
}

function renderRun() {
  const { run } = state
  const summary = run.summary
  $("hero-claimed").textContent = summary.claimed
  $("hero-exceptions").textContent = summary.exceptions
  $("claimed-count").textContent = summary.claimed
  $("verified-count").textContent = summary.verified
  $("exception-count").textContent = summary.exceptions
  $("unknown-count").textContent = summary.unknown
  $("filter-all-count").textContent = summary.claimed
  $("filter-verified-count").textContent = summary.verified
  $("filter-exceptions-count").textContent = summary.exceptions
  $("filter-unknown-count").textContent = summary.unknown
  $("inspect-cta").textContent = `Inspect ${summary.exceptions} exception${summary.exceptions === 1 ? "" : "s"}`
  $("run-id").textContent = run.runId

  const source = $("source-badge")
  source.dataset.mode = state.source
  source.textContent = state.source === "live" ? "Validated live run" : state.source === "rejected" ? "Artifact rejected" : "Synthetic fixture"
  $("evidence-boundary").textContent = state.source === "live"
    ? "Validated live artifact: hashes, cleanup and all three negative permission probes passed. Data remains synthetic."
    : state.source === "rejected"
      ? "The loaded artifact failed validation. It is not shown as evidence; the bundled synthetic fixture is displayed instead."
      : "Synthetic fixture shown next to the verdict. This is not a customer result, compliance assessment or payment authorization."

  $("manifest-hash").textContent = text(run.manifestHash)
  $("export-hash").textContent = text(run.exportHash)
  $("artifact-validation").textContent = state.source === "live"
    ? "Schema, counters and all live gates passed"
    : state.source === "rejected"
      ? "Loaded artifact rejected; bundled fixture rendered"
      : "Schema and counters passed; fixture boundary enforced"
  $("generated-at").textContent = run.generatedAt ? new Date(run.generatedAt).toISOString() : "Not recorded"
  $("disclaimer-copy").textContent = run.disclaimer

  renderProof("permission-validate", run.permissionEvidence?.workerCannotValidate)
  renderProof("permission-pay", run.permissionEvidence?.workerCannotPay)
  renderProof("permission-mutate", run.permissionEvidence?.verifierCannotMutate)
  renderProof("lifecycle-browsers", run.lifecycle?.browsersReleased)
  renderProof("lifecycle-sandbox", run.lifecycle?.sandboxKilled)

  applyRoute()
  route(true)
  renderEvidence()
}

async function copySelectedEvidence() {
  const item = selectedItem()
  if (!item) return
  const output = JSON.stringify({
    runId: state.run.runId,
    mode: state.run.mode,
    generatedAt: state.run.generatedAt,
    manifestHash: state.run.manifestHash,
    exportHash: state.run.exportHash,
    item,
  }, null, 2)
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(output)
    else {
      const area = element("textarea")
      area.value = output
      area.setAttribute("readonly", "")
      area.className = "sr-only"
      document.body.append(area)
      area.select()
      if (!document.execCommand("copy")) throw new Error("copy unavailable")
      area.remove()
    }
    $("copy-status").textContent = "Evidence copied"
  } catch {
    $("copy-status").textContent = "Copy unavailable — open the raw artifact"
  }
}

function bindEvents() {
  $("filter-group").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-filter]")
    if (button) setFilter(button.dataset.filter)
  })
  $("evidence-body").addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-job]")
    if (row) selectJob(row.dataset.job)
  })
  $("inspect-cta").addEventListener("click", () => setFilter("exceptions"))
  $("copy-evidence").addEventListener("click", copySelectedEvidence)
  addEventListener("popstate", () => { applyRoute(); renderEvidence() })
}

async function loadRun() {
  bindEvents()
  try {
    const response = await fetch("../results/run.json", { cache: "no-store" })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    state.run = normalizeRun(await response.json())
    state.source = state.run.mode
  } catch (error) {
    state.run = fallbackRun
    state.source = "rejected"
    const alert = $("validation-alert")
    alert.hidden = false
    alert.textContent = `Artifact validation failed: ${error.message}. No live claim was accepted.`
  }
  renderRun()
}

loadRun()
