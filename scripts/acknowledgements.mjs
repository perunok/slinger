// Open-source acknowledgements for the About dialog, generated at build time (no network).
//
// The list is every runtime dependency in package.json, plus Electron, Svelte and the libraries bundled into the
// script sandbox (scripts/sandbox-libs.mjs). Name, version, licence and homepage come from each package's own
// node_modules/<pkg>/package.json. The renderer imports it as `virtual:acknowledgements`; `vite build` also emits
// THIRD_PARTY_LICENSES.txt (every package's licence text) next to index.html, and electron-builder copies it to the
// packaged app's resources folder.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Libraries bundled into the QuickJS script sandbox (the pm.require() names map to these packages). */
export const SANDBOX_PACKAGES = ['crypto-js', 'lodash', 'moment', 'uuid', 'chai', 'tv4', 'ajv', 'xml2js', 'csv-parse', 'cheerio', 'buffer', 'events']
/** Build tools whose code still ends up in the app (framework runtime, the Electron shell, Tailwind's base styles). */
const EXTRA_PACKAGES = ['electron', 'svelte', 'tailwindcss']

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license
  // Old manifests: { type } or [{ type }] under `license` or `licenses`.
  const list = [pkg.license, pkg.licenses].flat().map((l) => (typeof l === 'string' ? l : l?.type)).filter((t) => typeof t === 'string' && t)
  return list.length ? list.join(' OR ') : 'Unknown'
}

/** A browsable https URL for the package (homepage, else repository, else its npm page). */
export function homepageOf(pkg) {
  const candidates = []
  if (typeof pkg.homepage === 'string') candidates.push(pkg.homepage)
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  if (typeof repo === 'string') candidates.push(repo)
  for (const raw of candidates) {
    let url = raw.trim()
    const shorthand = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(url)
    if (shorthand) url = `https://github.com/${shorthand[1]}`
    url = url.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://').replace(/\.git$/, '')
    url = url.replace(/^http:\/\/(www\.)?github\.com/, 'https://github.com')
    if (/^https?:\/\//.test(url)) return url
  }
  return `https://www.npmjs.com/package/${pkg.name}`
}

function licenseText(dir) {
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i.test(f))
  return file ? readFileSync(join(dir, file), 'utf8').trim() : null
}

/**
 * [{ name, version, license, homepage, description, group }] sorted by name; `group` is 'app' or 'sandbox'.
 * `withText` adds `licenseText` (null when the package ships no licence file).
 */
export function collectAcknowledgements({ withText = false, cwd = root } = {}) {
  const manifest = readJson(join(cwd, 'package.json'))
  const names = new Set([...Object.keys(manifest.dependencies ?? {}), ...EXTRA_PACKAGES, ...SANDBOX_PACKAGES])
  const out = []
  for (const name of names) {
    const dir = join(cwd, 'node_modules', name)
    if (!existsSync(join(dir, 'package.json'))) continue
    const pkg = readJson(join(dir, 'package.json'))
    const entry = {
      name,
      version: String(pkg.version ?? ''),
      license: licenseOf(pkg),
      homepage: homepageOf(pkg),
      description: typeof pkg.description === 'string' ? pkg.description.slice(0, 200) : '',
      group: SANDBOX_PACKAGES.includes(name) && !(name in (manifest.dependencies ?? {})) ? 'sandbox' : 'app',
    }
    if (withText) entry.licenseText = licenseText(dir)
    out.push(entry)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Plain-text THIRD_PARTY_LICENSES: one section per package with its licence text. */
export function thirdPartyLicensesText(cwd = root) {
  const parts = [
    'Slinger includes the following third-party open-source software.',
    'Each component is distributed under its own licence, reproduced below.',
  ]
  for (const a of collectAcknowledgements({ withText: true, cwd })) {
    parts.push(
      [
        '-'.repeat(78),
        `${a.name} ${a.version}`,
        `License: ${a.license}`,
        `Homepage: ${a.homepage}`,
        '',
        a.licenseText ?? `(This package does not ship a licence file; see ${a.homepage}.)`,
      ].join('\n'),
    )
  }
  return `${parts.join('\n\n')}\n`
}

const VIRTUAL_ID = 'virtual:acknowledgements'

/** Vite plugin: `virtual:acknowledgements` for the renderer, and THIRD_PARTY_LICENSES.txt in production builds. */
export function acknowledgementsVitePlugin() {
  return {
    name: 'acknowledgements',
    resolveId(id) {
      return id === VIRTUAL_ID ? `\0${VIRTUAL_ID}` : null
    },
    load(id) {
      return id === `\0${VIRTUAL_ID}` ? `export default ${JSON.stringify(collectAcknowledgements())}` : null
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_LICENSES.txt', source: thirdPartyLicensesText() })
    },
  }
}
