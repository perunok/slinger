import { describe, expect, it } from 'vitest'
import {
  collectionExportFileName,
  environmentExportFileName,
  IMPORT_FILE_ACCEPT,
  MAX_FILE_NAME_BYTES,
  MAX_STEM_CHARS,
  sanitizeFileStem,
} from './fileName'

const bytes = (s: string) => new TextEncoder().encode(s).length
/** No lone surrogates: the string survives a UTF-8 round trip unchanged. */
const wellFormed = (s: string) => new TextDecoder().decode(new TextEncoder().encode(s)) === s

describe('sanitizeFileStem', () => {
  it('keeps spaces, case and Unicode (Amharic, accents, emoji)', () => {
    expect(sanitizeFileStem('enat uat', 'x')).toBe('enat uat')
    expect(sanitizeFileStem('My Demo API', 'x')).toBe('My Demo API')
    expect(sanitizeFileStem('የኢትዮጵያ ኤፒአይ', 'x')).toBe('የኢትዮጵያ ኤፒአይ')
    expect(sanitizeFileStem('Café Crème 🚀 API', 'x')).toBe('Café Crème 🚀 API')
    expect(sanitizeFileStem('👨‍👩‍👧 family', 'x')).toBe('👨‍👩‍👧 family')
  })

  it('replaces characters that Windows, macOS or Linux reject', () => {
    expect(sanitizeFileStem('a/b\\c:d*e?f"g<h>i|j', 'x')).toBe('a_b_c_d_e_f_g_h_i_j')
    expect(sanitizeFileStem('../../etc/passwd', 'x')).toBe('_.._etc_passwd')
    expect(sanitizeFileStem('nul\u0000byte\u0007bell\u007fdel', 'x')).toBe('nul_byte_bell_del')
    expect(sanitizeFileStem('line\nbreak\ttab', 'x')).toBe('line break tab')
    // Bidi overrides could disguise the extension ("...‮nosj.exe").
    expect(sanitizeFileStem('evil‮gpj.exe', 'x')).toBe('evil_gpj.exe')
  })

  it('trims leading and trailing dots and spaces, and falls back when nothing is left', () => {
    expect(sanitizeFileStem('  name.  ', 'x')).toBe('name')
    expect(sanitizeFileStem('.hidden', 'x')).toBe('hidden')
    expect(sanitizeFileStem('...', 'collection')).toBe('collection')
    expect(sanitizeFileStem('   ', 'environment')).toBe('environment')
    expect(sanitizeFileStem('', 'environment')).toBe('environment')
  })

  it('never produces a Windows device name', () => {
    for (const n of ['CON', 'prn', 'Aux', 'NUL', 'COM1', 'com9', 'LPT1', 'lpt9', 'COM0', 'COM¹']) {
      expect(sanitizeFileStem(n, 'x')).toBe(`${n}_`)
    }
    expect(sanitizeFileStem('nul.api', 'x')).toBe('nul_.api')
    expect(sanitizeFileStem('CON ', 'x')).toBe('CON_')
    expect(sanitizeFileStem('CONSOLE', 'x')).toBe('CONSOLE')
    expect(sanitizeFileStem('COM10', 'x')).toBe('COM10')
    expect(sanitizeFileStem('con api', 'x')).toBe('con api')
  })

  it('caps long names on a character boundary', () => {
    const long = 'a'.repeat(400)
    expect(sanitizeFileStem(long, 'x')).toHaveLength(MAX_STEM_CHARS)
    const emoji = '🚀'.repeat(200)
    const cut = sanitizeFileStem(emoji, 'x')
    expect(Array.from(cut)).toHaveLength(MAX_STEM_CHARS)
    expect(wellFormed(cut)).toBe(true)
    const family = '👨‍👩‍👧'.repeat(200)
    expect(sanitizeFileStem(family, 'x')).toBe('👨‍👩‍👧'.repeat(MAX_STEM_CHARS))
  })
})

describe('export file names', () => {
  it('collection: name + latest version', () => {
    expect(collectionExportFileName('enat uat', '1.2.0')).toBe('enat uat v1.2.0.slinger_collection.json')
    expect(collectionExportFileName('My API', '2.0.0-beta.1')).toBe('My API v2.0.0-beta.1.slinger_collection.json')
    expect(collectionExportFileName('የኢትዮጵያ ኤፒአይ', '0.1.0')).toBe('የኢትዮጵያ ኤፒአይ v0.1.0.slinger_collection.json')
  })

  it('collection without versions: no version suffix', () => {
    expect(collectionExportFileName('enat uat', null)).toBe('enat uat.slinger_collection.json')
    expect(collectionExportFileName('enat uat', undefined)).toBe('enat uat.slinger_collection.json')
    expect(collectionExportFileName('///', null)).toBe('___.slinger_collection.json')
    expect(collectionExportFileName('  ', null)).toBe('collection.slinger_collection.json')
    expect(collectionExportFileName('NUL', null)).toBe('NUL_.slinger_collection.json')
  })

  it('environment: name only', () => {
    expect(environmentExportFileName('Prod')).toBe('Prod.slinger_environment.json')
    expect(environmentExportFileName('Staging: EU/West')).toBe('Staging_ EU_West.slinger_environment.json')
    expect(environmentExportFileName('CON')).toBe('CON_.slinger_environment.json')
    expect(environmentExportFileName('')).toBe('environment.slinger_environment.json')
  })

  it('stays within the file-name byte budget with multi-byte names, keeping version and extension', () => {
    const amharic = 'ሀ'.repeat(149) // 3 bytes each
    const name = collectionExportFileName(amharic, '10.20.30')
    expect(bytes(name)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES)
    expect(name.endsWith(' v10.20.30.slinger_collection.json')).toBe(true)
    expect(name.startsWith('ሀሀሀ')).toBe(true)
    expect(wellFormed(name)).toBe(true)
    const env = environmentExportFileName('🚀'.repeat(149))
    expect(bytes(env)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES)
    expect(env.endsWith('.slinger_environment.json')).toBe(true)
    expect(wellFormed(env)).toBe(true)
  })

  it('import pickers accept Slinger, Postman and plain JSON files', () => {
    for (const ext of ['.slinger_collection.json', '.slinger_environment.json', '.postman_collection.json', '.postman_environment.json', '.json']) {
      expect(IMPORT_FILE_ACCEPT.split(',')).toContain(ext)
    }
  })
})
