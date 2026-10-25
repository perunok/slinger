/**
 * Postman's dynamic variables (`{{$guid}}`, `{{$timestamp}}`, `{{$randomEmail}}`, ...): a fresh value each time one is
 * resolved. Used by mock servers in example responses (bodies and header values), like Postman's mock servers. The names
 * and value shapes follow Postman's documented list; the random data comes from small built-in word lists (no faker).
 * Plain `{{variables}}` and unknown `{{$names}}` are left as they are.
 */

type Rnd = () => number

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
const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()

/** name (without `$`) -> generator. Kept in Postman's names so collections written for Postman mocks work unchanged. */
export const DYNAMIC_VARIABLES: Record<string, (rnd: Rnd) => string> = {
  guid: uuid,
  randomUUID: uuid,
  timestamp: () => String(Math.floor(Date.now() / 1000)),
  isoTimestamp: () => new Date().toISOString(),
  randomInt: (r) => String(int(r, 0, 1000)),
  randomBoolean: (r) => String(r() < 0.5),
  randomAlphaNumeric: (r) => chars(r, ALNUM, 1),
  randomHexColor: (r) => `#${chars(r, HEX, 6)}`,
  randomColor: (r) => pick(r, COLORS),
  randomAbbreviation: (r) => pick(r, ['API', 'HTTP', 'JSON', 'SQL', 'TCP', 'XML', 'CSS', 'SSL']),
  randomIP: (r) => [int(r, 1, 254), int(r, 0, 255), int(r, 0, 255), int(r, 1, 254)].join('.'),
  randomIPV6: (r) => Array.from({ length: 8 }, () => chars(r, HEX, 4)).join(':'),
  randomMACAddress: (r) => Array.from({ length: 6 }, () => chars(r, HEX, 2)).join(':'),
  randomPassword: (r) => chars(r, ALNUM + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 15),
  randomLocale: (r) => pick(r, LOCALES),
  randomUserAgent: () => 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  randomSemver: (r) => `${int(r, 0, 9)}.${int(r, 0, 20)}.${int(r, 0, 30)}`,
  randomFirstName: (r) => pick(r, FIRST),
  randomLastName: (r) => pick(r, LAST),
  randomFullName: (r) => `${pick(r, FIRST)} ${pick(r, LAST)}`,
  randomNamePrefix: (r) => pick(r, ['Mr.', 'Ms.', 'Mrs.', 'Dr.']),
  randomJobTitle: (r) => pick(r, JOBS),
  randomUserName: (r) => `${pick(r, FIRST).toLowerCase()}.${pick(r, LAST).toLowerCase().replace(/[^a-z]/g, '')}${int(r, 1, 99)}`,
  randomEmail: (r) => `${pick(r, FIRST).toLowerCase()}.${pick(r, LAST).toLowerCase().replace(/[^a-z]/g, '')}@example.${pick(r, DOMAINS)}`,
  randomExampleEmail: (r) => `${pick(r, FIRST).toLowerCase()}@example.com`,
  randomPhoneNumber: (r) => `${int(r, 200, 999)}-${int(r, 200, 999)}-${String(int(r, 0, 9999)).padStart(4, '0')}`,
  randomCity: (r) => pick(r, CITIES),
  randomStreetName: (r) => pick(r, STREETS),
  randomStreetAddress: (r) => `${int(r, 1, 9999)} ${pick(r, STREETS)}`,
  randomCountry: (r) => pick(r, COUNTRIES)[0],
  randomCountryCode: (r) => pick(r, COUNTRIES)[1],
  randomLatitude: (r) => (r() * 180 - 90).toFixed(4),
  randomLongitude: (r) => (r() * 360 - 180).toFixed(4),
  randomCompanyName: (r) => `${pick(r, COMPANIES)} ${pick(r, SUFFIXES)}`,
  randomDomainName: (r) => `${pick(r, WORDS)}.${pick(r, DOMAINS)}`,
  randomDomainWord: (r) => pick(r, WORDS),
  randomUrl: (r) => `https://${pick(r, WORDS)}.${pick(r, DOMAINS)}`,
  randomPrice: (r) => (int(r, 100, 100_000) / 100).toFixed(2),
  randomCurrencyCode: (r) => pick(r, CURRENCIES),
  randomBankAccount: (r) => chars(r, '0123456789', 8),
  randomWord: (r) => pick(r, WORDS),
  randomWords: (r) => words(r, WORDS, int(r, 2, 5)),
  randomLoremWord: (r) => pick(r, LOREM),
  randomLoremWords: (r) => words(r, LOREM, 3),
  randomLoremSentence: (r) => `${cap(words(r, LOREM, int(r, 6, 12)))}.`,
  randomLoremParagraph: (r) => Array.from({ length: 3 }, () => `${cap(words(r, LOREM, int(r, 6, 12)))}.`).join(' '),
  randomLoremSlug: (r) => words(r, LOREM, 3).replace(/ /g, '-'),
  randomMimeType: (r) => pick(r, MIME),
  randomFileName: (r) => `${pick(r, WORDS)}.${pick(r, ['json', 'txt', 'png', 'pdf', 'csv'])}`,
  randomDatePast: (r) => daysFromNow(-int(r, 1, 365)),
  randomDateFuture: (r) => daysFromNow(int(r, 1, 365)),
  randomDateRecent: (r) => daysFromNow(-int(r, 0, 2)),
}

const PATTERN = /\{\{\s*\$([A-Za-z][A-Za-z0-9]*)\s*\}\}/g

/** Does the text contain a dynamic variable this module knows? (cheap pre-check before resolving) */
export function hasDynamicVariables(text: string): boolean {
  if (!text.includes('{{')) return false
  PATTERN.lastIndex = 0
  for (let m = PATTERN.exec(text); m; m = PATTERN.exec(text)) if (Object.hasOwn(DYNAMIC_VARIABLES, m[1]!)) return true
  return false
}

/** Replaces every known `{{$name}}` with a fresh value (each occurrence gets its own). Everything else stays. */
export function resolveDynamicVariables(text: string, rnd: Rnd = Math.random): string {
  if (!text.includes('{{')) return text
  return text.replace(PATTERN, (whole, name: string) => (Object.hasOwn(DYNAMIC_VARIABLES, name) ? DYNAMIC_VARIABLES[name]!(rnd) : whole))
}
