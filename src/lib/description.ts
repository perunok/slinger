/**
 * Postman `description` values. Pure functions.
 *
 * Postman writes a description either as a plain string (Markdown) or as `{content, type}` where type is
 * 'text/markdown' or 'text/plain'. Request documents keep the value verbatim (key `description`); collections
 * and folders store the text plus the object's type (`Collection.description` / `descriptionType`).
 *
 * Round trip: an untouched description is written back exactly as it was read. An edited one is written as a
 * plain string, except that a `{content, type}` object keeps its shape (only `content` changes) so a text/plain
 * description stays plain text in Postman and here.
 */
import type { DescriptionType } from '../../shared/types'

export type DescriptionFormat = 'markdown' | 'plain'

export interface DescriptionInfo {
  text: string
  format: DescriptionFormat
}

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

/** Text and render format of any stored/imported Postman description value. */
export function readDescription(value: unknown): DescriptionInfo {
  if (typeof value === 'string') return { text: value, format: 'markdown' }
  if (isObj(value)) {
    const text = typeof value.content === 'string' ? value.content : ''
    return { text, format: value.type === 'text/plain' ? 'plain' : 'markdown' }
  }
  return { text: '', format: 'markdown' }
}

/**
 * The value to store after the user edited the text to `text`. Returns `original` itself when the text did
 * not change (so untouched documents stay byte-identical); null when the description was cleared.
 */
export function writeDescription(original: unknown, text: string): unknown {
  if (readDescription(original).text === text) return original === undefined ? null : original
  if (text === '') return null
  if (isObj(original)) return { ...original, content: text }
  return text
}

/** Collection/folder columns -> the Postman value to export (undefined = omit the key). */
export function postmanDescription(text: string | null | undefined, type: DescriptionType | null | undefined): unknown {
  if (text == null || text === '') return undefined
  return type ? { content: text, type } : text
}

export function formatOfType(type: DescriptionType | null | undefined): DescriptionFormat {
  return type === 'text/plain' ? 'plain' : 'markdown'
}

/** A Postman `description` -> collection/folder columns (same rules as the main-process importer). */
export function columnsFromPostman(value: unknown): { description: string | null; descriptionType: DescriptionType | null } {
  if (typeof value === 'string') return { description: value.trim() === '' ? null : value, descriptionType: null }
  if (isObj(value)) {
    const content = typeof value.content === 'string' ? value.content : ''
    if (content.trim() === '') return { description: null, descriptionType: null }
    return { description: content, descriptionType: value.type === 'text/plain' ? 'text/plain' : 'text/markdown' }
  }
  return { description: null, descriptionType: null }
}
