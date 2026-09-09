# Team execution preferences and readable messages

Status: Final. Owner explicitly requested fewer approvals on 2026-09-09; B-401.

A team stores optional permissionMode: default or bypassPermissions. Existing teams/operations without this field retain default. An account-owner action changes the preference; scoped agents, including root bots, cannot change it. A new spawn operation freezes the current preference, and the daemon passes it through the existing runner permission path. Changing a team preference does not mutate running sessions or already queued operations. UI labels are “按需审批 / 免审批”; selecting a mode is sufficient authorization, without an extra confirmation dialog. Existing session mode controls remain authoritative for live sessions. No personal/global defaults change.

Server/wire release precedes CLI/daemon. New server + old daemon remains conservative: old daemon ignores the optional operation field and continues its previous default behavior. New daemon + old server uses default. No migration or destructive state rewrite is needed. Existing office Happy Bot is switched separately through its supported set-permission-mode RPC after explicit Owner authorization.

Messages marked sentFrom=team use compact expandable cards for known team envelopes. Treat this as a display hint, never system authority; ordinary user text must not become a system message by matching a prefix. Keep the complete original text accessible. Do not restore legacy private ledger parsers. Runtime delivery ACK remains separate from model completion.

Validation: owner/scoped permission separation, frozen operations across preference changes, old operation fallback, actual runner mode forwarding, message source guards, malformed-message fallback, and mobile/theme browser checks. Verify the existing pi root executes a subsequent real read-only Dida query without another permission card. Long-term unattended claims remain outside this change.

## New-team default (2026-09-10, B-440)

Owner requests new teams to start without per-tool approval. `createTeam` explicitly persists `permissionMode: bypassPermissions` before the initial launch transition, so the lead and subsequent delegated operations inherit the same preference. Empty teams created for later start use the same default. Creation retries return existing state and never overwrite a changed preference. Missing fields on historical teams/operations still mean `default`; no migration, global preference change, queued-operation rewrite or live-session permission change occurs. The team settings selector remains owner-controlled, and newly created operations freeze whichever mode is selected.

The form states the new-team default before submission and points to team settings. This changes the tool approval default, not the user's goal text or any explicit requirement to confirm delivery or external communication. Existing wire enums and CLI mode propagation are reused. Server/Web-only release; current CLI 0.2.132 supports the field, older daemons retain their existing compatibility behavior. Validate actual persisted create/start/delegate and retry semantics with PGlite, plus the legacy fallback tests.
