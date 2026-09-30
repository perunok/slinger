import { describe, expect, it } from 'vitest'
import { MAX_DATA_ROWS, parseCsv, parseDataFile } from './dataFile'

const cells = (text: string) => parseCsv(text).map((r) => r.cells)

describe('parseCsv (RFC 4180)', () => {
  it('splits records and fields, LF or CRLF, keeping empty fields', () => {
    expect(cells('a,b,c\n1,,3\r\n4,5,6')).toEqual([['a', 'b', 'c'], ['1', '', '3'], ['4', '5', '6']])
  })

  it('quoted fields may hold commas, doubled quotes and line breaks; records say where they start', () => {
    const recs = parseCsv('name,note\n"Acme, Ltd","say ""hi""\nsecond line"\nGlobex,plain')
    expect(recs.map((r) => r.cells)).toEqual([['name', 'note'], ['Acme, Ltd', 'say "hi"\nsecond line'], ['Globex', 'plain']])
    expect(recs.map((r) => r.line)).toEqual([1, 2, 4])
  })

  it('a quote inside an unquoted value is literal', () => {
    expect(cells('a\n5" pipe')).toEqual([['a'], ['5" pipe']])
  })

  it('reports an unclosed quote with its line', () => {
    expect(() => parseCsv('a\n"open\nstill open')).toThrow('A quoted value that starts on line 2 is never closed.')
  })
})

describe('parseDataFile', () => {
  it('CSV: the header names the columns, each row is one iteration of strings; BOM and blank lines are ignored', () => {
    const f = parseDataFile('customers.csv', '﻿customerName,email,plan\nAcme Ltd,ops@acme.test,pro\n\nGlobex,it@globex.test,free\n')
    expect(f).toEqual({
      name: 'customers.csv',
      format: 'csv',
      columns: ['customerName', 'email', 'plan'],
      rows: [
        { customerName: 'Acme Ltd', email: 'ops@acme.test', plan: 'pro' },
        { customerName: 'Globex', email: 'it@globex.test', plan: 'free' },
      ],
    })
  })

  it('CSV errors name the line or column', () => {
    expect(() => parseDataFile('d.csv', 'a,b\n1,2\n3')).toThrow('Line 3 has 1 value, the header has 2 columns.')
    expect(() => parseDataFile('d.csv', 'a,,c\n1,2,3')).toThrow('Column 2 of the header row has no name.')
    expect(() => parseDataFile('d.csv', 'a,a\n1,2')).toThrow('The header row names "a" twice.')
    expect(() => parseDataFile('d.csv', 'a,b\n')).toThrow('The file has no data rows.')
    expect(() => parseDataFile('d.csv', '\n\n')).toThrow('The file is empty.')
  })

  it('JSON: an array of objects keeps value types; columns in order of first appearance', () => {
    const f = parseDataFile('rows.json', '[{"id": 1, "active": true}, {"id": 2, "tags": ["x"], "name": "B"}]')
    expect(f.format).toBe('json')
    expect(f.columns).toEqual(['id', 'active', 'tags', 'name'])
    expect(f.rows).toEqual([{ id: 1, active: true }, { id: 2, tags: ['x'], name: 'B' }])
  })

  it('JSON errors say what is expected', () => {
    expect(() => parseDataFile('d.json', '{"a": 1}')).toThrow('A JSON data file must be an array of objects, one per iteration.')
    expect(() => parseDataFile('d.json', '[{"a": 1}, 2]')).toThrow('Item 2 is not an object')
    expect(() => parseDataFile('d.json', '[{"a": 1},')).toThrow(/^Not valid JSON/)
    expect(() => parseDataFile('d.json', '[]')).toThrow('The file has no data rows.')
  })

  it('without a known extension, a leading [ means JSON, anything else CSV', () => {
    expect(parseDataFile('data', ' [{"a":"1"}]').format).toBe('json')
    expect(parseDataFile('data.txt', 'a\n1').format).toBe('csv')
  })

  it('enforces the row and size limits', () => {
    const tooMany = 'n\n' + Array.from({ length: MAX_DATA_ROWS + 1 }, (_, i) => i).join('\n')
    expect(() => parseDataFile('big.csv', tooMany)).toThrow(`at most ${MAX_DATA_ROWS} are supported`)
    expect(() => parseDataFile('huge.csv', 'a\n' + 'x'.repeat(5 * 1024 * 1024))).toThrow('larger than 5 MB')
  })
})
