import { useEffect, useMemo, useState } from 'react'
import {
  formatPayload,
  type PayloadContentType,
} from '../lib/payloadFormatters'
import {
  extractParams,
  parseDocument,
  payloadContentTypeFromHeaders,
  requestHeaders,
  requestResponses,
  requestScripts,
  resolveTemplate,
  scriptText,
  unresolvedVariables,
  type ActiveTab,
} from '../lib/requestDocument'
import {
  type ApiRequest,
  type EnvironmentVariable,
  type HttpResponseData,
  executeHttpRequest,
} from '../tauri'

type UseRequestWorkspaceParams = {
  environmentVariables: EnvironmentVariable[]
  selectedRequest: ApiRequest | null
  setError: (message: string | null) => void
}

function normalizeRequestError(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : String(error)
  console.error('Request failed:', rawMessage)

  if (rawMessage.toLowerCase().includes('connection refused') || rawMessage.includes('os error 111')) {
    return 'Connection refused'
  }

  if (
    rawMessage.toLowerCase().includes('dns error') ||
    rawMessage.toLowerCase().includes('failed to lookup address')
  ) {
    return 'DNS resolution failed'
  }

  if (rawMessage.toLowerCase().includes('timeout')) {
    return 'Request timed out'
  }

  return rawMessage
}

export function useRequestWorkspace({
  environmentVariables,
  selectedRequest,
  setError,
}: UseRequestWorkspaceParams) {
  const [activeTab, setActiveTab] = useState<ActiveTab>('Body')
  const [urlDraft, setUrlDraft] = useState('')
  const [bodyDraft, setBodyDraft] = useState('')
  const [sendResult, setSendResult] = useState<HttpResponseData | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [selectedResponseIndex, setSelectedResponseIndex] = useState(0)
  const [responseViewTab, setResponseViewTab] = useState<'headers' | 'body'>('body')
  const [requestContentType, setRequestContentType] = useState<PayloadContentType>('json')
  const [responseContentType, setResponseContentType] = useState<PayloadContentType>('json')
  const [responseStatusCode, setResponseStatusCode] = useState<string>('200')

  const selectedDocument = useMemo(() => parseDocument(selectedRequest), [selectedRequest])
  const headers = useMemo(() => requestHeaders(selectedDocument), [selectedDocument])
  const responseExamples = useMemo(() => requestResponses(selectedDocument), [selectedDocument])
  const selectedResponse = responseExamples[selectedResponseIndex] ?? responseExamples[0] ?? null
  const bodyFormat = formatPayload(bodyDraft, requestContentType)
  const bodyHasTemplates = /\{\{[^}]+\}\}/.test(bodyDraft)
  const bodyIsValid = bodyFormat.ok && !bodyHasTemplates
  const params = useMemo(() => extractParams(urlDraft, selectedDocument), [selectedDocument, urlDraft])
  const scripts = useMemo(() => scriptText(requestScripts(selectedDocument)), [selectedDocument])
  const description =
    typeof selectedDocument.description === 'string' ? selectedDocument.description.trim() : ''
  const resolvedUrlPreview = useMemo(
    () => resolveTemplate(urlDraft, environmentVariables),
    [environmentVariables, urlDraft],
  )

  useEffect(() => {
    if (responseExamples.length === 0) {
      setSelectedResponseIndex(0)
      return
    }

    setSelectedResponseIndex((current) => (current >= responseExamples.length ? 0 : current))
  }, [responseExamples.length])

  useEffect(() => {
    const rawBody = selectedDocument.body?.raw ?? ''
    setUrlDraft(selectedRequest?.url ?? '')
    setBodyDraft(rawBody)
    setRequestContentType(
      payloadContentTypeFromHeaders(requestHeaders(selectedDocument)) ?? 'json',
    )
    setSendResult(null)
    setSendError(null)
    setActiveTab(rawBody ? 'Body' : 'Docs')
  }, [selectedDocument, selectedRequest])

  function handleBeautifyBody() {
    if (!bodyDraft.trim()) return

    const formatted = formatPayload(bodyDraft, requestContentType)
    if (!formatted.ok) {
      setError('Body is not valid JSON, so it cannot be beautified.')
      return
    }

    setBodyDraft(formatted.value)
    setError(null)
  }

  async function handleSend() {
    if (!selectedRequest) return

    setSending(true)
    setSendResult(null)
    setSendError(null)

    try {
      const resolvedUrl = resolveTemplate(urlDraft, environmentVariables)
      const resolvedBody = resolveTemplate(bodyDraft, environmentVariables)
      const resolvedHeaders = headers
        .filter((header) => !header.disabled && header.key?.trim())
        .map((header) => ({
          key: resolveTemplate(header.key?.trim() ?? '', environmentVariables),
          value: resolveTemplate(header.value ?? '', environmentVariables),
        }))
      const missingVariables = unresolvedVariables([
        resolvedUrl,
        resolvedBody,
        ...resolvedHeaders.flatMap((header) => [header.key, header.value]),
      ])

      if (missingVariables.length > 0) {
        throw new Error(
          `Unresolved variables: ${missingVariables.map((name) => `{{${name}}}`).join(', ')}`,
        )
      }

      const result = await executeHttpRequest({
        method: selectedRequest.method,
        url: resolvedUrl,
        headers: resolvedHeaders,
        body: resolvedBody,
      })
      const detectedContentType = payloadContentTypeFromHeaders(result.headers)
      if (detectedContentType) setResponseContentType(detectedContentType)

      setSendResult(result)
    } catch (err) {
      setSendError(normalizeRequestError(err))
    } finally {
      setSending(false)
    }
  }

  return {
    activeTab,
    bodyDraft,
    bodyIsValid,
    description,
    handleBeautifyBody,
    handleSend,
    headers,
    params,
    requestContentType,
    resolvedUrlPreview,
    responseContentType,
    responseExamples,
    responseStatusCode,
    responseViewTab,
    scripts,
    selectedDocument,
    selectedResponse,
    selectedResponseIndex,
    sendError,
    sendResult,
    sending,
    setActiveTab,
    setBodyDraft,
    setRequestContentType,
    setResponseContentType,
    setResponseStatusCode,
    setResponseViewTab,
    setSelectedResponseIndex,
    setUrlDraft,
    urlDraft,
  }
}
