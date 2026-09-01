import type { ExpectedInvoice } from "./types.ts"

const HEADERS = [
  "job_id",
  "supplier_id",
  "invoice_number",
  "issue_date",
  "due_date",
  "currency",
  "net",
  "tax",
  "gross",
] as const

function rows(source: string): string[][] {
  const output: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  let quoteClosed = false

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (character === '"') {
        quoted = false
        quoteClosed = true
      } else {
        field += character
      }
    } else if (quoteClosed) {
      if (character === ",") {
        row.push(field)
        field = ""
        quoteClosed = false
      } else if (character === "\n") {
        row.push(field)
        output.push(row)
        row = []
        field = ""
        quoteClosed = false
      } else if (character !== "\r") {
        throw new Error("CSV contains characters after a closing quote")
      }
    } else if (character === '"' && field.length === 0) {
      quoted = true
    } else if (character === '"') {
      throw new Error("CSV contains a quote inside an unquoted field")
    } else if (character === ",") {
      row.push(field)
      field = ""
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""))
      output.push(row)
      row = []
      field = ""
    } else {
      field += character
    }
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field")
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""))
    output.push(row)
  }
  return output.filter((values) => values.some((value) => value.trim()))
}

function cents(value: string, field: string, line: number): number {
  const normalized = value.trim()
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error(`CSV line ${line}: ${field} must be a non-negative decimal with at most two digits`)
  }
  const [whole, fraction = ""] = normalized.split(".")
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"))
  if (!Number.isSafeInteger(amount)) throw new Error(`CSV line ${line}: ${field} is too large`)
  return amount
}

function text(value: string, field: string, line: number): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 120) throw new Error(`CSV line ${line}: ${field} is invalid`)
  return normalized
}

function date(value: string, field: string, line: number): string {
  const normalized = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw new Error(`CSV line ${line}: ${field} must use YYYY-MM-DD`)
  const parsed = new Date(`${normalized}T00:00:00Z`)
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new Error(`CSV line ${line}: ${field} is not a real date`)
  }
  return normalized
}

export function parseInvoiceCsv(source: string, maximum = 25): ExpectedInvoice[] {
  if (typeof source !== "string" || !source.trim()) throw new Error("CSV is required")
  const parsed = rows(source.replace(/^\uFEFF/, ""))
  const headers = parsed.shift()?.map((value) => value.trim().toLowerCase())
  if (!headers || headers.length !== HEADERS.length || headers.some((value, index) => value !== HEADERS[index])) {
    throw new Error(`CSV headers must be: ${HEADERS.join(",")}`)
  }
  if (parsed.length === 0) throw new Error("CSV contains no invoices")
  if (parsed.length > maximum) throw new Error(`CSV may contain at most ${maximum} invoices`)

  const invoices = parsed.map((values, index) => {
    const line = index + 2
    if (values.length !== HEADERS.length) throw new Error(`CSV line ${line}: expected ${HEADERS.length} columns`)
    const netCents = cents(values[6], "net", line)
    const taxCents = cents(values[7], "tax", line)
    const grossCents = cents(values[8], "gross", line)
    if (netCents + taxCents !== grossCents) throw new Error(`CSV line ${line}: gross must equal net plus tax`)
    const currency = values[5].trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`CSV line ${line}: currency must be a three-letter code`)
    return {
      jobId: text(values[0], "job_id", line),
      supplierId: text(values[1], "supplier_id", line),
      invoiceNumber: text(values[2], "invoice_number", line),
      issueDate: date(values[3], "issue_date", line),
      dueDate: date(values[4], "due_date", line),
      currency,
      netCents,
      taxCents,
      grossCents,
      truthAvailable: true,
    }
  })

  if (new Set(invoices.map(({ jobId }) => jobId)).size !== invoices.length) {
    throw new Error("CSV job_id values must be unique")
  }
  return invoices
}
