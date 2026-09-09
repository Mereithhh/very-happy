# Happy Bot workspace and discovery

Status: Final. B-402.

The default team page shows members, task lanes (queued/running/review/finished), task goals and result previews without expanding a disclosure. Task selection opens full evidence and version-bound actions. Acceptance stays explicit; presentation must not imply model activity equals task completion. Operational failures remain visible. Settings collect permission mode, linking and archive; schedules have a separate view. Core work remains visible without settings/forms crowding the page.

Sidebar uses labeled Happy Bot and Todo destinations, removing the legacy voice shortcut from primary navigation without deleting existing sessions or routes. Onboarding and the help center explain Happy Bot collaboration and native Todo, and expose host-specific official skill installation with copyable commands. Installation does not promise automatic discovery or attach unmanaged agents. Team availability stays account/online-machine gated.

Visual contract: Bespoke Operate, anchored in the existing Very Happy workspace. Restrained palette: light canvas #f4f4f1/ink #171715/accent #167d70/muted #666762, dark canvas #111210/ink #ecede8/accent #56b8a7/muted #92958d; implementation uses tokens.css names only. IBM Plex Sans 14–16px body/1.5 line height, 20–28px headings/600 weight; Mono only for real code/IDs. Short action labels and explicit states. No nested rounded cards, gradients, decorative color, icon-only product entrypoints, or default-hidden core task content. Existing logo/fonts/tokens are available; no external imagery required.

No wire/storage changes; old clients and existing sessions remain compatible. Validate real components in desktop/390px, light/dark, coarse pointer; task selection/close/focus, navigation, disabled/offline states, language fallback, readable long results and preserved retry/attempt actions. No new global permissions or old voice usage claims.

Validation: Web 2641 tests passed, TypeScript zero errors, production build passed. Actual components rendered in Chromium at390/1280px in both themes: no horizontal overflow, default result previews, settings and installation host switch, native dialog Escape and focus restoration after task lane movement. Fixture acceptance preserved attemptId and goalVersion3; no production mutation. css-probe before/after retained under skills/tmp/happy-bot-ui. Member last events remain labeled historical rather than task completion.
