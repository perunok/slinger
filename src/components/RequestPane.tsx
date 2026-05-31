import React from 'react'

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

          <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-3">
            <div className={`flex h-8 w-24 items-center justify-center rounded border border-[var(--border)] bg-[var(--surface)] text-sm font-bold`}>{selectedRequest.method}</div>
            <input value={urlDraft} onChange={(event) => setUrlDraft(event.target.value)} className="h-8 min-w-0 flex-1 rounded border border-[var(--input-border)] bg-[var(--input)] px-3 font-mono text-sm text-[var(--text)] outline-none" />
            <button className="primary-button h-8 w-24" onClick={handleSend} disabled={sending}>{sending ? 'Sending' : 'Send'}</button>
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
              {sendError ? (<pre className="overflow-auto whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--panel)] p-3 font-mono text-xs leading-5 text-[var(--text)]">{sendError}</pre>) : sendResult ? (<div className="space-y-3">{sendResult.headers.length > 0 ? (<div className="grid grid-cols-[220px_1fr] rounded border border-[var(--border)] text-xs">{sendResult.headers.map((header: any) => (<div key={`${header.key}-${header.value}`} className="contents"><div className="border-b border-[var(--border)] px-3 py-1 font-mono text-[var(--text)]">{header.key}</div><div className="border-b border-[var(--border)] px-3 py-1 font-mono text-[var(--muted)]">{header.value}</div></div>))}</div>) : null}<pre className="overflow-auto whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--panel)] p-3 font-mono text-xs leading-5 text-[var(--text)]">{props.formatMaybeJson ? props.formatMaybeJson(sendResult.body) : (typeof sendResult.body === 'string' ? sendResult.body : JSON.stringify(sendResult.body, null, 2)) || 'No response body.'}</pre></div>) : responseExamples.length > 0 ? (<div className="space-y-3"><div className="flex flex-wrap items-center gap-3 rounded border border-[var(--border)] bg-[var(--bg)] p-3"><div className="flex items-center gap-2 text-sm text-[var(--muted)]"><span className="font-semibold text-[var(--text)]">Example</span><span className="text-[var(--muted)]">▼</span></div><select value={selectedResponseIndex} onChange={(event) => setSelectedResponseIndex(Number(event.target.value))} className="select-field min-w-[180px] rounded px-3 py-2 text-sm outline-none focus:border-[#5a8fff]">{responseExamples.map((response, index) => (<option key={`${response.name ?? 'example'}-${index}`} value={index}>{response.name ?? `Example ${index + 1}`} {response.status ? ` — ${response.status}` : ''}</option>))}</select></div><div className="space-y-2 rounded border border-[var(--border)] bg-[var(--panel)] p-4"><div className="flex flex-wrap items-center gap-3 text-sm"><span className="font-semibold text-[var(--text)]">{selectedResponse?.name ?? 'Example'}</span><span className="text-[var(--muted)]">{selectedResponse?.status ?? 'Imported response'}</span>{selectedResponse?.code ? (<span className="rounded bg-[var(--panel)] px-2 py-0.5 text-xs text-[var(--muted)]">{selectedResponse.code}</span>) : null}</div><pre className="overflow-auto whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--panel)] p-3 font-mono text-xs leading-5 text-[var(--text)]">{selectedResponseBody || 'No response body.'}</pre></div></div>) : (<div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">Response body will appear here.</div>)}
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
