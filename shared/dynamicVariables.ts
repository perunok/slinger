/**
 * Dynamic variables (`{{$guid}}`, `{{$timestamp}}`, `{{$randomEmail}}`, ...): a fresh value each time one is generated.
 * The one list for the whole app: requests (src/lib/template.ts, one value per name per send), scripts'
 * `pm.variables.replaceIn` (electron/scripts/host.ts) and mock server responses (a value per occurrence), plus the
 * editor's autocomplete. Names and value shapes follow Postman's documented list (and Slinger's `$date`, `$time`,
 * `$randomString`); random data comes from a CSPRNG and small built-in word lists (no faker). Plain `{{variables}}` and
 * unknown `{{$names}}` are left as they are.
 */

export type Rnd = () => number

/** Uniform [0, 1) from the platform CSPRNG (browser, Node and the script worker alike); Math.random only as a fallback. */
export function secureRandom(): number {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto
  if (c?.getRandomValues) return c.getRandomValues(new Uint32Array(1))[0]! / 0x1_0000_0000
  return Math.random()
}

const FIRST = ['Ada', 'Alan', 'Grace', 'Linus', 'Margaret', 'Dennis', 'Barbara', 'Ken', 'Frances', 'Edsger', 'Radia', 'Tim', 'Hedy', 'Guido', 'Sophie', 'James']
const LAST = ['Lovelace', 'Turing', 'Hopper', 'Torvalds', 'Hamilton', 'Ritchie', 'Liskov', 'Thompson', 'Allen', 'Dijkstra', 'Perlman', 'Berners-Lee', 'Lamarr', 'Rossum', 'Wilson', 'Gosling']
const CITIES = ['Addis Ababa', 'Amsterdam', 'Berlin', 'Lisbon', 'Nairobi', 'Oslo', 'Seoul', 'Toronto', 'Lima', 'Melbourne', 'Osaka', 'Dublin']
const COUNTRIES: Array<[string, string]> = [['Ethiopia', 'ET'], ['Netherlands', 'NL'], ['Germany', 'DE'], ['Portugal', 'PT'], ['Kenya', 'KE'], ['Norway', 'NO'], ['South Korea', 'KR'], ['Canada', 'CA'], ['Peru', 'PE'], ['Australia', 'AU'], ['Japan', 'JP'], ['Ireland', 'IE']]
const STREETS = ['Main Street', 'Oak Avenue', 'Maple Road', 'Station Road', 'High Street', 'Park Lane', 'Church Street', 'Mill Road']
const WORDS = ['alpha', 'bravo', 'cobalt', 'delta', 'ember', 'falcon', 'granite', 'harbor', 'indigo', 'juniper', 'kepler', 'lumen', 'meadow', 'nimbus', 'orbit', 'prism', 'quartz', 'river', 'summit', 'tundra', 'umbra', 'vertex', 'willow', 'zephyr']
const LOREM = ['lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit', 'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore', 'magna', 'aliqua']
const COLORS = ['red', 'green', 'blue', 'orange', 'purple', 'teal', 'yellow', 'black', 'white', 'grey', 'pink', 'cyan']
const COMPANIES = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Stark Industries', 'Wayne Enterprises', 'Wonka', 'Soylent', 'Tyrell']
const SUFFIXES = ['Inc', 'LLC', 'Group', 'and Sons', 'Labs', 'Systems']
const JOBS = ['Software Engineer', 'Product Manager', 'Designer', 'Data Analyst', 'Site Reliability Engineer', 'Technical Writer', 'QA Engineer', 'Engineering Manager']
const DOMAINS = ['com', 'org', 'net', 'io', 'dev']
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'ETB', 'KES', 'CAD', 'AUD']
const MIME = ['application/json', 'text/plain', 'text/html', 'image/png', 'application/pdf', 'text/csv']
const LOCALES = ['en', 'de', 'fr', 'es', 'am', 'ja', 'pt', 'nl']
const HEX = '0123456789abcdef'
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789'

const int = (rnd: Rnd, min: number, max: number) => min + Math.floor(rnd() * (max - min + 1))
const pick = <T>(rnd: Rnd, list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!
const chars = (rnd: Rnd, set: string, n: number) => Array.from({ length: n }, () => set[Math.floor(rnd() * set.length)]).join('')
const words = (rnd: Rnd, list: readonly string[], n: number) => Array.from({ length: n }, () => pick(rnd, list)).join(' ')
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function uuid(rnd: Rnd): string {
  const h = chars(rnd, HEX, 32).split('')
  h[12] = '4'
  h[16] = HEX[(parseInt(h[16]!, 16) & 0x3) | 0x8]!
  const s = h.join('')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}
const daysFrom = (now: Date, days: number) => new Date(now.getTime() + days * 86_400_000).toISOString()
const ALNUM_MIXED = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const emailOf = (r: Rnd) => `${pick(r, FIRST).toLowerCase()}.${pick(r, LAST).toLowerCase().replace(/[^a-z]/g, '')}@example.com`

export interface DynamicVariableInfo {
  /** With the `$`: `$guid`. */
  name: string
  description: string
  example: string
}

type Gen = (r: Rnd, now: Date) => string
/** [name without `$`, description, example, generator] in the order autocomplete lists them. */
const DEFS: Array<[string, string, string, Gen]> = [
  ['guid', 'Random UUID v4', '7b9f4c6e-2a62-4f29-a97f-36a2f61c24d2', (r) => uuid(r)],
  ['randomUUID', 'Random UUID v4 (same as $guid)', '7b9f4c6e-2a62-4f29-a97f-36a2f61c24d2', (r) => uuid(r)],
  ['timestamp', 'Unix time in seconds', '1717432480', (_r, now) => String(Math.floor(now.getTime() / 1000))],
  ['isoTimestamp', 'Current time, ISO 8601', '2026-06-03T16:00:00.000Z', (_r, now) => now.toISOString()],
  ['date', 'Current UTC date', '2026-06-03', (_r, now) => now.toISOString().slice(0, 10)],
  ['time', 'Current UTC time', '16:00:00', (_r, now) => now.toISOString().slice(11, 19)],
  ['randomInt', 'Random integer 0-1000', '482', (r) => String(int(r, 0, 1000))],
  ['randomString', 'Random alphanumeric string (12)', 'k9X2qp7mT4aZ', (r) => chars(r, ALNUM_MIXED, 12)],
  ['randomBoolean', 'Random true or false', 'true', (r) => String(r() < 0.5)],
  ['randomAlphaNumeric', 'Random letter or digit', 'q', (r) => chars(r, ALNUM, 1)],
  ['randomEmail', 'Random example.com email', 'grace.hopper@example.com', emailOf],
  ['randomExampleEmail', 'Random example.com email', 'ada@example.com', (r) => `${pick(r, FIRST).toLowerCase()}@example.com`],
  ['randomUserName', 'Random user name', 'linus.torvalds42', (r) => `${pick(r, FIRST).toLowerCase()}.${pick(r, LAST).toLowerCase().replace(/[^a-z]/g, '')}${int(r, 1, 99)}`],
  ['randomPassword', 'Random 15-character password', 'aZ3kq9LmP0xR2tW', (r) => chars(r, ALNUM_MIXED, 15)],
  ['randomFirstName', 'Random first name', 'Grace', (r) => pick(r, FIRST)],
  ['randomLastName', 'Random last name', 'Hopper', (r) => pick(r, LAST)],
  ['randomFullName', 'Random full name', 'Grace Hopper', (r) => `${pick(r, FIRST)} ${pick(r, LAST)}`],
  ['randomNamePrefix', 'Random name prefix', 'Dr.', (r) => pick(r, ['Mr.', 'Ms.', 'Mrs.', 'Dr.'])],
  ['randomJobTitle', 'Random job title', 'Software Engineer', (r) => pick(r, JOBS)],
  ['randomPhoneNumber', 'Random phone number', '555-342-0193', (r) => `${int(r, 200, 999)}-${int(r, 200, 999)}-${String(int(r, 0, 9999)).padStart(4, '0')}`],
  ['randomCity', 'Random city', 'Addis Ababa', (r) => pick(r, CITIES)],
  ['randomStreetName', 'Random street name', 'Station Road', (r) => pick(r, STREETS)],
  ['randomStreetAddress', 'Random street address', '42 Main Street', (r) => `${int(r, 1, 9999)} ${pick(r, STREETS)}`],
  ['randomCountry', 'Random country', 'Ethiopia', (r) => pick(r, COUNTRIES)[0]],
  ['randomCountryCode', 'Random country code', 'ET', (r) => pick(r, COUNTRIES)[1]],
  ['randomLatitude', 'Random latitude', '9.0300', (r) => (r() * 180 - 90).toFixed(4)],
  ['randomLongitude', 'Random longitude', '38.7400', (r) => (r() * 360 - 180).toFixed(4)],
  ['randomCompanyName', 'Random company name', 'Acme Labs', (r) => `${pick(r, COMPANIES)} ${pick(r, SUFFIXES)}`],
  ['randomDomainName', 'Random domain name', 'nimbus.io', (r) => `${pick(r, WORDS)}.${pick(r, DOMAINS)}`],
  ['randomDomainWord', 'Random domain word', 'nimbus', (r) => pick(r, WORDS)],
  ['randomUrl', 'Random URL', 'https://nimbus.io', (r) => `https://${pick(r, WORDS)}.${pick(r, DOMAINS)}`],
  ['randomIP', 'Random IPv4 address', '192.168.4.21', (r) => [int(r, 1, 254), int(r, 0, 255), int(r, 0, 255), int(r, 1, 254)].join('.')],
  ['randomIPV6', 'Random IPv6 address', '2001:0db8:85a3:0000:0000:8a2e:0370:7334', (r) => Array.from({ length: 8 }, () => chars(r, HEX, 4)).join(':')],
  ['randomMACAddress', 'Random MAC address', '3c:22:fb:0a:91:7e', (r) => Array.from({ length: 6 }, () => chars(r, HEX, 2)).join(':')],
  ['randomUserAgent', 'A browser user agent', 'Mozilla/5.0 (X11; Linux x86_64) …', () => 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'],
  ['randomSemver', 'Random semantic version', '2.7.13', (r) => `${int(r, 0, 9)}.${int(r, 0, 20)}.${int(r, 0, 30)}`],
  ['randomLocale', 'Random locale', 'de', (r) => pick(r, LOCALES)],
  ['randomPrice', 'Random price', '129.99', (r) => (int(r, 100, 100_000) / 100).toFixed(2)],
  ['randomCurrencyCode', 'Random currency code', 'EUR', (r) => pick(r, CURRENCIES)],
  ['randomBankAccount', 'Random 8-digit account number', '04815162', (r) => chars(r, '0123456789', 8)],
  ['randomHexColor', 'Random hex colour', '#3fa9f5', (r) => `#${chars(r, HEX, 6)}`],
  ['randomColor', 'Random colour name', 'teal', (r) => pick(r, COLORS)],
  ['randomAbbreviation', 'Random abbreviation', 'JSON', (r) => pick(r, ['API', 'HTTP', 'JSON', 'SQL', 'TCP', 'XML', 'CSS', 'SSL'])],
  ['randomWord', 'Random word', 'granite', (r) => pick(r, WORDS)],
  ['randomWords', 'A few random words', 'orbit prism summit', (r) => words(r, WORDS, int(r, 2, 5))],
  ['randomLoremWord', 'Random lorem ipsum word', 'dolor', (r) => pick(r, LOREM)],
  ['randomLoremWords', 'Three lorem ipsum words', 'sit amet elit', (r) => words(r, LOREM, 3)],
  ['randomLoremSentence', 'A lorem ipsum sentence', 'Lorem ipsum dolor sit amet.', (r) => `${cap(words(r, LOREM, int(r, 6, 12)))}.`],
  ['randomLoremParagraph', 'A lorem ipsum paragraph', 'Lorem ipsum dolor … Sed do eiusmod.', (r) => Array.from({ length: 3 }, () => `${cap(words(r, LOREM, int(r, 6, 12)))}.`).join(' ')],
  ['randomLoremSlug', 'A lorem ipsum slug', 'lorem-ipsum-dolor', (r) => words(r, LOREM, 3).replace(/ /g, '-')],
  ['randomMimeType', 'Random MIME type', 'application/json', (r) => pick(r, MIME)],
  ['randomFileName', 'Random file name', 'prism.json', (r) => `${pick(r, WORDS)}.${pick(r, ['json', 'txt', 'png', 'pdf', 'csv'])}`],
  ['randomDatePast', 'Random date in the past year', '2026-02-11T08:00:00.000Z', (r, now) => daysFrom(now, -int(r, 1, 365))],
  ['randomDateFuture', 'Random date in the next year', '2027-01-20T08:00:00.000Z', (r, now) => daysFrom(now, int(r, 1, 365))],
  ['randomDateRecent', 'Random date in the last two days', '2026-06-02T08:00:00.000Z', (r, now) => daysFrom(now, -int(r, 0, 2))],
]

const BY_NAME = new Map(DEFS.map(([n, , , g]) => [n, g]))

/** Every dynamic variable (`$name`, description, example), in autocomplete order. */
export const DYNAMIC_VARIABLE_LIST: readonly DynamicVariableInfo[] = DEFS.map(([name, description, example]) => ({ name: `$${name}`, description, example }))

/** Is `name` (with its `$`) a dynamic variable? */
export function isDynamicVariable(name: string): boolean {
  return name.startsWith('$') && BY_NAME.has(name.slice(1))
}

/** A fresh value for `name` (with its `$`), or null when it is not a dynamic variable. */
export function generateDynamic(name: string, opts: { now?: Date; rnd?: Rnd } = {}): string | null {
  const gen = name.startsWith('$') ? BY_NAME.get(name.slice(1)) : undefined
  return gen ? gen(opts.rnd ?? secureRandom, opts.now ?? new Date()) : null
}

const PATTERN = /\{\{\s*\$([A-Za-z][A-Za-z0-9]*)\s*\}\}/g

/** Does the text contain a dynamic variable this module knows? (cheap pre-check before resolving) */
export function hasDynamicVariables(text: string): boolean {
  if (!text.includes('{{')) return false
  PATTERN.lastIndex = 0
  for (let m = PATTERN.exec(text); m; m = PATTERN.exec(text)) if (BY_NAME.has(m[1]!)) return true
  return false
}

/** Replaces every known `{{$name}}` with a fresh value (each occurrence gets its own: mock responses). Everything else stays. */
export function resolveDynamicVariables(text: string, rnd: Rnd = secureRandom): string {
  if (!text.includes('{{')) return text
  const now = new Date()
  return text.replace(PATTERN, (whole, name: string) => BY_NAME.get(name)?.(rnd, now) ?? whole)
}
