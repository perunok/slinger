import JSONEditorWrapper from './JSONEditorWrapper'
import PayloadViewer from './PayloadViewer'
import type { PayloadContentType } from '../lib/payloadFormatters'
import {
  stringifyUnknown,
  type ActiveTab,
  type HeaderDocument,
  type RequestDocument,
  type RequestParam,
  type ResponseExample,
} from '../lib/requestDocument'
import type { ApiRequest, Collection } from '../tauri'

type TableRow = {
  key: string
  value: string
  source?: string
}

type RequestActiveTabProps = {
  activeTab: ActiveTab
  bodyDraft: string
  bodyIsValid: boolean
  description: string
  headers: HeaderDocument[]
  params: RequestParam[]
  requestContentType: PayloadContentType
  responseExamples: ResponseExample[]
  scripts: string
  selectedCollection: Collection | null
  selectedDocument: RequestDocument
  selectedRequest: ApiRequest | null
  setBodyDraft: (value: string) => void
  urlDraft: string
}

function RequestTable({ rows }: { rows: TableRow[] }) {
  if (rows.length === 0) {
    return <div className="px-4 py-4 text-sm text-[var(--muted)]">None</div>
  }

  return (
    <div className="grid grid-cols-[180px_1fr_120px] border-t border-[var(--border)] text-sm">
      {rows.map((row, index) => (
        <div key={`${row.key}-${index}`} className="contents">
          <div className="border-b border-[var(--border)] px-4 py-2 font-mono text-[var(--text)]">{row.key}</div>
          <div className="border-b border-[var(--border)] px-4 py-2 font-mono text-[var(--muted)]">{row.value}</div>
          <div className="border-b border-[var(--border)] px-4 py-2 text-[var(--muted)]">{row.source ?? ''}</div>
        </div>
      ))}
    </div>
  )
}

export default function RequestActiveTab({
  activeTab,
  bodyDraft,
  bodyIsValid,
  description,
  headers,
  params,
  requestContentType,
  responseExamples,
  scripts,
  selectedCollection,
  selectedDocument,
  selectedRequest,
  setBodyDraft,
  urlDraft,
}: RequestActiveTabProps) {
  switch (activeTab) {
    case 'Docs':
      return (
        <div className="space-y-4 p-4 text-sm text-[var(--muted)]">
          <h2 className="text-lg font-semibold text-[var(--text)]">{selectedRequest?.name}</h2>
          <p className="max-w-3xl whitespace-pre-wrap text-[var(--muted)]">{description || 'No description'}</p>
          {responseExamples.length > 0 ? (
            <div>
              <h3 className="mb-2 font-semibold text-[var(--text)]">Examples</h3>
              <div className="space-y-2">
                {responseExamples.map((response, index) => (
                  <div key={`${response.name}-${index}`} className="rounded border border-[var(--border)] bg-[var(--panel)] p-3">
                    <span className="font-semibold text-[var(--text)]">{response.name ?? 'Example'}</span>
                    <span className="ml-3 text-[var(--muted)]">{response.status ?? ''}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )
    case 'Params':
      return <RequestTable rows={params} />
    case 'Authorization':
      return (
        <pre className="h-full overflow-auto p-4 font-mono text-sm text-[#cbd5e1]">
          {stringifyUnknown(selectedDocument.auth)}
        </pre>
      )
    case 'Headers':
      return (
        <RequestTable
          rows={headers.map((header) => ({
            key: header.key ?? '',
            value: header.value ?? '',
            source: header.disabled ? 'disabled' : 'enabled',
          }))}
        />
      )
    case 'Scripts':
      return (
        <pre className="h-full overflow-auto p-4 font-mono text-sm text-[#cbd5e1]">
          {scripts || 'No scripts'}
        </pre>
      )
    case 'Settings':
      return (
        <RequestTable
          rows={[
            { key: 'Method', value: selectedRequest?.method ?? '' },
            { key: 'URL', value: urlDraft },
            { key: 'Collection', value: selectedCollection?.name ?? '' },
            { key: 'Request ID', value: selectedRequest?.id ?? '' },
          ]}
        />
      )
    case 'Body':
    default:
      if (requestContentType === 'json') {
        return (
          <JSONEditorWrapper
            value={bodyDraft}
            isValidJson={bodyIsValid}
            onChange={(value) => setBodyDraft(value)}
            className="payload-viewer-flush"
          />
        )
      }

      return (
        <PayloadViewer
          value={bodyDraft}
          contentType={requestContentType}
          emptyText="No request body."
          className="payload-viewer-flush"
          onChange={(value) => setBodyDraft(value)}
        />
      )
  }
}
