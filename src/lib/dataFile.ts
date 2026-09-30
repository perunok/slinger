/**
 * Data files for data-driven collection runs: a CSV (header row + one row per iteration) or a JSON array of objects.
 * Each row becomes the iteration's data scope (`{{column}}`, `pm.iterationData`). Pure: the runner dialog reads the file.
 */

export type DataRow = Record<string, unknown>

export interface DataFile {
  name: string
  format: 'csv' | 'json'
  /** Column names in file order (JSON: keys in order of first appearance). */
  columns: string[]
  rows: DataRow[]
}

export const MAX_DATA_ROWS = 10_000
export const MAX_DATA_BYTES = 5 * 1024 * 1024

/** Thrown with a message meant for the user ("Line 4 has 2 values, the header has 3 columns."). */
export class DataFileError extends Error {
  override name = 'DataFileError'
}

/** Parses `text` as CSV or JSON, by the file extension, else by its first character. */
export function parseDataFile(name: string, text: string): DataFile {
  if (text.length > MAX_DATA_BYTES) throw new DataFileError(`The file is larger than ${MAX_DATA_BYTES / 1024 / 1024} MB.`)
  const body = text.replace(/^\uFEFF/, '')
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase()
  const json = ext === 'json' || (ext !== 'csv' && /^\s*\[/.test(body))
  const file = json ? parseJsonData(name, body) : parseCsvData(name, body)
  if (file.rows.length === 0) throw new DataFileError('The file has no data rows.')
  if (file.rows.length > MAX_DATA_ROWS) throw new DataFileError(`The file has ${file.rows.length} rows; at most ${MAX_DATA_ROWS} are supported.`)
  return file
}

function parseJsonData(name: string, text: string): DataFile {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    throw new DataFileError(`Not valid JSON: ${(e as Error).message}`)
  }
  if (!Array.isArray(data)) throw new DataFileError('A JSON data file must be an array of objects, one per iteration.')
  const columns: string[] = []
  const seen = new Set<string>()
  const rows = data.map((row, i) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new DataFileError(`Item ${i + 1} is not an object: each item of the array is one iteration's variables.`)
    }
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key)
        columns.push(key)
      }
    }
    return row as DataRow
  })
  return { name, format: 'json', columns, rows }
}

function parseCsvData(name: string, text: string): DataFile {
  const records = parseCsv(text)
  // Blank lines (a trailing newline, spacing between rows) are not rows.
  const lines = records.filter((r) => !(r.cells.length === 1 && r.cells[0] === ''))
  if (lines.length === 0) throw new DataFileError('The file is empty.')
  const header = lines[0]!.cells
  const seen = new Set<string>()
  header.forEach((col, i) => {
    if (col.trim() === '') throw new DataFileError(`Column ${i + 1} of the header row has no name.`)
    if (seen.has(col)) throw new DataFileError(`The header row names "${col}" twice.`)
    seen.add(col)
  })
  const rows = lines.slice(1).map(({ cells, line }) => {
    if (cells.length !== header.length) {
      throw new DataFileError(`Line ${line} has ${cells.length} value${cells.length === 1 ? '' : 's'}, the header has ${header.length} column${header.length === 1 ? '' : 's'}.`)
    }
    const row: DataRow = {}
    header.forEach((col, i) => (row[col] = cells[i]))
    return row
  })
  return { name, format: 'csv', columns: header, rows }
}

/**
 * RFC 4180 CSV: comma separated, fields optionally in double quotes (`""` is a quote inside one), line breaks inside
 * quoted fields, CRLF or LF. Every value is a string. Each record says on which line it starts.
 */
export function parseCsv(text: string): Array<{ cells: string[]; line: number }> {
  const out: Array<{ cells: string[]; line: number }> = []
  let cells: string[] = []
  let cell = ''
  let quoted = false
  let line = 1
  let start = 1
  let i = 0
  const endRecord = () => {
    cells.push(cell)
    out.push({ cells, line: start })
    cells = []
    cell = ''
  }
  while (i < text.length) {
    const c = text[i]!
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      if (c === '\n') line++
      cell += c
      i++
      continue
    }
    if (c === '"' && cell === '') {
      quoted = true
      i++
    } else if (c === ',') {
      cells.push(cell)
      cell = ''
      i++
    } else if (c === '\r' || c === '\n') {
      endRecord()
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1
      line++
      start = line
    } else {
      cell += c
      i++
    }
  }
  if (quoted) throw new DataFileError(`A quoted value that starts on line ${start} is never closed.`)
  if (cell !== '' || cells.length > 0) endRecord()
  return out
}

