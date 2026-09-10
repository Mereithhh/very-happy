# File preview actions (B-447)

Status: implemented; release verification pending. Web-only; existing fs-list/fs-read RPCs remain unchanged.

- Path display is LTR. The apparent trailing slash was a reordered leading slash, not path data to trim.
- Shared viewer owns raw-byte download (chunked, bounded at 50 MiB), explicit text-content copy (never silently copies a truncated preview), and Excel preview.
- Spreadsheet parsing stays in a bundled worker using pinned SheetJS CE. No third-party document upload, formula execution, HTML cells or external resource loading. Parse time and rendered rows/columns are bounded, with visible limitations. Read-only sheet switching; download preserves the original file bytes.
- Pinning uses the source session or the currently viewed matching machine context. Never attach a file to an unrelated machine/session. Existing workspace tabs own selection/close/reorder behavior.
- Default file controls open the directory browser; changes remain an explicit tab. Mobile controls stay 44px, path/actions occupy separate rows when narrow.

Compatibility: old daemons keep existing single-chunk support; multi-chunk reads use the existing upgrade error. No CLI/server rollout dependency or schema changes.

Validation: real Chromium at 1280/390/320px in both themes, coarse touch targets, literal cell rendering, worksheet switching/pagination, byte-exact XLSX and binary downloads, separate path/content clipboard checks. Route regression verifies pin requests are consumed and repeatable; machine matching is tested. Preview is a read-only values grid, not full Office layout/chart editing.
