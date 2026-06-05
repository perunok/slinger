export type SnippetRequest = {
  method: string
  url: string
  headers: Array<{ key: string; value: string }>
  body: string
  missingVariables: string[]
}

export type SnippetLanguage = 'curl' | 'fetch' | 'axios' | 'python' | 'httpie'

export const SNIPPET_LANGUAGES: { value: SnippetLanguage; label: string }[] = [
  { value: 'curl', label: 'cURL' },
  { value: 'fetch', label: 'JavaScript (Fetch)' },
  { value: 'axios', label: 'JavaScript (Axios)' },
  { value: 'python', label: 'Python (requests)' },
  { value: 'httpie', label: 'HTTPie' },
]

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

export function generateCurl(req: SnippetRequest): string {
  const method = req.method.trim().toUpperCase() || 'GET'
  const parts = [
    `curl --request ${method} ${shellQuote(req.url)}`,
    ...req.headers.map((h) => `  --header ${shellQuote(`${h.key}: ${h.value}`)}`),
  ]
  if (req.body) parts.push(`  --data ${shellQuote(req.body)}`)
  return parts.join(' \\\n')
}

export function generateFetch(req: SnippetRequest): string {
  const method = req.method.trim().toUpperCase() || 'GET'
  const hasBody = !!req.body && method !== 'GET' && method !== 'HEAD'
  const lines: string[] = []
  lines.push(`const response = await fetch(${JSON.stringify(req.url)}, {`)
  lines.push(`  method: ${JSON.stringify(method)},`)
  if (req.headers.length > 0) {
    lines.push(`  headers: {`)
    for (const h of req.headers) {
      lines.push(`    ${JSON.stringify(h.key)}: ${JSON.stringify(h.value)},`)
    }
    lines.push(`  },`)
  }
  if (hasBody) lines.push(`  body: ${JSON.stringify(req.body)},`)
  lines.push(`})`)
  lines.push(``)
  lines.push(`const data = await response.json()`)
  lines.push(`console.log(data)`)
  return lines.join('\n')
}

export function generateAxios(req: SnippetRequest): string {
  const method = req.method.trim().toLowerCase() || 'get'
  const hasBody = !!req.body && method !== 'get' && method !== 'head'
  const lines: string[] = []
  lines.push(`import axios from 'axios'`)
  lines.push(``)
  lines.push(`const response = await axios.request({`)
  lines.push(`  method: ${JSON.stringify(method)},`)
  lines.push(`  url: ${JSON.stringify(req.url)},`)
  if (req.headers.length > 0) {
    lines.push(`  headers: {`)
    for (const h of req.headers) {
      lines.push(`    ${JSON.stringify(h.key)}: ${JSON.stringify(h.value)},`)
    }
    lines.push(`  },`)
  }
  if (hasBody) lines.push(`  data: ${JSON.stringify(req.body)},`)
  lines.push(`})`)
  lines.push(``)
  lines.push(`console.log(response.data)`)
  return lines.join('\n')
}

export function generatePython(req: SnippetRequest): string {
  const method = req.method.trim().toLowerCase() || 'get'
  const hasBody = !!req.body && method !== 'get' && method !== 'head'
  const lines: string[] = []
  lines.push(`import requests`)
  lines.push(``)
  lines.push(`response = requests.${method}(`)
  lines.push(`    ${JSON.stringify(req.url)},`)
  if (req.headers.length > 0) {
    lines.push(`    headers={`)
    for (const h of req.headers) {
      lines.push(`        ${JSON.stringify(h.key)}: ${JSON.stringify(h.value)},`)
    }
    lines.push(`    },`)
  }
  if (hasBody) lines.push(`    data=${JSON.stringify(req.body)},`)
  lines.push(`)`)
  lines.push(`print(response.json())`)
  return lines.join('\n')
}

export function generateHttpie(req: SnippetRequest): string {
  const method = req.method.trim().toUpperCase() || 'GET'
  const hasBody = !!req.body && method !== 'GET' && method !== 'HEAD'
  const parts = [`http ${method} ${shellQuote(req.url)}`]
  for (const h of req.headers) {
    parts.push(`  ${shellQuote(`${h.key}: ${h.value}`)}`)
  }
  if (hasBody) parts.push(`  <<<${shellQuote(req.body)}`)
  return parts.join(' \\\n')
}

export function generateSnippet(language: SnippetLanguage, req: SnippetRequest): string {
  switch (language) {
    case 'curl': return generateCurl(req)
    case 'fetch': return generateFetch(req)
    case 'axios': return generateAxios(req)
    case 'python': return generatePython(req)
    case 'httpie': return generateHttpie(req)
  }
}
