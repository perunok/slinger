import React from 'react'

const HTTP_STATUS_CODES = [
  { code: 200, text: 'OK' },
  { code: 201, text: 'Created' },
  { code: 204, text: 'No Content' },
  { code: 301, text: 'Moved Permanently' },
  { code: 302, text: 'Found' },
  { code: 304, text: 'Not Modified' },
  { code: 400, text: 'Bad Request' },
  { code: 401, text: 'Unauthorized' },
  { code: 403, text: 'Forbidden' },
  { code: 404, text: 'Not Found' },
  { code: 408, text: 'Request Timeout' },
  { code: 429, text: 'Too Many Requests' },
  { code: 500, text: 'Internal Server Error' },
  { code: 501, text: 'Not Implemented' },
  { code: 502, text: 'Bad Gateway' },
  { code: 503, text: 'Service Unavailable' },
  { code: 504, text: 'Gateway Timeout' },
]

type Props = {
  selectedRequest: any
  selectedCollection: any
  urlDraft: string
  setUrlDraft: (v: string) => void
  handleSend: () => Promise<void>
  sending: boolean
  activeTab: string
  setActiveTab: (t: any) => void
  bodyDraft: string
  setBodyDraft: (v: string) => void
  resolvedUrlPreview: string
  handleBeautifyBody: () => void
  REQUEST_TABS: string[]
  headers: any[]
  params: any[]
  scripts: string
  selectedDocument: any
  renderActiveTab: () => JSX.Element
  responseExamples: any[]
  selectedResponseIndex: number
  setSelectedResponseIndex: (n: number) => void
  selectedResponseBody: string
  selectedResponse: any
  sendResult: any
  sendError: string | null
  responseHeight: number
  responseWidth: number
  orientation: 'vertical' | 'horizontal'
  responseSplitRef: React.RefObject<HTMLDivElement>
  isResizingResponse: boolean
  setIsResizingResponse: (v: boolean) => void
  formatMaybeJson: (v: any) => string
  responseViewTab: 'headers' | 'body'
  setResponseViewTab: (tab: 'headers' | 'body') => void
  responseContentType: string
  setResponseContentType: (type: string) => void
  responseStatusCode: string
  setResponseStatusCode: (code: string) => void
}

export default function RequestPane(props: Props) {
  const {
    selectedRequest,
    selectedCollection,
    urlDraft,
    setUrlDraft,
    handleSend,
    sending,
    activeTab,
    setActiveTab,
    bodyDraft,
    setBodyDraft,
    resolvedUrlPreview,
    handleBeautifyBody,
    REQUEST_TABS,
    headers,
    params,
    scripts,
    selectedDocument,
    renderActiveTab,
    responseExamples,
    selectedResponseIndex,
    setSelectedResponseIndex,
    selectedResponseBody,
    selectedResponse,
    sendResult,
    sendError,
    responseHeight,
    responseWidth,
    orientation,
    responseSplitRef,
    isResizingResponse,
    setIsResizingResponse,
    formatMaybeJson,
    responseViewTab,
    setResponseViewTab,
    responseContentType,
    setResponseContentType,
    responseStatusCode,
    setResponseStatusCode,
  } = props

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-[var(--bg)]">
      <div className="flex h-9 items-end gap-1 border-b border-[var(--border)] bg-[var(--bg-alt)] px-4">
        {selectedRequest ? (
          <button className="h-7 max-w-[260px] truncate rounded-t bg-[var(--surface)] px-4 text-left text-xs text-[var(--text)]">
            <span className={`mr-2 font-semibold ${selectedRequest ? '' : ''}`}>{selectedRequest.method}</span>
            {selectedRequest.name}
          </button>
        ) : (
          <button className="h-7 rounded-t bg-[var(--surface)] px-4 text-xs text-[var(--muted)]">No request selected</button>
        )}
        <button className="h-7 px-3 text-lg text-[var(--muted)]">+</button>
      </div>

      {selectedRequest ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-10 items-center gap-2 border-b border-[var(--border)] px-4 text-sm">
            <span className="text-[var(--muted)]">{selectedCollection?.name}</span>
            <span className="text-[var(--muted)]">&gt;</span>
            <span className="font-semibold text-[var(--text)]">{selectedRequest.name}</span>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-3">
              <div className={`flex h-8 w-24 items-center justify-center rounded border border-[var(--border)] bg-[var(--surface)] text-sm font-bold`}>{selectedRequest.method}</div>
              <input value={urlDraft} onChange={(event) => setUrlDraft(event.target.value)} className="h-8 min-w-0 flex-1 rounded border border-[var(--input-border)] bg-[var(--input)] px-3 font-mono text-sm text-[var(--text)] outline-none" />
              <button className="primary-button h-8 w-24" onClick={handleSend} disabled={sending}>{sending ? 'Sending' : 'Send'}</button>
            </div>
            {resolvedUrlPreview !== urlDraft ? (
              <div className="border-b border-[var(--border)] px-3 pb-2 text-xs text-[var(--muted)]">
                Resolved URL: <span className="font-mono text-[var(--text)]">{resolvedUrlPreview}</span>
              </div>
            ) : null}
            {sending ? (
              <div className="glow-strip mx-3 rounded-full">
                <div className="glow-slide" />
              </div>
            ) : null}
          </div>

          <div className="flex h-10 items-center gap-6 border-b border-[var(--border)] px-4 text-sm text-[var(--muted)]">
            {REQUEST_TABS.map((tab) => (
              <button key={tab} onClick={() => setActiveTab(tab)} className={`h-10 border-b-2 ${tab === activeTab ? 'border-[#f26b3a] font-semibold text-[var(--text)]' : 'border-transparent text-[var(--muted)] hover:text-[var(--text)]'}`}>
                {tab}
                {tab === 'Headers' && headers.length > 0 ? <span className="ml-1 text-[var(--muted)]">{headers.length}</span> : null}
              </button>
            ))}
          </div>

          {activeTab === 'Body' ? (
            <div className="flex h-10 items-center gap-4 border-b border-[var(--border)] px-4 text-sm text-[var(--muted)]">
              {['none', 'form-data', 'x-www-form-urlencoded', 'raw', 'binary', 'GraphQL'].map((item) => (
                <label key={item} className="flex items-center gap-2">
                  <span className={`h-3 w-3 rounded-full border ${item === (selectedDocument.body?.mode ?? 'raw') ? 'border-[#5797ff] bg-[#5797ff]' : 'border-[var(--border)]'}`} />
                  {item}
                </label>
              ))}
              <span className="font-semibold text-[#74a8ff]">JSON</span>
              <button className="secondary-button ml-auto h-7" type="button" onClick={handleBeautifyBody}>
                Beautify
              </button>
            </div>
          ) : null}

          <div ref={responseSplitRef} className={`min-h-0 flex flex-1 ${orientation === 'vertical' ? 'flex-col' : 'flex-row'} bg-[var(--bg)]`}>
            <div className={`min-h-0 flex-1 overflow-auto ${orientation === 'vertical' ? 'border-b' : 'border-r'} border-[var(--border)] bg-[var(--bg)]`}>{renderActiveTab()}</div>

            <div className={`${orientation === 'vertical' ? 'flex h-5 cursor-row-resize' : 'flex w-3 cursor-col-resize'} items-center justify-center bg-[var(--surface)] hover:bg-[var(--panel)]`} onPointerDown={(event) => { event.preventDefault(); setIsResizingResponse(true); event.currentTarget.setPointerCapture(event.pointerId); }}>
              <div className={`${orientation === 'vertical' ? 'flex h-1.5 w-12 items-center justify-between' : 'flex h-6 w-1 items-center justify-between'}`}>
                {orientation === 'vertical' ? (<><span className="block h-0.5 w-3 rounded-full bg-[var(--muted)]" /><span className="text-xs text-[var(--muted)]">⇕</span><span className="block h-0.5 w-3 rounded-full bg-[var(--muted)]" /></>) : (<><span className="block w-0.5 h-3 rounded-full bg-[var(--muted)]" /><span className="text-xs text-[var(--muted)]">⇆</span><span className="block w-0.5 h-3 rounded-full bg-[var(--muted)]" /></>)}
              </div>
            </div>

            <div className="min-h-0 overflow-auto px-4 py-3" style={orientation === 'vertical' ? { height: `${responseHeight}px` } as any : { width: `${responseWidth}px` } as any}>
              {sendError ? (
                <pre className="overflow-auto whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--panel)] p-3 font-mono text-xs leading-5 text-[var(--text)]">{sendError}</pre>
              ) : sendResult ? (
                <div className="space-y-3">
                  <div className="flex h-10 items-center gap-4 border-b border-[var(--border)] pb-3 text-sm">
                    <button
                      onClick={() => setResponseViewTab('headers')}
                      className={`h-8 px-3 rounded transition-colors ${
                        responseViewTab === 'headers'
                          ? 'bg-[var(--surface)] text-[var(--text)]'
                          : 'text-[var(--muted)] hover:text-[var(--text)]'
                      }`}
                    >
                      Headers
                    </button>
                    <button
                      onClick={() => setResponseViewTab('body')}
                      className={`h-8 px-3 rounded transition-colors ${
                        responseViewTab === 'body'
                          ? 'bg-[var(--surface)] text-[var(--text)]'
                          : 'text-[var(--muted)] hover:text-[var(--text)]'
                      }`}
                    >
                      Body
                    </button>

                    <div className="ml-auto flex items-center gap-3">
                      <span className="text-xs font-semibold text-[var(--muted)]">Status Code</span>
                      <select
                        value={responseStatusCode}
                        onChange={(e) => setResponseStatusCode(e.target.value)}
                        className="select-field h-8 w-32 rounded px-2 text-xs outline-none focus:border-[#5a8fff]"
                      >
                        {HTTP_STATUS_CODES.map((s) => (
                          <option key={s.code} value={String(s.code)}>
                            {s.code} {s.text}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {responseViewTab === 'headers' ? (
                    <div className="space-y-3">
                      {sendResult.headers.length > 0 ? (
                        <div className="grid grid-cols-[220px_1fr] gap-0 rounded border border-[var(--border)] text-xs overflow-hidden">
                          {sendResult.headers.map((header: any) => (
                            <div key={`${header.key}-${header.value}`} className="contents">
                              <div className="border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2 font-mono font-semibold text-[var(--text)]">{header.key}</div>
                              <div className="border-b border-[var(--border)] px-3 py-2 font-mono text-[var(--muted)] break-all">{header.value}</div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="flex h-20 items-center justify-center rounded border border-[var(--border)] text-sm text-[var(--muted)]">No headers</div>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex items-center gap-3 rounded border border-[var(--border)] bg-[var(--bg)] p-3">
                        <span className="text-xs font-semibold text-[var(--muted)]">Content Type</span>
                        <select
                          value={responseContentType}
                          onChange={(e) => setResponseContentType(e.target.value)}
                          className="select-field min-w-[140px] rounded px-2 py-1 text-xs outline-none focus:border-[#5a8fff]"
                        >
                          <option value="json">📄 JSON</option>
                          <option value="xml">📋 XML</option>
                          <option value="html">🌐 HTML</option>
                          <option value="text">📝 Text</option>
                          <option value="binary">⚙️ Binary</option>
                        </select>
                      </div>
                      <pre className="overflow-auto whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--panel)] p-3 font-mono text-xs leading-5 text-[var(--text)]">
                        {props.formatMaybeJson ? props.formatMaybeJson(sendResult.body) : (typeof sendResult.body === 'string' ? sendResult.body : JSON.stringify(sendResult.body, null, 2)) || 'No response body.'}
                      </pre>
                    </div>
                  )}
                </div>
              ) : responseExamples.length > 0 ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-3 rounded border border-[var(--border)] bg-[var(--bg)] p-3">
                    <div className="flex items-center gap-2 text-sm text-[var(--muted)]">
                      <span className="font-semibold text-[var(--text)]">Example</span>
                      <span className="text-[var(--muted)]">▼</span>
                    </div>
                    <select
                      value={selectedResponseIndex}
                      onChange={(event) => setSelectedResponseIndex(Number(event.target.value))}
                      className="select-field min-w-[180px] rounded px-3 py-2 text-sm outline-none focus:border-[#5a8fff]"
                    >
                      {responseExamples.map((response, index) => (
                        <option key={`${response.name ?? 'example'}-${index}`} value={index}>
                          {response.name ?? `Example ${index + 1}`} {response.status ? ` — ${response.status}` : ''}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-2 rounded border border-[var(--border)] bg-[var(--panel)] p-4">
                    <div className="flex flex-wrap items-center gap-3 text-sm">
                      <span className="font-semibold text-[var(--text)]">{selectedResponse?.name ?? 'Example'}</span>
                      <span className="text-[var(--muted)]">{selectedResponse?.status ?? 'Imported response'}</span>
                      {selectedResponse?.code ? (
                        <span className="rounded bg-[var(--panel)] px-2 py-0.5 text-xs text-[var(--muted)]">{selectedResponse.code}</span>
                      ) : null}
                    </div>
                    <pre className="overflow-auto whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--panel)] p-3 font-mono text-xs leading-5 text-[var(--text)]">
                      {selectedResponseBody || 'No response body.'}
                    </pre>
                  </div>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">Response body will appear here.</div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <h2 className="text-lg font-semibold text-[var(--text)]">No request open</h2>
            <p className="mt-2 max-w-sm text-sm text-[var(--muted)]">Import the sample Postman collection or create a collection to begin building the request workspace.</p>
          </div>
        </div>
      )}
    </section>
  )
}
