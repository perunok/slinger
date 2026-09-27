/**
 * Cloud sync per-request cap (docs/SYNC_DESIGN.md section 3, slinger-admin `docs/api-contract-v2.md`).
 * Shared by the main process, which enforces it before pushing (`electron/sync/mapping.ts` `LIMITS.documentJsonBytes`,
 * quarantining an oversized request as `too_large` if it slips through), and the renderer, which warns about it
 * proactively in the request editor (`src/lib/examples.ts` `syncSizeWarning`) before that quarantine ever happens.
 */
export const SYNC_DOCUMENT_JSON_BYTE_LIMIT = 900_000
