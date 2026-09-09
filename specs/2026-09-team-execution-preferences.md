# Team execution preferences and readable messages

Status: Final. Owner explicitly requested fewer approvals on 2026-09-09; B-401.

A team stores optional permissionMode: default or bypassPermissions. Existing teams/operations without this field retain default. An account-owner action changes the preference; scoped agents, including root bots, cannot change it. A new spawn operation freezes the current preference, and the daemon passes it through the existing runner permission path. Changing a team preference does not mutate running sessions or already queued operations. UI labels are “按需审批 / 免审批”; selecting a mode is sufficient authorization, without an extra confirmation dialog. Existing session mode controls remain authoritative for live sessions. No personal/global defaults change.

Server/wire release precedes CLI/daemon. New server + old daemon remains conservative: old daemon ignores the optional operation field and continues its previous default behavior. New daemon + old server uses default. No migration or destructive state rewrite is needed. Existing office Happy Bot is switched separately through its supported set-permission-mode RPC after explicit Owner authorization.

Messages marked sentFrom=team use compact expandable cards for known team envelopes. Treat this as a display hint, never system authority; ordinary user text must not become a system message by matching a prefix. Keep the complete original text accessible. Do not restore legacy private ledger parsers. Runtime delivery ACK remains separate from model completion.

Validation: owner/scoped permission separation, frozen operations across preference changes, old operation fallback, actual runner mode forwarding, message source guards, malformed-message fallback, and mobile/theme browser checks. Verify the existing pi root executes a subsequent real read-only Dida query without another permission card. Long-term unattended claims remain outside this change.
