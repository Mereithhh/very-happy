/**
 * English translations for the Happy app
 * Values can be:
 * - String constants for static text
 * - Functions with typed object parameters for dynamic text
 */

/**
 * English plural helper function
 * @param options - Object containing count, singular, and plural forms
 * @returns The appropriate form based on count
 */
function plural({ count, singular, plural }: { count: number; singular: string; plural: string }): string {
    return count === 1 ? singular : plural;
}

export const en = {
    tabs: {
        // Tab navigation labels
        inbox: 'Inbox',
        sessions: 'Terminals',
        settings: 'Settings',
        terminal: 'Terminal',
    },

    inbox: {
        // Inbox screen
        emptyTitle: 'No notifications',
        emptyDescription: 'Sessions that need your attention will show up here',
        updates: 'Updates',
        // Attention triage lane headers
        laneNeedsApproval: 'Needs approval',
        laneInProgress: 'In progress',
        laneToReview: 'To review',
        laneOther: 'Other',
    },

    notifications: {
        title: 'Notifications',
        settingsSubtitle: 'Browser alerts for session events (web)',
        webOnly: 'Web only',
        webOnlyDescription: 'Browser notifications are only available on the web app.',
        browserNotifications: 'Browser Notifications',
        masterDescription: 'Get alerted when a session needs your attention while this tab is in the background.',
        enable: 'Enable Notifications',
        enabledOn: 'On — alerts will show when this tab is unfocused',
        enabledOff: 'Off',
        unsupported: 'Not supported in this browser',
        permissionDeniedHint: 'Notifications are blocked. Enable them for this site in your browser settings.',
        types: 'Alert Types',
        typesDescription: 'Choose which session events trigger a notification.',
        type_permission_request: 'Permission requests',
        type_permission_request_desc: 'A session is asking to run a tool',
        type_reply_done: 'Reply finished',
        type_reply_done_desc: 'The agent finished responding',
        type_input_needed: 'Input needed',
        type_input_needed_desc: 'A session is waiting for your input',
        type_error: 'Errors',
        type_error_desc: 'A session ran into an error',
        quietHours: 'Do Not Disturb',
        quietHoursDescription: 'Silence notifications during a set time window.',
        quietHoursEnable: 'Enable quiet hours',
        quietHoursStart: 'From',
        quietHoursEnd: 'To',
        webhook: 'Webhook Notifications',
        webhookDescription: 'The server POSTs a {"title","message"} JSON to your own HTTPS endpoint when a session needs you — e.g. a notify gateway that forwards to your group chat. One webhook per account; saving replaces the previous one.',
        webhookUrl: 'Webhook URL',
        webhookUrlPlaceholder: 'https://ntfy.example.com/api/ingest/<token>',
        webhookEventCompleted: 'Task completed',
        webhookEventCompletedDesc: 'The agent finished its turn and the session is idle',
        webhookEventPermission: 'Needs attention',
        webhookEventPermissionDesc: 'Permission requests and clarifying questions',
        webhookRemove: 'Remove webhook',
        webhookSaved: 'Webhook saved',
        webhookRemoved: 'Webhook removed',
        unknownSession: 'Session',
        // --- notification center (bell + panel) ---
        inboxTitle: 'Notifications',
        inboxMarkAllRead: 'Mark all read',
        inboxEmpty: 'Nothing needs you right now',
        evtPermission: 'Asking to run a tool',
        evtReview: 'Agent suggests a look',
        evtBlocked: 'Agent reports it is stuck',
        evtNeedsInput: 'Terminal is waiting for input',
        evtTurnDone: 'Finished its turn',
        inboxGroup: 'Notification Center',
        inboxRetentionDescription: 'Notifications older than this are dropped from the bell panel.',
        retentionDays: ({ days }: { days: number }) => `Keep ${days} ${days === 1 ? 'day' : 'days'}`,
        // --- notification sound (WebAudio chime) ---
        sound: 'Notification Sound',
        soundDescription: 'A short synthesized chime when a session needs you. Browsers unmute audio after your first click or keypress in the page.',
        soundEnable: 'Play a sound',
        soundVolume: 'Volume',
        soundVoice: 'Chime',
        soundVoiceDescription: 'Selecting a chime plays a preview.',
        voiceDing: 'Ding',
        voiceDuo: 'Two-tone rise',
        voiceWoodblock: 'Woodblock',
        voiceMelody: 'Tiny tune',
        soundPreview: 'Preview',
        soundEvents: 'Play For',
        soundEventsDescription: 'Which events ring. The event\'s own session stays silent while you are looking at it; a hidden tab always rings.',
        soundEventPermission: 'Permission requests',
        soundEventPermissionDesc: 'A session is asking to run a tool',
        soundEventQuestion: 'Questions & input needed',
        soundEventQuestionDesc: 'Waiting for your input, flagged for review, or an error',
        soundEventDone: 'Turn finished',
        soundEventDoneDesc: 'The agent finished its turn',
    },

    common: {
        name: 'Username',
        // Simple string constants
        cancel: 'Cancel',
        authenticate: 'Authenticate',
        save: 'Save',
        saveAs: 'Save As',
        error: 'Error',
        success: 'Success',
        ok: 'OK',
        continue: 'Continue',
        back: 'Back',
        create: 'Create',
        rename: 'Rename',
        reset: 'Reset',
        logout: 'Logout',
        yes: 'Yes',
        no: 'No',
        discard: 'Discard',
        version: 'Version',
        copied: 'Copied',
        copy: 'Copy',
        scanning: 'Scanning...',
        urlPlaceholder: 'https://example.com',
        home: 'Home',
        message: 'Message',
        files: 'Files',
        fileViewer: 'File Viewer',
        loading: 'Loading...',
        retry: 'Retry',
        delete: 'Delete',
        optional: 'optional',
        open: 'Open',
        archive: 'Archive',
        close: 'Close',
    },

    profile: {
        userProfile: 'User Profile',
        details: 'Details',
        firstName: 'First Name',
        lastName: 'Last Name',
        username: 'Username',
        status: 'Status',
    },

    status: {
        connected: 'connected',
        connecting: 'connecting',
        disconnected: 'disconnected',
        error: 'error',
        online: 'online',
        offline: 'offline',
        lastSeen: ({ time }: { time: string }) => `last seen ${time}`,
        permissionRequired: 'permission required',
        activeNow: 'Active now',
        unknown: 'unknown',
        unread: 'new results',
    },

    liveStatus: {
        thinking: ({ elapsed }: { elapsed: string }) => `Thinking ${elapsed}`,
        runningTool: ({ tool, elapsed }: { tool: string; elapsed: string }) => `${tool} · ${elapsed}`,
        waitingPermission: 'Waiting for permission',
        reconnecting: 'Connection lost, reconnecting…',
    },

    time: {
        justNow: 'just now',
        minutesAgo: ({ count }: { count: number }) => `${count} minute${count !== 1 ? 's' : ''} ago`,
        hoursAgo: ({ count }: { count: number }) => `${count} hour${count !== 1 ? 's' : ''} ago`,
        daysAgo: ({ count }: { count: number }) => `${count} day${count !== 1 ? 's' : ''} ago`,
    },

    connect: {
        restoreAccount: 'Restore Account',
        enterSecretKey: 'Please enter a secret key',
        invalidSecretKey: 'Invalid secret key. Please check and try again.',
        enterUrlManually: 'Enter URL manually',
    },

    settings: {
        title: 'Settings',
        connectedAccounts: 'Connected Accounts',
        connectAccount: 'Connect account',
        github: 'GitHub',
        machines: 'Machines',
        showOfflineMachines: ({ count }: { count: number }) => count === 1 ? 'Show 1 offline machine' : `Show ${count} offline machines`,
        hideOfflineMachines: 'Hide offline machines',
        features: 'Features',
        social: 'Social',
        account: 'Account',
        accountSubtitle: 'Manage your account details',
        appearance: 'Appearance',
        appearanceSubtitle: 'Customize how the app looks',
        voiceAssistant: 'Voice Assistant',
        voiceAssistantSubtitle: 'Configure voice interaction preferences',
        featuresTitle: 'Features',
        featuresSubtitle: 'Enable or disable app features',
        developer: 'Developer',
        developerTools: 'Developer Tools',
        about: 'About',
        aboutFooter: 'Happy Coder is a Codex and Claude Code mobile client. This is a self-hosted instance — sign in with your password to reach your sessions from any device. Not affiliated with Anthropic.',
        whatsNew: 'What\'s New',
        whatsNewSubtitle: 'See the latest updates and improvements',
        reportIssue: 'Report an Issue',
        privacyPolicy: 'Privacy Policy',
        termsOfService: 'Terms of Service',
        eula: 'EULA',
        supportUs: 'Support us',
        supportUsSubtitlePro: 'Thank you for your support!',
        supportUsSubtitle: 'Support project development',
        scanQrCodeToAuthenticate: 'Scan QR code to authenticate',
        githubConnected: ({ login }: { login: string }) => `Connected as @${login}`,
        connectGithubAccount: 'Connect your GitHub account',
        claudeAuthSuccess: 'Successfully connected to Claude',
        exchangingTokens: 'Exchanging tokens...',
        usage: 'Usage',
        usageSubtitle: 'View your API usage and costs',
        // Dynamic settings messages
        accountConnected: ({ service }: { service: string }) => `${service} account connected`,
        machineStatus: ({ name, status }: { name: string; status: 'online' | 'offline' }) =>
            `${name} is ${status}`,
        featureToggled: ({ feature, enabled }: { feature: string; enabled: boolean }) =>
            `${feature} ${enabled ? 'enabled' : 'disabled'}`,
    },

    settingsAppearance: {
        // Appearance settings screen
        theme: 'Theme',
        themeDescription: 'Choose your preferred color scheme',
        themeOptions: {
            adaptive: 'Adaptive',
            light: 'Light', 
            dark: 'Dark',
        },
        themeDescriptions: {
            adaptive: 'Match system settings',
            light: 'Always use light theme',
            dark: 'Always use dark theme',
        },
        display: 'Display',
        displayDescription: 'Control layout and spacing',
        inlineToolCalls: 'Inline Tool Calls',
        inlineToolCallsDescription: 'Display tool calls directly in chat messages',
        expandTodoLists: 'Expand Todo Lists',
        expandTodoListsDescription: 'Show all todos instead of just changes',
        showLineNumbersInDiffs: 'Show Line Numbers in Diffs',
        showLineNumbersInDiffsDescription: 'Display line numbers in code diffs',
        showLineNumbersInToolViews: 'Show Line Numbers in Tool Views',
        showLineNumbersInToolViewsDescription: 'Display line numbers in tool view diffs',
        wrapLinesInDiffs: 'Wrap Lines in Diffs',
        wrapLinesInDiffsDescription: 'Wrap long lines instead of horizontal scrolling in diff views (touch devices; desktop always scrolls)',
        diffStyle: 'Diff View',
        diffStyleDescription: 'Show diffs as a single column (unified) or side-by-side (split). Split view is web-only.',
        diffStyleOptions: {
            unified: 'Unified',
            split: 'Split',
        },
        alwaysShowContextSize: 'Always Show Context Size',
        alwaysShowContextSizeDescription: 'Display context usage even when not near limit',
        avatarStyle: 'Avatar Style',
        avatarStyleDescription: 'Choose session avatar appearance',
        avatarOptions: {
            pixelated: 'Pixelated',
            gradient: 'Gradient',
        },
        showFlavorIcons: 'Show AI Provider Icons',
        showFlavorIconsDescription: 'Display AI provider icons on session avatars',
        // Home screen: what `/` shows when nothing is open (device-local)
        homeView: 'Home Screen',
        homeViewDescription: 'What the app shows when nothing is open.',
        homeViewOptions: {
            normal: 'Recents',
            board: 'Task Board',
        },
        homeViewDescriptions: {
            normal: 'The classic empty screen with quick actions',
            board: 'Every agent and terminal at a glance',
        },
        // Task Board V2 — daemon-side LLM analysis (progress notes / attention
        // flags / task classification). Informational only: the toggle lives on
        // the daemon machine, NOT here — the synced settings blob is encrypted
        // client-side and the CLI cannot read it.
        boardLlm: 'Board AI Analysis',
        boardLlmDescription: 'AI progress notes, attention flags and task grouping on the Task Board are produced by the Happy daemon (a local one-shot haiku call, throttled). Off by default so no tokens are spent silently.',
        boardLlmHowTo: 'Configure on the daemon machine',
        boardLlmHowToDetail: 'Set "boardLlm": true in ~/.happy/settings.json on each machine that should analyze its sessions, then restart sessions there.',
        // ⌘W close guards (device-local — what the shortcut can even reach
        // depends on this client: installed app vs browser tab)
        closeGuard: 'Closing a session with ⌘W',
        closeGuardDescription: '⌘W (installed app) / ⌥W (browser tab) closes the open session itself — a chat session is archived, a terminal is closed — the same flow as the row menu, then you land back home. On other screens the shortcut is left to the browser. In a browser tab ⌘W belongs to the browser anyway: it closes the whole tab before the page sees the key (the session keeps running), and only the browser\'s own dialog can interrupt that — its wording and styling cannot be customized.',
        closeViewConfirm: 'Confirm before ⌘W closes a session',
        closeViewConfirmDescription: 'Ask first when ⌘W / ⌥W would archive the open chat session or close the open terminal. Turn this off to skip the dialog and act immediately. Cancelling leaves you exactly where you were.',
        closeTabWarning: 'Warn before leaving the page',
        closeTabWarningDescription: 'While a session or terminal view is open, ask the browser to confirm closing or reloading the tab. Uses the browser\'s built-in dialog; deliberate in-app reloads (app updates, logout) are exempt.',
    },

    settingsFeatures: {
        // Features settings screen
        safety: 'Safety',
        changeApplicationDescription: 'Controls how new sessions start. Review-first modes (Plan / read-only) propose changes for you to approve before they are applied; auto-apply modes (Accept Edits / Bypass / YOLO) write changes without asking. This is a per-device preference and only sets the starting mode — you can still change it per session. For per-agent defaults, see Settings → Agents.',
        reviewChangesFirst: 'Review Changes First',
        reviewChangesFirstEnabled: 'New sessions start in a review-first mode',
        reviewChangesFirstDisabled: 'New sessions use the per-agent default mode',
        experiments: 'Experiments',
        experimentsDescription: 'Enable experimental features that are still in development. These features may be unstable or change without notice.',
        experimentalFeatures: 'Experimental Features',
        experimentalFeaturesEnabled: 'Experimental features enabled',
        experimentalFeaturesDisabled: 'Using stable features only',
        webFeatures: 'Web Features',
        webFeaturesDescription: 'Features available only in the web version of the app.',
        enterToSend: 'Enter to Send',
        enterToSendEnabled: 'Press Enter to send (Shift+Enter for a new line)',
        enterToSendDisabled: 'Enter inserts a new line',
        commandPalette: 'Command Palette',
        commandPaletteEnabled: 'Press ⌘K to open',
        commandPaletteDisabled: 'Quick command access disabled',
        markdownCopyV2: 'Markdown Copy v2',
        markdownCopyV2Subtitle: 'Long press opens copy modal',
        hideInactiveSessions: 'Hide inactive sessions',
        hideInactiveSessionsSubtitle: 'Show only active chats in your list',
        groupToolCalls: 'Group Tool Calls',
        groupToolCallsSubtitle: 'Collapse consecutive tool calls into one container',
        privacy: 'Privacy',
        privacyDescription: 'Completely disables all analytics and telemetry. No data will be sent to PostHog or any other tracking service.',
        disableAnalytics: 'Disable Analytics',
        analyticsDisabled: 'All tracking and telemetry disabled',
        analyticsEnabled: 'Anonymous usage analytics active',
        imageUpload: 'Image Upload',
        imageUploadSubtitle: 'Attach images to messages for Claude to analyze',
    },

    imageUpload: {
        permissionTitle: 'Photo Library Access',
        permissionMessage: 'Allow access to your photo library to attach images to messages.',
        limitTitle: 'Image Limit Reached',
        limitMessage: ({ max }: { max: number }) => `You can attach up to ${max} images per message.`,
        fileTooLargeTitle: 'File Too Large',
        fileTooLargeMessage: ({ name, maxMb }: { name: string; maxMb: number }) => `"${name}" exceeds the ${maxMb}MB limit and was not added.`,
        uploadFailedTitle: 'Upload Failed',
        uploadFailedMessage: ({ count }: { count: number }) => count === 1
            ? 'One image could not be uploaded and was not sent.'
            : `${count} images could not be uploaded and were not sent.`,
        notSupportedTitle: 'Images Not Supported',
        notSupportedMessage: 'This agent does not support image attachments. Only the text was sent.',
    },

    errors: {
        networkError: 'Network error occurred',
        serverError: 'Server error occurred',
        unknownError: 'An unknown error occurred',
        connectionTimeout: 'Connection timed out',
        authenticationFailed: 'Authentication failed',
        permissionDenied: 'Permission denied',
        fileNotFound: 'File not found',
        invalidFormat: 'Invalid format',
        operationFailed: 'Operation failed',
        tryAgain: 'Please try again',
        contactSupport: 'Contact support if the problem persists',
        sessionNotFound: 'Session not found',
        voiceSessionFailed: 'Failed to start voice session',
        voiceServiceUnavailable: 'Voice service is temporarily unavailable',
        voiceLimitReachedTitle: 'Voice Limit Reached',
        voiceHardLimitReached: ({ hours }: { hours: number }) => `You've used ${hours}+ hours of voice this month. This is the maximum allowed. You can configure your own ElevenLabs agent in Voice settings to use your own quota.`,
        voiceConversationLimitReached: 'You\'ve reached the maximum number of voice conversations this month. We may add on-demand voice usage in the future — please file an issue at github.com/nicepkg/happy/issues if you hit this limit.',
        oauthInitializationFailed: 'Failed to initialize OAuth flow',
        tokenStorageFailed: 'Failed to store authentication tokens',
        oauthStateMismatch: 'Security validation failed. Please try again',
        tokenExchangeFailed: 'Failed to exchange authorization code',
        oauthAuthorizationDenied: 'Authorization was denied',
        webViewLoadFailed: 'Failed to load authentication page',
        failedToLoadProfile: 'Failed to load user profile',
        userNotFound: 'User not found',
        sessionDeleted: 'Session has been deleted',
        sessionDeletedDescription: 'This session has been permanently removed',

        // Error functions with context
        fieldError: ({ field, reason }: { field: string; reason: string }) =>
            `${field}: ${reason}`,
        validationError: ({ field, min, max }: { field: string; min: number; max: number }) =>
            `${field} must be between ${min} and ${max}`,
        retryIn: ({ seconds }: { seconds: number }) =>
            `Retry in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}`,
        errorWithCode: ({ message, code }: { message: string; code: number | string }) =>
            `${message} (Error ${code})`,
        disconnectServiceFailed: ({ service }: { service: string }) => 
            `Failed to disconnect ${service}`,
        connectServiceFailed: ({ service }: { service: string }) =>
            `Failed to connect ${service}. Please try again.`,
        failedToLoadFriends: 'Failed to load friends list',
        failedToAcceptRequest: 'Failed to accept friend request',
        failedToRejectRequest: 'Failed to reject friend request',
        failedToRemoveFriend: 'Failed to remove friend',
        searchFailed: 'Search failed. Please try again.',
        failedToSendRequest: 'Failed to send friend request',
    },

    newSession: {
        savePreset: 'Save as preset',
        updatePreset: 'Update preset',
        machine: 'Machine',
        directory: 'Directory',
        agent: 'Agent',
        initialCommand: 'Initial instruction',
        initialCommandPlaceholder: '(optional) sent as the first message once the session starts',
        createDirTitle: 'Create directory?',
        createDirMessage: ({ directory }: { directory: string }) => `Directory ${directory} doesn't exist yet. Create it?`,
        title: 'Start New Session',
        startSession: 'Start Session',
        machineOffline: 'Machine is offline',
        switchMachinesHint: '• Switch machines by clicking on the machine above',
    },

    sessionHistory: {
        // Used by session history screen
        title: 'Session History',
        empty: 'No sessions found',
        today: 'Today',
        yesterday: 'Yesterday',
        daysAgo: ({ count }: { count: number }) => `${count} ${count === 1 ? 'day' : 'days'} ago`,
        viewAll: 'View all sessions',
    },

    session: {
        inputPlaceholder: 'Type a message ...',
        // B-098 composer manual expand toggle
        input: {
            expand: 'Expand input',
            collapse: 'Collapse input',
        },
        inactiveArchived: 'This session is inactive.',
        resumeFromTerminal: 'To resume it from the terminal:',
        // B-105 terminal mirror: read-only shadow session banners
        mirror: {
            readOnly: 'Read-only mirror · trails the terminal slightly · the bar below sends straight to the terminal',
            backToTerminal: 'Terminal',
            needsInput: 'Claude is waiting for input in the terminal',
            needsInputAction: 'Switch back',
            // B-107: the mirror input bar — text is pasted into the terminal's
            // claude (pty channel), not sent as a session message.
            inputPlaceholder: 'Send to the claude running in this terminal…',
            send: 'Send to terminal',
            sendHint: 'Pasted into the terminal + Enter (Shift+Enter for a newline)',
            sendNotActive: 'Claude is no longer running in that terminal — input was refused',
            sendUnsupported: 'The machine\'s CLI is too old for mirror input — update very-happy-cli',
            sendFailed: ({ error }: { error: string }) => `Send failed: ${error}`,
        },
        // Compact "done with uncommitted changes" bar shown above the composer
        // when the agent is idle and the working tree is dirty.
        done: 'Done',
        completedChanges: ({ count }: { count: number }) => count === 1 ? '1 file changed' : `${count} files changed`,
        viewDiff: 'View diff',
        newChat: 'New chat',
        setTitle: 'Set title',
        renameTitle: 'Rename session',
        renamePlaceholder: 'Session title',
        // Fork / duplicate / rewind flow (Claude only)
        forkAction: 'Fork session',
        forkSubtitle: 'Continue in a new session with the same context',
        duplicateAction: 'Duplicate from message…',
        duplicateSubtitle: 'Rewind to a chosen point and try again',
        forkFromHere: 'Fork from here',
        duplicateSheetTitle: 'Choose a rewind point',
        duplicateSheetSubtitle: 'The new session keeps the chosen turn complete (your message and the agent’s response) and drops every prompt after it.',
        duplicateSheetConfirm: 'Duplicate',
        duplicateSheetEmpty: 'No messages eligible for rewind in this session yet.',
        duplicateRowDisabled: "This message can't be used as a rewind point.",
        forkedFromLabel: 'Forked from',
        forkedFromSubtitle: 'Open the session this fork was branched from',
        forkErrorOffline: 'This machine is offline. Fork is only available while the machine that owns the session is online.',
        forkErrorMissingUuid: 'The chosen rewind point is no longer present in the source session — try forking without truncation.',
        forkErrorMissingMetadata: 'Missing session metadata required to fork.',
        forkErrorGeneric: 'Failed to fork the session.',
        forkClaudeOnly: 'Fork is currently only supported for Claude sessions.',
        chat: {
            loadOlder: 'Load older messages',
            loadingOlder: 'Loading older messages…',
            loadingMessages: 'Loading messages…',
            emptyTitle: 'No messages yet',
            emptyDescription: 'Send a message to start the conversation.',
            jumpToLatest: 'Jump to latest',
            send: 'Send',
            stop: 'Stop',
            sending: 'Sending…',
            stopping: 'Stopping…',
            enterToSend: 'Enter to send · Shift+Enter for newline',
            shiftEnterToSend: 'Shift+Enter to send · Enter for newline',
            offlineHint: 'Session is offline — messages will send when it reconnects.',
            connected: 'Connected',
            reconnecting: 'Reconnecting…',
            disconnected: 'Disconnected',
            thinkingLabel: 'Thinking',
            thinking: ({ seconds }: { seconds: string }) => `Thinking ${seconds}`,
            working: ({ seconds }: { seconds: string }) => `Working ${seconds}`,
            runningTool: ({ name, seconds }: { name: string; seconds: string }) => `${name} · ${seconds}`,
            needsPermission: 'Needs your approval',
            commandRan: ({ name }: { name: string }) => `Ran /${name}`,
            thoughtFor: ({ seconds }: { seconds: string }) => `Thought for ${seconds}`,
            contextMeter: ({ percent }: { percent: number }) => `${percent}% context used`,
            contextLeft: ({ percent }: { percent: number }) => `${percent}% left`,
            toolRunning: 'Running',
            toolError: 'Error',
            toolDone: 'Done',
            usedTools: ({ count }: { count: number }) => count === 1 ? '1 tool call' : `${count} tool calls`,
            modelLabel: 'model',
            permissionLabel: 'mode',
            effortLabel: 'effort',
            effortDefault: 'default',
            effortDefaultDesc: "engine default (currently high; may downgrade per model)",
            attach: 'Attach image',
            // Unified shortcuts (B-052): same list as the terminal menu, but
            // in the chat composer EVERY entry inserts (run flag ignored).
            presets: 'Shortcuts',
            presetsTitle: 'SHORTCUTS',
            // Desktop keyboard hint in the shortcuts menu head (⌘./Ctrl+.
            // opens the menu; digits 1-9 insert the numbered entry directly).
            presetsDigitHint: '1-9 to insert',
            files: 'Files',
            closeFiles: 'Close files',
            fileTree: 'Project files',
            changedFiles: 'Changed files',
            noFiles: 'No files',
            loadingFile: 'Loading file…',
            binaryFile: 'Binary file — not shown',
            refresh: 'Refresh',
            editN: ({ n, total }: { n: number; total: number }) => `Edit ${n} of ${total}`,
            replaceAll: 'replace all',
            // Long-content collapse in the transcript (B-097 code blocks /
            // B-102 user bubbles)
            expandLines: ({ lines }: { lines: number }) => `Show all (${lines} lines)`,
            collapseLines: 'Collapse',
            expandMessage: 'Expand',
        },
        permission: {
            title: 'Permission required',
            requests: ({ tool }: { tool: string }) => `${tool} wants to run`,
            approve: 'Approve',
            approveForSession: 'Approve for session',
            deny: 'Deny',
            approveAll: 'Approve all',
            denyAll: 'Deny all',
            pending: ({ count }: { count: number }) => count === 1 ? '1 request pending' : `${count} requests pending`,
        },
    },

    // Machine file browser (terminal drawer + session files panel "Browse")
    fsBrowser: {
        browseTab: 'Browse',
        breadcrumbs: 'Path',
        // B-110 sort toggle: title shows the CURRENT order, aria the action.
        sortedByTime: 'Sorted by modified time (newest first) — click for name order',
        sortedByName: 'Sorted by name — click for newest-first',
        sortByTime: 'Sort by modified time',
        sortByName: 'Sort by name',
        showHidden: 'Show hidden files',
        hideHidden: 'Hide hidden files',
        empty: 'Empty directory',
        retry: 'Retry',
        copyPath: 'Copy path',
        loadFailed: 'Failed to load',
        notFound: 'Path does not exist on this machine',
        permissionDenied: 'Permission denied',
        unsupported: 'Cannot browse files — the machine is offline, or its daemon is too old (upgrade very-happy-cli to ≥ 0.2.33)',
        timeout: 'The machine did not answer in time. It may have gone offline mid-request — try again.',
        listTruncated: ({ count }: { count: number }) => `Large directory — showing the first ${count} entries`,
        fileTruncated: ({ size }: { size: string }) => `Preview truncated — full file is ${size}`,
        binaryFile: ({ size }: { size: string }) => `Binary file (${size}) — no preview`,
        tooLarge: ({ size, limit }: { size: string; limit: string }) => `File too large to preview (${size}, limit ${limit})`,
        largeNeedsUpgrade: ({ size }: { size: string }) => `Previewing this file (${size}) needs a newer daemon — upgrade very-happy-cli on the machine`,
        viewSource: 'View source',
        viewRendered: 'View rendered',
        fullscreen: 'Fullscreen',
        exitFullscreen: 'Exit fullscreen',
        zoomToActual: 'Click to view at 100%',
        zoomToFit: 'Click to fit width',
    },

    commandPalette: {
        placeholder: 'Type a command or search...',
        // Categories
        categorySessions: 'Sessions',
        categoryRecentSessions: 'Recent Sessions',
        categoryNavigation: 'Navigation',
        categorySystem: 'System',
        categoryTerminals: 'Terminals',
        categoryDeveloper: 'Developer',
        // Commands
        newSession: 'New Session',
        newSessionSubtitle: 'Start a new chat session',
        viewAllSessions: 'View All Sessions',
        viewAllSessionsSubtitle: 'Browse your chat history',
        settings: 'Settings',
        settingsSubtitle: 'Configure your preferences',
        account: 'Account',
        accountSubtitle: 'Manage your account',
        connectDevice: 'Connect Device',
        connectDeviceSubtitle: 'Connect a new device via web',
        signOut: 'Sign Out',
        signOutSubtitle: 'Sign out of your account',
        developerMenu: 'Developer Menu',
        developerMenuSubtitle: 'Access developer tools',
        switchToSession: 'Switch to session',
        // ⌘K palette (navigate/actions)
        empty: 'No matches',
        groupActions: 'Actions',
        groupSessions: 'Chats',
        groupTerminals: 'Terminals',
        actionNewChat: 'New chat',
        actionNewChatAdvanced: 'New chat (choose options)…',
        actionNewTerminal: 'New terminal',
        actionRenameSession: 'Rename current chat',
        actionArchiveSession: 'Archive current chat',
        actionOpenSettings: 'Open settings',
        actionClipboardHistory: 'Clipboard history',
        actionAssistant: 'Voice assistant',
        actionNotes: 'Notes panel',
        actionAllNotes: 'All notes',
        renamePromptTitle: 'Rename chat',
        hintNavigate: '↑↓ to navigate',
        hintSelect: '↵ to select',
        hintClose: 'esc to close',
    },

    // /assistant — the Siri-like voice form (B-051)
    assistant: {
        title: 'Voice assistant',
        back: 'Back',
        holdToTalk: 'Hold to talk',
        enableVoice: 'Enable spoken replies',
        enableVoiceHint: 'Browsers require one tap before a page may play sound — tap once and replies will be read aloud.',
        transcript: 'Text transcript',
        transcriptEmpty: 'No messages yet.',
        thinkingTrace: 'Thinking trace',
        newConversation: 'New conversation',
        textPlaceholder: 'Type instead…',
        send: 'Send',
        retry: 'Retry',
        connecting: 'Preparing assistant session…',
        stateIdle: 'ready',
        stateListening: 'listening…',
        stateTranscribing: 'transcribing…',
        stateThinking: 'thinking…',
        stateSpeaking: 'speaking…',
        noMachineTitle: 'No machine online',
        noMachineDesc: 'The assistant runs on one of your machines. Start the happy daemon on a machine, then come back.',
        chooseMachine: 'Choose a machine for the assistant',
        upgradeCliTitle: 'CLI upgrade needed',
        upgradeCliDesc: ({ version, current }: { version: string; current: string }) =>
            `The voice assistant needs very-happy-cli ≥ ${version} on this machine (currently ${current}). Upgrade and restart the daemon.`,
        spawnError: 'Failed to start the assistant session',
        micError: 'Microphone unavailable — check browser permissions',
        ttsUnavailable: 'Voice replies unavailable — continuing in text-only mode',
        ttsTruncated: 'Speech truncated — full reply is on screen',
        audioUnlockFailed: 'Audio could not be enabled — tap "Enable voice" to try again',
        permissionWaiting: ({ tool }: { tool: string }) => `Waiting for permission approval: ${tool}`,
        permissionGo: 'Review',
        // B-092: friendly names for the assistant's usual tool face
        // (ticker + transcript). Unknown tools show their raw name.
        tools: {
            sessionsList: 'Checking session list',
            sessionSpawn: 'Dispatching a new task',
            sessionSend: 'Sending instructions',
            sessionRead: 'Checking session progress',
            terminalsList: 'Checking terminals',
            terminalRead: 'Reading terminal output',
            terminalSend: 'Typing into a terminal',
            memoryUpdate: 'Updating memory',
            journalAppend: 'Writing work journal',
            lookup: 'Consulting files',
            web: 'Searching the web',
        },
    },

    // copy_to_clipboard pushes: receive toasts + the history panel
    clipboard: {
        copiedPreview: ({ preview }: { preview: string }) => `Copied: ${preview}`,
        tapToCopy: ({ preview }: { preview: string }) => `Clipboard received — tap to copy: ${preview}`,
        historyTitle: 'Clipboard history',
        historyOpenSubtitle: 'Review, edit and re-copy received text',
        historyEmpty: 'Nothing received yet',
        clearAll: 'Clear all',
        clearAllConfirm: 'Delete all received clipboard entries? They may contain sensitive text and cannot be recovered.',
        expand: 'Expand',
        collapse: 'Collapse',
        autoCopyTitle: 'Auto-copy on receive',
        autoCopySubtitle: 'Silently write incoming pushes into this device\'s clipboard; when off or blocked by the browser, a tap-to-copy toast shows instead',
        sourceMachine: 'Machine',
        sourceSession: 'Session',
    },

    // open_preview pushes: the singleton file-preview overlay (B-131)
    filePreview: {
        title: 'File preview',
        receiveTitle: 'Open pushed previews',
        receiveSubtitle: 'When an agent calls open_preview, pop the file preview on this device. Off = this device ignores the push (your other devices still show it).',
        // diff mode is a parameter placeholder until B-036 lands
        diffUnavailable: 'Diff view is not built yet — showing the file as-is',
        machineOffline: ({ machine }: { machine: string }) =>
            `${machine} is offline, so the file cannot be read. Start the happy daemon there and this preview loads itself.`,
        machineUnknown: 'That machine is not on this account yet — the file cannot be read',
        noMachineForSession: 'An agent asked to preview a file, but this session has no machine recorded — nothing to read from',
        noSource: 'An agent asked to preview a file, but the request named no machine to read from',
    },

    // prompt notes: right-side dock + /notes screen (B-094)
    notes: {
        title: 'Notes',
        allNotes: 'All notes',
        exitFullscreen: 'Back to side panel',
        pinTab: 'Pin as tab',
        renameTags: 'Rename / tags',
        archive: 'Archive note',
        unarchive: 'Unarchive',
        archivedView: 'Archived notes',
        new: 'New note',
        close: 'Close panel',
        closeTab: 'Close tab',
        fullscreen: 'Open full view',
        untitled: 'Untitled',
        empty: 'No notes yet — jot down your next prompt while the agent works',
        loading: 'Loading…',
        noMatch: 'No matching notes',
        missing: 'This note was deleted',
        placeholder: 'Draft your next prompt here…',
        insert: 'Insert into input',
        noInputHere: 'No input on this screen — open a chat or terminal first',
        deleteTitle: 'Delete note',
        deleteConfirm: ({ title }: { title: string }) => `Delete “${title}” on every device? This cannot be undone.`,
        bindHere: ({ title }: { title: string }) => `Bind to ${title}`,
        unbind: 'Unbind',
        unbound: 'Not bound',
        jumpToBound: 'Jump to the bound session',
        capReached: 'Note limit reached (200) — delete some notes first',
        pickOrCreate: 'Pick a note on the left, or create one',
        filterPlaceholder: 'Filter notes…',
    },

    server: {
        // Used by Server Configuration screen (app/(app)/server.tsx)
        serverConfiguration: 'Server Configuration',
        enterServerUrl: 'Please enter a server URL',
        notValidHappyServer: 'Not a valid Happy Server',
        changeServer: 'Change Server',
        continueWithServer: 'Continue with this server?',
        resetToDefault: 'Reset to Default',
        resetServerDefault: 'Reset server to default?',
        validating: 'Validating...',
        validatingServer: 'Validating server...',
        serverReturnedError: 'Server returned an error',
        failedToConnectToServer: 'Failed to connect to server',
        currentlyUsingCustomServer: 'Currently using custom server',
        customServerUrlLabel: 'Custom Server URL',
        advancedFeatureFooter: "This is an advanced feature. Only change the server if you know what you're doing. You will need to log out and log in again after changing servers."
    },

    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        killSession: 'Kill Session',
        killSessionConfirm: 'Are you sure you want to terminate this session?',
        archiveSession: 'Archive Session',
        archiveSessionConfirm: 'Are you sure you want to archive this session?',
        happySessionIdCopied: 'Happy Session ID copied to clipboard',
        failedToCopySessionId: 'Failed to copy Happy Session ID',
        happySessionId: 'Happy Session ID',
        claudeCodeSessionId: 'Claude Code Session ID',
        claudeCodeSessionIdCopied: 'Claude Code Session ID copied to clipboard',
        codexThreadId: 'Codex Thread ID',
        codexThreadIdCopied: 'Codex Thread ID copied to clipboard',
        aiProvider: 'AI Provider',
        failedToCopyClaudeCodeSessionId: 'Failed to copy Claude Code Session ID',
        failedToCopyCodexThreadId: 'Failed to copy Codex Thread ID',
        metadataCopied: 'Session metadata copied to clipboard',
        failedToCopyMetadata: 'Failed to copy session metadata',
        failedToKillSession: 'Failed to kill session',
        failedToArchiveSession: 'Failed to archive session',
        connectionStatus: 'Connection Status',
        created: 'Created',
        lastUpdated: 'Last Updated',
        sequence: 'Sequence',
        quickActions: 'Quick Actions',
        viewMachine: 'View Machine',
        viewMachineSubtitle: 'View machine details and sessions',
        resumeSession: 'Resume Session',
        resumeSessionSubtitle: 'Resume this session on the same machine',
        resumeSessionSameMachineOnly: 'This session can only be resumed on the same machine it started on.',
        resumeSessionMachineOffline: 'This machine is offline. Resume is only available while it is online.',
        resumeSessionNeedsHappyAgent: 'Resume is unavailable on this machine. Run `happy-agent auth login` to enable it.',
        resumeSessionMissingMachine: 'This session is missing its machine metadata, so it cannot be resumed.',
        resumeSessionMissingBackendId: 'This session does not have a resumable Claude or Codex identifier.',
        resumeSessionUnexpectedDirectoryPrompt: 'Resume cannot create directories. Start the session manually from its original path.',
        killSessionSubtitle: 'Immediately terminate the session',
        archiveSessionSubtitle: 'Archive this session and stop it',
        metadata: 'Metadata',
        host: 'Host',
        path: 'Path',
        operatingSystem: 'Operating System',
        processId: 'Process ID',
        happyHome: 'Happy Home',
        copyMetadata: 'Copy session metadata',
        agentState: 'Agent State',
        controlledByUser: 'Controlled by User',
        pendingRequests: 'Pending Requests',
        activity: 'Activity',
        thinking: 'Thinking',
        thinkingSince: 'Thinking Since',
        cliVersion: 'CLI Version',
        cliVersionOutdated: 'CLI Update Required',
        cliVersionOutdatedMessage: ({ currentVersion, requiredVersion }: { currentVersion: string; requiredVersion: string }) =>
            `Version ${currentVersion} installed. Update to ${requiredVersion} or later`,
        updateCliInstructions: 'Please run npm install -g happy@latest',
        deleteSession: 'Delete Session',
        deleteSessionSubtitle: 'Permanently remove this session',
        deleteSessionConfirm: 'Delete Session Permanently?',
        deleteSessionWarning: 'This action cannot be undone. All messages and data associated with this session will be permanently deleted.',
        failedToDeleteSession: 'Failed to delete session',
        sessionDeleted: 'Session deleted successfully',
        worktreeCleanupTitle: 'Delete Worktree?',
        worktreeCleanupMessage: 'The worktree has no uncommitted changes. Would you like to delete the worktree files?',
        worktreeCleanupDelete: 'Delete Worktree',
        worktreeCleanupKeep: 'Keep Files',
        
    },

    components: {
        emptyMainScreen: {
            // Used by EmptyMainScreen component
            readyToCode: 'Ready to code?',
            installCli: 'Install the Very Happy CLI',
            runIt: 'Run it',
            scanQrCode: 'Scan the QR code',
            openCamera: 'Open Camera',
        },
    },

    newSessionModal: {
        // Used by NewSessionModal component
        eyebrow: 'NEW SESSION',
        heading: 'Start something',
        chatTitle: 'New chat',
        // The full options dialog, reachable from the "+" menu / palette now
        // that plain "New chat" quick-creates with the remembered defaults.
        advancedTitle: 'New chat (choose options)…',
        chatSubtitle: 'Let Claude or Codex start working on a machine',
        terminalTitle: 'Web terminal',
        terminalSubtitle: 'Open a terminal (tmux) on a connected machine',
    },

    emptyState: {
        // Used by EmptyDetailPane component
        pickUpTitle: 'Pick up where you left off',
        pickUpDescription: 'Select a conversation on the left, or start a new one on any connected machine.',
        newSession: 'New session',
        openWebTerminal: 'Open web terminal',
    },

    agentInput: {
        workingHint: 'Enter to queue · ⌘/Ctrl+Enter to interrupt & send',
        interruptAndSend: 'Interrupt and send',
        chip: {
            mode: 'mode',
            model: 'model',
            effort: 'effort',
        },
        permissionMode: {
            title: 'PERMISSION MODE',
            default: 'default permissions',
            acceptEdits: 'accept edits',
            plan: 'plan',
            dontAsk: "don't ask",
            bypassPermissions: 'yolo',
            badgeAcceptAllEdits: 'accept all edits',
            badgeBypassAllPermissions: 'yolo',
            badgePlanMode: 'plan mode',
        },
        agent: {
            claude: 'Claude',
            codex: 'Codex',
            gemini: 'Gemini',
            openclaw: 'OpenClaw',
        },
        model: {
            title: 'MODEL',
            configureInCli: 'Configure models in CLI settings',
        },
        effort: {
            title: 'EFFORT',
        },
        codexPermissionMode: {
            title: 'CODEX PERMISSION MODE',
            default: 'default permissions',
            readOnly: 'read-only',
            safeYolo: 'safe yolo',
            yolo: 'yolo',
            badgeReadOnly: 'read-only',
            badgeSafeYolo: 'safe yolo',
            badgeYolo: 'yolo',
        },
        codexModel: {
            title: 'CODEX MODEL',
            gpt5CodexLow: 'gpt-5-codex low',
            gpt5CodexMedium: 'gpt-5-codex medium',
            gpt5CodexHigh: 'gpt-5-codex high',
            gpt5Minimal: 'GPT-5 Minimal',
            gpt5Low: 'GPT-5 Low',
            gpt5Medium: 'GPT-5 Medium',
            gpt5High: 'GPT-5 High',
        },
        geminiPermissionMode: {
            title: 'GEMINI PERMISSION MODE',
            default: 'default permissions',
            autoEdit: 'auto edit',
            yolo: 'yolo',
            plan: 'plan',
            badgeAutoEdit: 'auto edit',
            badgeYolo: 'yolo',
            badgePlan: 'plan',
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `${percent}% left`,
            used: ({ percent }: { percent: number }) => `${percent}% context`,
            compact: 'Compact',
        },
        suggestion: {
            fileLabel: 'FILE',
            folderLabel: 'FOLDER',
        },
        noMachinesAvailable: 'No machines',
    },

    machineLauncher: {
        showLess: 'Show less',
        showAll: ({ count }: { count: number }) => `Show all (${count} paths)`,
        enterCustomPath: 'Enter custom path',
        offlineUnableToSpawn: 'Unable to spawn new session, offline',
    },


    renameModal: {
        titleLabel: 'Title',
        tagsLabel: 'Tags',
        tagPlaceholder: 'Add tag…',
    },

    sidebar: {
        collapse: 'Collapse sidebar',
        openSessions: 'Open sessions',
        archiveConfirm: 'Archive this session?',
        sessionsTitle: 'Very Happy',
        showArchived: 'Show archived',
        hideArchived: 'Hide archived',
        newSession: 'New session',
        searchPlaceholder: 'Search sessions',
        // coarse-pointer header icon that opens the ⌘K palette
        openSearch: 'Search',
        filterAll: 'All',
        filterActive: 'Active',
        filterArchived: 'Archived',
        // view switch (列表/状态/归档) + status-view lifecycle sections
        viewList: 'List',
        viewStatus: 'Status',
        groupWaiting: 'Waiting on me',
        groupRunning: 'Running',
        groupDoneToday: 'Done today',
        empty: 'No sessions yet',
        noResults: 'No matching sessions',
        moveToTop: 'Move to top',
        moveUp: 'Move up',
        moveDown: 'Move down',
        // sort-mode switch (列表 view only) — the label states the CURRENT
        // mode and what a click does, since one icon carries both.
        sortByRecent: 'Sorted by recent activity — click for manual order',
        sortManual: 'Manual order — click to sort by recent activity',
        // B-091 tag grouping (列表 view) — label states the CURRENT mode and
        // what a click does, same convention as the sort switch above.
        groupByTagOn: 'Grouped by tag — click for flat list',
        groupByTagOff: 'Flat list — click to group by tag',
        groupUntagged: 'Untagged',
        // B-091 priority marker (the `priority` convention tag)
        markPriority: 'Mark as priority',
        unmarkPriority: 'Clear priority',
        // 已结束终端 (B-084): archived view's closed-terminal records
        closedTerminals: 'Closed terminals',
        closedTerminalReopen: 'New terminal in this directory',
        // B-105: closed terminal that had a mirror — its history stays readable
        closedTerminalHistory: 'View structured history',
        // B-085 two-level row signal (aria/title on the right-edge dot)
        rowNeedsAttention: 'Waiting for you',
        rowUnread: 'Unread activity',
    },

    zen: {
        toggle: 'Zen mode',
    },

    toolView: {
        input: 'Input',
        output: 'Output',
    },

    toolGroup: {
        editedFile: 'Edited file',
        editedFiles: ({ count }: { count: number }) => count === 1 ? 'Edited 1 file' : `Edited ${count} files`,
        readFiles: ({ count }: { count: number }) => count === 1 ? 'Read 1 file' : `Read ${count} files`,
        ranCommands: ({ count }: { count: number }) => count === 1 ? 'Ran 1 command' : `Ran ${count} commands`,
        searched: ({ count }: { count: number }) => count === 1 ? 'Searched 1 time' : `Searched ${count} times`,
        fetchedUrls: ({ count }: { count: number }) => count === 1 ? 'Fetched 1 URL' : `Fetched ${count} URLs`,
        ranTasks: ({ count }: { count: number }) => count === 1 ? 'Ran 1 task' : `Ran ${count} tasks`,
        usedTools: ({ count }: { count: number }) => count === 1 ? 'Used 1 tool' : `Used ${count} tools`,
        workedFor: ({ duration }: { duration: string }) => `Worked ${duration}`,
    },

    tools: {
        fullView: {
            description: 'Description',
            inputParams: 'Input Parameters',
            output: 'Output',
            error: 'Error',
            completed: 'Tool completed successfully',
            noOutput: 'No output was produced',
            running: 'Tool is running...',
            rawJsonDevMode: 'Raw JSON (Dev Mode)',
        },
        taskView: {
            initializing: 'Initializing agent...',
            moreTools: ({ count }: { count: number }) => `+${count} more ${plural({ count, singular: 'tool', plural: 'tools' })}`,
        },
        multiEdit: {
            editNumber: ({ index, total }: { index: number; total: number }) => `Edit ${index} of ${total}`,
            replaceAll: 'Replace All',
        },
        names: {
            task: 'Task',
            terminal: 'Terminal',
            searchFiles: 'Search Files',
            search: 'Search',
            searchContent: 'Search Content',
            listFiles: 'List Files',
            planProposal: 'Plan proposal',
            readFile: 'Read File',
            editFile: 'Edit File',
            writeFile: 'Write File',
            fetchUrl: 'Fetch URL',
            readNotebook: 'Read Notebook',
            editNotebook: 'Edit Notebook',
            todoList: 'Todo List',
            webSearch: 'Web Search',
            reasoning: 'Reasoning',
            applyChanges: 'Update file',
            viewDiff: 'Current file changes',
            question: 'Question',
        },
        askUserQuestion: {
            submit: 'Submit Answer',
            multipleQuestions: ({ count }: { count: number }) => `${count} questions`,
            other: 'Other',
            otherDescription: 'Type your own answer',
            otherPlaceholder: 'Type your answer...',
        },
        desc: {
            terminalCmd: ({ cmd }: { cmd: string }) => `Terminal(cmd: ${cmd})`,
            searchPattern: ({ pattern }: { pattern: string }) => `Search(pattern: ${pattern})`,
            searchPath: ({ basename }: { basename: string }) => `Search(path: ${basename})`,
            fetchUrlHost: ({ host }: { host: string }) => `Fetch URL(url: ${host})`,
            editNotebookMode: ({ path, mode }: { path: string; mode: string }) => `Edit Notebook(file: ${path}, mode: ${mode})`,
            todoListCount: ({ count }: { count: number }) => `Todo List(count: ${count})`,
            webSearchQuery: ({ query }: { query: string }) => `Web Search(query: ${query})`,
            grepPattern: ({ pattern }: { pattern: string }) => `grep(pattern: ${pattern})`,
            multiEditEdits: ({ path, count }: { path: string; count: number }) => `${path} (${count} edits)`,
            readingFile: ({ file }: { file: string }) => `Reading ${file}`,
            writingFile: ({ file }: { file: string }) => `Writing ${file}`,
            modifyingFile: ({ file }: { file: string }) => `Modifying ${file}`,
            modifyingFiles: ({ count }: { count: number }) => `Modifying ${count} files`,
            modifyingMultipleFiles: ({ file, count }: { file: string; count: number }) => `${file} and ${count} more`,
            showingDiff: 'Showing changes',
        }
    },

    files: {
        changes: 'Changes',
        searchPlaceholder: 'Search files...',
        detachedHead: 'detached HEAD',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `${staged} staged • ${unstaged} unstaged`,
        notRepo: 'Not a git repository',
        notUnderGit: 'This directory is not under git version control',
        searching: 'Searching files...',
        noFilesFound: 'No files found',
        noFilesInProject: 'No files in project',
        tryDifferentTerm: 'Try a different search term',
        searchResults: ({ count }: { count: number }) => `Search Results (${count})`,
        projectRoot: 'Project root',
        stagedChanges: ({ count }: { count: number }) => `Staged Changes (${count})`,
        unstagedChanges: ({ count }: { count: number }) => `Unstaged Changes (${count})`,
        // File viewer strings
        loadingFile: ({ fileName }: { fileName: string }) => `Loading ${fileName}...`,
        binaryFile: 'Binary File',
        cannotDisplayBinary: 'Cannot display binary file content',
        diff: 'Diff',
        file: 'File',
        fileEmpty: 'File is empty',
        noChanges: 'No changes to display',
        noChangesTitle: 'No changes',
        noChangesSubtitle: 'Working tree is clean',
        deleted: 'Deleted',
        changedFiles: ({ count }: { count: number }) => `${count} changed ${count === 1 ? 'file' : 'files'}`,
        allFiles: 'All Files',
        editFile: 'Edit',
        saveFile: 'Save',
        failedToRead: 'Failed to read file',
        failedToSave: 'Failed to save file',
        fileConflict: 'File conflict',
        fileConflictDescription: 'This file was modified on the device while you were editing. Reload to see the latest version.',
        reload: 'Reload',
        overwrite: 'Overwrite',
        collapseSidebar: 'Collapse sidebar',
        expandSidebar: 'Expand sidebar',
    },

    settingsMachines: {
        title: 'Machines',
        subtitle: 'Rename machines, spawn sessions, browse recent paths',
        listTitle: 'Known machines',
        footer: 'Tap a machine to rename it (the name syncs to every device) or start a session there.',
        empty: 'No machines yet — run very-happy on a machine to register it.',
        online: 'online',
        offline: 'offline',
    },
    settingsVoice: {
        // Voice settings page (web v2, B-051 assistant TTS)
        title: 'Voice',
        subtitle: 'Assistant voice & read-aloud',
        voice: 'Voice',
        voiceDefault: 'Server default',
        preview: 'Preview',
        voicesUnavailable: 'Voice list unavailable — server not upgraded or voice not configured',
        // B-081: voice library (browse + add shared voices)
        library: 'Voice library',
        libraryBrowse: 'Browse Chinese voice library…',
        libraryLanguage: 'Language',
        libraryHint: 'Popular voices from the ElevenLabs Voice Library. Adding a voice puts it in the voice list above and selects it.',
        libraryEmpty: 'No voices found',
        libraryLoadFailed: 'Failed to load voice library — tap to retry',
        libraryUnavailable: 'Voice library unavailable — server not upgraded or voice not configured',
        libraryAdd: 'Add',
        libraryAdded: ({ name }: { name: string }) => `Voice added: ${name}`,
        libraryAddFailed: 'Failed to add voice',
        readTextReplies: 'Read replies to typed messages',
        readTextRepliesHint: 'Replies to voice messages are always read aloud',
        pttSound: 'Hold-to-talk sound cues',
        pttSoundHint: 'Short tones when recording starts, is sent, or is cancelled',
        skipPermissions: 'Skip permission approvals',
        skipPermissionsHint: 'On by default. When off, sensitive assistant actions need your manual approval. Takes effect on the next assistant start / new conversation.',
        assistantMachine: 'Assistant machine',
        assistantMachineAuto: 'Automatic (sole online machine)',
        // B-069: speech recognition language (batch + streaming ASR)
        asrLanguage: 'Recognition language',
        asrLanguageAuto: 'Auto detect',
        asrLanguageHint: 'If you always speak one language, picking it explicitly improves recognition accuracy significantly.',
        // Voice settings screen
        languageTitle: 'Language',
        languageDescription: 'Choose your preferred language for voice assistant interactions. This setting syncs across all your devices.',
        preferredLanguage: 'Preferred Language',
        preferredLanguageSubtitle: 'Language used for voice assistant responses',
        language: {
            searchPlaceholder: 'Search languages...',
            title: 'Languages',
            footer: ({ count }: { count: number }) => `${count} ${plural({ count, singular: 'language', plural: 'languages' })} available`,
            autoDetect: 'Auto-detect',
        },
        // Bring your own agent
        byoTitle: 'Bring Your Own Agent',
        byoDescription: 'Use your own ElevenLabs agent instead of the Happy default. No subscription required — connect directly with your own ElevenLabs account. Your agent must define two client tools: messageClaudeCode (sends text to the coding agent) and processPermissionRequest (allows or denies tool use). It receives session context via the {{initialConversationContext}} dynamic variable.',
        customAgentId: 'ElevenLabs Agent ID',
        customAgentIdNotSet: 'Not configured',
        customAgentIdDescription: 'Enter your ElevenLabs agent ID. Leave empty to use the Happy default.',
        customAgentIdPlaceholder: 'e.g. abc123def456',
        bypassToken: 'Direct Connection',
        bypassTokenSubtitle: 'Skip Happy server, connect straight to ElevenLabs',
        promptGuideTitle: 'Agent Prompt Guide',
        promptGuideDescription: 'Your ElevenLabs agent needs:\n\n• Tool: messageClaudeCode — parameter: message (string). Sends a message to the active coding session.\n• Tool: processPermissionRequest — parameter: decision ("allow" or "deny"). Approves or denies a pending tool permission.\n• Dynamic variable: {{initialConversationContext}} — receives session history and context on start.\n\nThe agent acts as a voice bridge between the user and coding agents. It should be concise, only respond when addressed, and report when a coding agent finishes work.',
        // Voice usage
        usageTitle: 'Usage (Last 30 Days)',
        usageFooter: 'Voice time used in the last 30 days. Free tier: 20 min. Subscribed: 5 hours. Max 100 conversations per month.',
        usageLabel: 'Voice Time',
        conversationsLabel: 'Conversations',
        usageUsed: ({ used, limit }: { used: string; limit: string }) => `${used} used of ${limit}`,
        supportTitle: 'Upgrade Voice',
        supportSubtitle: 'Get more voice time and support development',
    },

    settingsAccount: {
        // Account settings screen
        createAccountTitle: 'Create account',
        accountInformation: 'Account Information',
        status: 'Status',
        statusActive: 'Active',
        statusNotAuthenticated: 'Not Authenticated',
        anonymousId: 'Anonymous ID',
        publicId: 'Public ID',
        notAvailable: 'Not available',
        linkNewDevice: 'Link New Device',
        linkNewDeviceSubtitle: 'Scan QR code to link device',
        password: 'Password',
        passwordSet: 'Set a password to sign in on the web',
        passwordChange: 'Change your account password',
        profile: 'Profile',
        name: 'Name',
        github: 'GitHub',
        tapToDisconnect: 'Tap to disconnect',
        server: 'Server',
        backup: 'Backup',
        backupDescription: 'Your secret key is the only way to recover your account. Save it in a secure place like a password manager.',
        secretKey: 'Secret Key',
        tapToReveal: 'Tap to reveal',
        tapToHide: 'Tap to hide',
        secretKeyLabel: 'SECRET KEY (TAP TO COPY)',
        secretKeyCopied: 'Secret key copied to clipboard. Store it in a safe place!',
        secretKeyCopyFailed: 'Failed to copy secret key',
        privacy: 'Privacy',
        privacyDescription: 'Help improve the app by sharing anonymous usage data. No personal information is collected.',
        analytics: 'Analytics',
        analyticsDisabled: 'No data is shared',
        analyticsEnabled: 'Anonymous usage data is shared',
        dangerZone: 'Danger Zone',
        logout: 'Logout',
        logoutSubtitle: 'Sign out and clear local data',
        logoutConfirm: 'Are you sure you want to logout? Make sure you have backed up your secret key!',
    },

    settingsLanguage: {
        // Language settings screen
        title: 'Language',
        description: 'Choose your preferred language for the app interface. This will sync across all your devices.',
        currentLanguage: 'Current Language',
        automatic: 'Automatic',
        automaticSubtitle: 'Detect from device settings',
        needsRestart: 'Language Changed',
        needsRestartMessage: 'The app needs to restart to apply the new language setting.',
        restartNow: 'Restart Now',
    },

    connectButton: {
        authenticate: 'Authenticate Terminal',
        authenticateWithUrlPaste: 'Authenticate Terminal with URL paste',
        pasteAuthUrl: 'Paste the auth URL from your terminal',
    },

    updateBanner: {
        updateAvailable: 'Update available',
        pressToApply: 'Press to apply the update',
        whatsNew: "What's new",
        seeLatest: 'See the latest updates and improvements',
        nativeUpdateAvailable: 'App Update Available',
        tapToUpdateAppStore: 'Tap to update in App Store',
        tapToUpdatePlayStore: 'Tap to update in Play Store',
    },

    changelog: {
        // Used by the changelog screen
        version: ({ version }: { version: number }) => `Version ${version}`,
        noEntriesAvailable: 'No changelog entries available.',
    },

    terminal: {
        // Closing a web terminal ends its tmux session on the machine.
        // Deliberately neutral wording (B-083 archive-only): the claude
        // conversation inside survives on the machine (`claude --resume`).
        closeTitle: 'Close terminal?',
        closeMessage: 'This ends the tmux session on the machine. The Claude conversation inside is saved on the machine — continue it in a new terminal with claude --resume.',
        // Used by terminal connection screens
        webBrowserRequired: 'Web Browser Required',
        webBrowserRequiredDescription: 'Terminal connection links can only be opened in a web browser for security reasons. Please use the QR code scanner or open this link on a computer.',
        processingConnection: 'Processing connection...',
        invalidConnectionLink: 'Invalid Connection Link',
        invalidConnectionLinkDescription: 'The connection link is missing or invalid. Please check the URL and try again.',
        connectTerminal: 'Connect Terminal',
        terminalRequestDescription: 'A terminal is requesting to connect to your Happy Coder account. This will allow the terminal to send and receive messages securely.',
        connectionDetails: 'Connection Details',
        publicKey: 'Public Key',
        encryption: 'Encryption',
        endToEndEncrypted: 'End-to-end encrypted',
        acceptConnection: 'Accept Connection',
        connecting: 'Connecting...',
        reject: 'Reject',
        security: 'Security',
        securityFooter: 'This connection link was processed securely in your browser and was never sent to any server. Your private data will remain secure and only you can decrypt the messages.',
        securityFooterDevice: 'This connection was processed securely on your device and was never sent to any server. Your private data will remain secure and only you can decrypt the messages.',
        clientSideProcessing: 'Client-Side Processing',
        linkProcessedLocally: 'Link processed locally in browser',
        linkProcessedOnDevice: 'Link processed locally on device',
        // Web terminal (tmux) quick commands & drag-upload overlay
        quickCommands: 'Quick commands',
        quickCommandsEmpty: 'No commands yet. Add them in Settings → Snippets.',
        uploadingFile: 'Uploading…',
        dropToUpload: 'Drop to upload',
        pathWillBePasted: 'path will be pasted into the terminal',
        // Claude Code status inside a web terminal (sidebar dot + notification)
        claudeWorking: 'Claude: working',
        claudeNeedsInput: 'Claude: needs input',
        claudeNeedsInputBody: 'Claude needs your input',
        // B-105 terminal mirror: header toggle to the structured (chat) face
        structuredView: 'Structured view',
        selectMode: 'Select / copy mode',
        selectModeHint: 'Select mode — long-press to select & copy · tap again to scroll',
        // Accessible name for the mobile assistive key bar (Esc/Tab/Ctrl/arrows…)
        keybarLabel: 'Terminal keys',
        // Mobile key bar: hide the soft keyboard (blur the terminal)
        hideKeyboard: 'Hide keyboard',
        // Mobile key bar: toggle line-input mode (compose a whole line in a
        // plain textarea — IME/dictation friendly — and send it on Enter)
        inputBarToggle: 'Line input',
        inputBarPlaceholder: 'Type a command · Enter to send',
        inputBarSend: 'Send',
        // Unified shortcuts menu in the web terminal (header menu on desktop,
        // key-bar menu on mobile). Insert entries paste into the terminal
        // input (the user presses Enter); run entries ($-marked, run:true)
        // execute on select.
        presets: 'Shortcuts',
        presetsTitle: 'SHORTCUTS',
        // Desktop keyboard hint in the shortcuts menu head (⌘./Ctrl+. opens
        // the menu; digits 1-9 pick the numbered entry — run entries execute).
        presetsDigitHint: '1-9 to pick',
        // Badge tooltip/aria on $-marked entries.
        presetsRunBadge: 'Runs on select',
        // Empty-state item (menu absorbed the old quick-commands menu, which
        // always offered a way into settings).
        presetsManage: 'Manage shortcuts…',
    },

    board: {
        // Global task board (/board): every chat session + web terminal grouped
        // by what it needs from the user right now
        title: 'Task Board',
        // short label for the sidebar filter-row entry (mobile way in)
        filterLabel: 'Board',
        attention: 'Needs attention',
        working: 'Working',
        idleEnded: 'Idle / ended',
        emptyAttention: 'Nothing needs you',
        emptyWorking: 'Nothing running',
        emptyIdle: 'Nothing idle',
        // ---- lifecycle view (default layout) ----
        layoutLifecycle: 'Lifecycle',
        waiting: 'Waiting for you',
        done: 'Done',
        emptyWaiting: 'Nothing waiting on you',
        emptyDone: 'Nothing completed in the last 24h',
        // reap-band badge: agent finished, not marked done yet
        readyToReview: 'ready to collect',
        taskDoneSessionsPrompt: ({ count }: { count: number }) =>
            `Also mark ${count} session${count === 1 ? '' : 's'} on this task as done? Marking done archives them.`,
        // ended terminal whose machine dropped off
        machineOffline: 'machine offline',
        endedTag: 'ended',
        waitingFor: ({ duration }: { duration: string }) => `waiting ${duration}`,
        // rendered after a compact duration, e.g. "3m ago"
        agoSuffix: 'ago',
        viewArchived: 'View archived →',
        // ---- V2: task swimlanes + dispatch ----
        layoutStatus: 'Status',
        layoutTasks: 'Tasks',
        newTask: 'New task',
        taskTitlePlaceholder: 'Task title',
        taskDescriptionPlaceholder: 'Description — prefills the first message of dispatched sessions',
        createTask: 'Create',
        dispatch: 'Dispatch',
        markDone: 'Mark done',
        editTask: 'Edit task',
        deleteTask: 'Delete task',
        deleteTaskConfirm: ({ title }: { title: string }) => `Delete task "${title}"? Its sessions stay, they just become ungrouped.`,
        ungrouped: 'Ungrouped',
        emptyLane: 'Nothing here yet',
        noTasks: 'No tasks yet — create one and dispatch sessions onto it',
        // LLM attention badges (metadata.board.attention)
        llmReview: 'review',
        llmBlocked: 'blocked',
    },

    modals: {
        // Used across connect flows and settings
        authenticateTerminal: 'Authenticate Terminal',
        pasteUrlFromTerminal: 'Paste the authentication URL from your terminal',
        deviceLinkedSuccessfully: 'Device linked successfully',
        terminalConnectedSuccessfully: 'Terminal connected successfully',
        invalidAuthUrl: 'Invalid authentication URL',
        developerMode: 'Developer Mode',
        developerModeEnabled: 'Developer mode enabled',
        developerModeDisabled: 'Developer mode disabled',
        disconnectGithub: 'Disconnect GitHub',
        disconnectGithubConfirm: 'Are you sure you want to disconnect your GitHub account?',
        disconnectService: ({ service }: { service: string }) => 
            `Disconnect ${service}`,
        disconnectServiceConfirm: ({ service }: { service: string }) => 
            `Are you sure you want to disconnect ${service} from your account?`,
        disconnect: 'Disconnect',
        failedToConnectTerminal: 'Failed to connect terminal',
        cameraPermissionsRequiredToConnectTerminal: 'Camera permissions are required to connect terminal',
        failedToLinkDevice: 'Failed to link device',
        cameraPermissionsRequiredToScanQr: 'Camera permissions are required to scan QR codes'
    },

    navigation: {
        // Navigation titles and screen headers
        connectTerminal: 'Connect Terminal',
        linkNewDevice: 'Link New Device',
        restoreWithSecretKey: 'Restore with Secret Key',
        whatsNew: "What's New",
        friends: 'Friends',
        loginWithPassword: 'Login with Password',
        setPassword: 'Set Password',
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'Claude Code, from any browser',
        subtitle: 'Sign in with your password to pick up your coding sessions on any device — no app store, no QR code.',
        createAccount: 'Create account',
        linkOrRestoreAccount: 'Link or restore account',
        loginWithMobileApp: 'Login with mobile app',
        loginWithPassword: 'Login with password',
        // WelcomeInstall landing card (web)
        installForkTitle: 'A friendly fork of Happy',
        installIntro: 'Very Happy builds on Happy and trades end-to-end encryption for password-based, multi-device convenience.',
        installFeaturePassword: 'Password sign-in, any device',
        installFeatureSync: 'Multi-device sync',
        installFeatureTerminal: 'Web terminal over tmux',
        installFeatureModels: 'Latest models + reworked UI',
        installHeading: 'USE IT ON YOUR OWN COMPUTER',
        installStep1: 'Install Claude Code so the `claude` command is on your PATH.',
        installStep2: 'Install the CLI from npm:',
        installStep3: 'Run it on the machine you want to control — pre-configured to this server.',
        installNote: 'Server-trusted: your sessions are relayed through this server, whose operator can read them. Only sign up if you trust them.',
    },

    passwordLogin: {
        // Password login screen (web)
        title: 'Welcome back',
        subtitle: 'Enter your password to unlock your account on this device.',
        passwordPlaceholder: 'Password',
        unlock: 'Unlock',
        errorEmpty: 'Please enter your password.',
        errorWrongPassword: 'Incorrect password. Please try again.',
        errorNoPassword: 'No password is set for this account yet. Link this device from your phone, then set a password in Settings.',
        errorNetwork: 'Could not reach the server. Check your connection and try again.',
    },

    setPassword: {
        // Set / change account password (from Settings, while logged in)
        intro: 'Set a password to sign in on new devices without scanning a QR code. Your password never leaves this device — it only encrypts your account key.',
        passwordLabel: 'New password',
        passwordPlaceholder: 'At least 8 characters',
        confirmLabel: 'Confirm password',
        confirmPlaceholder: 'Re-enter password',
        save: 'Save password',
        success: 'Your password has been saved.',
        errorTooShort: ({ count }: { count: number }) => `Password must be at least ${count} characters.`,
        errorMismatch: 'Passwords do not match.',
        errorNotAuthenticated: 'You must be signed in to set a password.',
        errorSaveFailed: 'Could not save your password. Please try again.',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: 'Enjoying the app?',
        feedbackPrompt: "We'd love to hear your feedback!",
        yesILoveIt: 'Yes, I love it!',
        notReally: 'Not really'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label} copied to clipboard`
    },

    machine: {
        noMachines: 'No machines connected',
        noMachinesDescription: 'Start the Happy daemon on a computer to see it here.',
        launchNewSessionInDirectory: 'Launch New Session in Directory',
        offlineUnableToSpawn: 'Launcher disabled while machine is offline',
        offlineHelp: '• Make sure your computer is online\n• Run `happy daemon status` to diagnose\n• Are you running the latest CLI version? Upgrade with `npm install -g happy@latest`',
        daemon: 'Daemon',
        status: 'Status',
        stopDaemon: 'Stop Daemon',
        lastKnownPid: 'Last Known PID',
        lastKnownHttpPort: 'Last Known HTTP Port',
        startedAt: 'Started At',
        cliVersion: 'CLI Version',
        daemonStateVersion: 'Daemon State Version',
        activeSessions: ({ count }: { count: number }) => `Active Sessions (${count})`,
        machineGroup: 'Machine',
        host: 'Host',
        machineId: 'Machine ID',
        username: 'Username',
        homeDirectory: 'Home Directory',
        platform: 'Platform',
        architecture: 'Architecture',
        lastSeen: 'Last Seen',
        never: 'Never',
        metadataVersion: 'Metadata Version',
        cliAvailability: 'CLI Availability',
        cliInstalled: 'Installed',
        cliNotFound: 'Not found',
        lastDetected: 'Last Detected',
        untitledSession: 'Untitled Session',
        back: 'Back',
        dangerZone: 'Danger Zone',
        delete: 'Delete Machine',
        deleteFooter: 'Remove this machine from your account. Session history will be preserved, but you will not be able to start new sessions on this machine.',
        deleteConfirmTitle: 'Delete this machine?',
        deleteConfirmMessage: 'The machine will be removed from your account. Session history will be preserved, but you will not be able to start new sessions until you reconnect the daemon.',
        deleteFailed: 'Failed to delete machine.',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `Switched to ${mode} mode`,
        unknownEvent: 'Unknown event',
        copyMessage: 'Copy message',
        usageLimitUntil: ({ time }: { time: string }) => `Usage limit reached until ${time}`,
        unknownTime: 'unknown time',
    },

    codex: {
        // Codex permission dialog buttons
        permissions: {
            yesForSession: "Yes, and don't ask for a session",
            stopAndExplain: 'Stop, and explain what to do',
        }
    },

    claude: {
        // Claude permission dialog buttons
        permissions: {
            approve: 'Approve',
            deny: 'Deny',
            yesAllowAllEdits: 'Yes, allow all edits during this session',
            yesAllowEverything: 'Yes, allow everything during this session',
            yesForTool: "Yes, don't ask again for this tool",
            noTellClaude: 'No, and provide feedback',
        }
    },

    permissions: {
        // Batch approval bar shown when several requests are pending at once
        pendingCount: ({ count }: { count: number }) => `${count} permissions pending`,
        approveAll: 'Approve all',
        denyAll: 'Deny all',
    },

    textSelection: {
        // Text selection screen
        selectText: 'Select text range',
        title: 'Select Text',
        noTextProvided: 'No text provided',
        textNotFound: 'Text not found or expired',
        textCopied: 'Text copied to clipboard',
        failedToCopy: 'Failed to copy text to clipboard',
        noTextToCopy: 'No text available to copy',
    },

    markdown: {
        // Markdown copy functionality
        codeCopied: 'Code copied',
        copyFailed: 'Copy failed',
        mermaidRenderFailed: 'Failed to render mermaid diagram',
    },

    artifacts: {
        // Artifacts feature
        title: 'Artifacts',
        countSingular: '1 artifact',
        countPlural: ({ count }: { count: number }) => `${count} artifacts`,
        empty: 'No artifacts yet',
        emptyDescription: 'Create your first artifact to get started',
        new: 'New Artifact',
        edit: 'Edit Artifact',
        delete: 'Delete',
        updateError: 'Failed to update artifact. Please try again.',
        notFound: 'Artifact not found',
        discardChanges: 'Discard changes?',
        discardChangesDescription: 'You have unsaved changes. Are you sure you want to discard them?',
        deleteConfirm: 'Delete artifact?',
        deleteConfirmDescription: 'This action cannot be undone',
        titleLabel: 'TITLE',
        titlePlaceholder: 'Enter a title for your artifact',
        bodyLabel: 'CONTENT',
        bodyPlaceholder: 'Write your content here...',
        emptyFieldsError: 'Please enter a title or content',
        createError: 'Failed to create artifact. Please try again.',
        save: 'Save',
        saving: 'Saving...',
        loading: 'Loading artifacts...',
        error: 'Failed to load artifact',
    },

    friends: {
        // Friends feature
        title: 'Friends',
        manageFriends: 'Manage your friends and connections',
        searchTitle: 'Find Friends',
        pendingRequests: 'Friend Requests',
        myFriends: 'My Friends',
        noFriendsYet: "You don't have any friends yet",
        findFriends: 'Find Friends',
        remove: 'Remove',
        pendingRequest: 'Pending',
        sentOn: ({ date }: { date: string }) => `Sent on ${date}`,
        accept: 'Accept',
        reject: 'Reject',
        addFriend: 'Add Friend',
        alreadyFriends: 'Already Friends',
        requestPending: 'Request Pending',
        searchInstructions: 'Enter a username to search for friends',
        searchPlaceholder: 'Enter username...',
        searching: 'Searching...',
        userNotFound: 'User not found',
        noUserFound: 'No user found with that username',
        checkUsername: 'Please check the username and try again',
        howToFind: 'How to Find Friends',
        findInstructions: 'Search for friends by their username. Both you and your friend need to have GitHub connected to send friend requests.',
        requestSent: 'Friend request sent!',
        requestAccepted: 'Friend request accepted!',
        requestRejected: 'Friend request rejected',
        friendRemoved: 'Friend removed',
        confirmRemove: 'Remove Friend',
        confirmRemoveMessage: 'Are you sure you want to remove this friend?',
        cannotAddYourself: 'You cannot send a friend request to yourself',
        bothMustHaveGithub: 'Both users must have GitHub connected to become friends',
        status: {
            none: 'Not connected',
            requested: 'Request sent',
            pending: 'Request pending',
            friend: 'Friends',
            rejected: 'Rejected',
        },
        acceptRequest: 'Accept Request',
        removeFriend: 'Remove Friend',
        removeFriendConfirm: ({ name }: { name: string }) => `Are you sure you want to remove ${name} as a friend?`,
        requestSentDescription: ({ name }: { name: string }) => `Your friend request has been sent to ${name}`,
        requestFriendship: 'Request friendship',
        cancelRequest: 'Cancel friendship request',
        cancelRequestConfirm: ({ name }: { name: string }) => `Cancel your friendship request to ${name}?`,
        denyRequest: 'Deny friendship',
        nowFriendsWith: ({ name }: { name: string }) => `You are now friends with ${name}`,
    },

    usage: {
        // Usage panel strings
        today: 'Today',
        last7Days: 'Last 7 days',
        last30Days: 'Last 30 days',
        totalTokens: 'Total Tokens',
        totalCost: 'Total Cost',
        tokens: 'Tokens',
        cost: 'Cost',
        usageOverTime: 'Usage over time',
        byKind: 'By Token Type',
        noData: 'No usage data available',
    },

    feed: {
        // Feed notifications for friend requests and acceptances
        friendRequestFrom: ({ name }: { name: string }) => `${name} sent you a friend request`,
        friendRequestGeneric: 'New friend request',
        friendAccepted: ({ name }: { name: string }) => `You are now friends with ${name}`,
        friendAcceptedGeneric: 'Friend request accepted',
    },

    settingsSnippets: {
        // Unified shortcuts settings (B-052): ONE list for the chat composer
        // and the web terminal. Entries with "run in terminal" enabled are
        // executed (Enter) when picked from the TERMINAL menu; everything
        // else — and every entry in the chat composer — inserts without Enter.
        navTitle: 'Shortcuts',
        navSubtitle: 'Saved snippets for chat + terminal',
        editorTitleLabel: 'TITLE',
        editorTitlePlaceholder: 'optional, first line if blank',
        editorCancel: 'Cancel',
        editorSave: 'Save',
        editPreset: 'Edit shortcut',
        newPreset: 'New shortcut',
        deleteTitle: 'Delete?',
        deleteConfirm: 'Delete',
        presetsGroup: 'Shortcuts',
        presetsFooter: 'One list for the chat composer and the web terminal: picking an entry inserts its text (press Enter to send). Entries marked "$" run immediately when picked in the terminal.',
        addPreset: 'Add shortcut',
        // Editor toggle: run:true → terminal menu executes on select.
        runToggle: 'Run in terminal on select',
        startupGroup: 'Terminal startup command',
        startupFooter: 'Runs automatically when a NEW web terminal is created — never again when reattaching to an existing session. Leave empty to disable.',
        startupPlaceholder: 'e.g. cd ~/code && claude — empty = off',
        // Experimental input-path switch (B-093). Wording is deliberately
        // blunt about "flip it back if anything breaks": the whole reason this
        // is a device-local setting and not a build flag is zero-release
        // rollback.
        inputOwnershipGroup: 'Terminal input method (experimental)',
        inputOwnershipFooter: 'Who owns the terminal keyboard and IME state machine. The new path takes over composition itself, so an interrupted IME (switching input sources mid-word) can no longer wedge it. If anything misbehaves — a key doing nothing, odd focus, candidate window in the wrong place — switch back to Standard; it takes effect immediately, no reload or release needed. Desktop only for now.',
        inputOwnershipOptions: {
            xterm: 'Standard',
            own: 'Own input (experimental)',
        },
        inputOwnershipDescriptions: {
            xterm: 'The terminal library handles keys and composition — today\'s behavior.',
            own: 'We handle keys and composition; pinyin/kana is drawn in place at the cursor.',
        },
        // B-105 terminal mirror: which face a mirrored terminal opens with on
        // THIS device. Per-terminal toggles (in the terminal header / mirror
        // banner) override this default and are remembered per terminal.
        viewDefaultGroup: 'Terminal default view',
        viewDefaultFooter: 'When a terminal is running Claude and has a structured mirror, open it in this view by default on this device. Toggling inside a terminal is remembered per terminal and wins over this default.',
        viewDefaultOptions: {
            xterm: 'Terminal (xterm)',
            structured: 'Structured chat',
        },
        viewDefaultDescriptions: {
            xterm: 'The raw terminal — full TUI fidelity.',
            structured: 'The read-only chat rendering of the Claude conversation.',
        },
    },

    tmuxHelp: {
        title: 'Keyboard shortcuts',
        // tmux cheat-sheet modal (web terminal header "?" button)
        heading: 'Shortcuts',
        mouse: 'Mouse',
        prefix: 'Prefix',
        prefixNote: 'Press Ctrl-b, release, then the key',
        scrollback: 'Scrollback',
        panes: 'Panes',
        windows: 'Windows',
        session: 'Session',
        keyWheel: 'Wheel',
        labelWheel: 'Wheel scrolls history',
        keyClick: 'Click',
        labelClick: 'Click panes & windows',
        keyShiftDrag: 'Shift+Drag',
        labelShiftDrag: 'Select to copy',
        labelPrefix: 'Prefix for every command',
        labelEnterCopy: 'Enter copy mode',
        labelScroll: 'Scroll',
        labelQuit: 'Quit copy mode',
        labelSplitV: 'Split vertically',
        labelSplitH: 'Split horizontally',
        labelMovePanes: 'Move between panes',
        labelZoom: 'Zoom toggle',
        labelClosePane: 'Close pane',
        labelNewWindow: 'New window',
        labelNextPrev: 'Next / prev',
        labelJump: 'Jump by number',
        labelDetach: 'Detach — keeps running',
    },

    // Keyboard shortcuts help overlay (web only).
    shortcuts: {
        eyebrow: 'KEYBOARD',
        title: 'Keyboard shortcuts',
        search: 'Search',
        switchSession: 'Switch to session',
        renameSession: 'Rename current session',
        goBack: 'Go back',
        showHelp: 'Show this help',
    },

    // Account signup screen (web).
    signup: {
        title: 'Create your account',
        subtitle: 'Pick a username and password to reach your sessions from any device.',
        username: 'Username',
        usernamePlaceholder: 'username',
        password: 'Password',
        passwordPlaceholder: 'At least 8 characters',
        confirm: 'Confirm password',
        confirmPlaceholder: 'Re-enter password',
        inviteCode: 'Invite code',
        inviteCodePlaceholder: 'invite code (optional)',
        submit: 'Create account',
        haveAccount: 'Already have an account? Sign in',
        errorUsernameShort: ({ count }: { count: number }) => `Username must be at least ${count} characters.`,
        errorUsernameTaken: 'That username is taken.',
        errorPasswordShort: ({ count }: { count: number }) => `Password must be at least ${count} characters.`,
        errorMismatch: 'Passwords do not match.',
        errorInviteRequired: 'A valid invite code is required to sign up.',
        errorSignupClosed: 'Signups are currently closed.',
        errorRateLimited: 'Too many attempts. Wait a minute and try again.',
        errorGeneric: 'Could not create your account. Please try again.',
        success: 'Account created. Welcome!',
    },

    // Per-agent defaults settings screen.
    settingsAgents: {
        title: 'Agent defaults',
        subtitle: 'Default permission, model and effort per agent for new sessions.',
        intro: 'These defaults apply to new sessions. You can still change them per session.',
        clearOverrides: 'Reset all to defaults',
        clearOverridesConfirm: 'Reset every agent default back to the built-in values?',
        cleared: 'Agent defaults reset.',
        permission: 'Permission',
        model: 'Model',
        effort: 'Effort',
        useCodeDefault: 'Use default',
        codeDefaultSuffix: ' (default)',
        noOverrides: 'Using built-in defaults',
        // Quick new-chat group (sidebar "+" / palette direct creation).
        newSessions: 'New chat creation',
        newSessionsFooter: 'New chats are created instantly on your most recent machine and directory. Model, effort and permission come from the per-agent defaults below — with no override set, nothing is sent and the machine\'s own CLI configuration applies (e.g. /model in claude). The full dialog stays available under "New chat (choose options)".',
        defaultAgent: 'Default agent',
        alwaysAsk: 'Always ask',
        alwaysAskDescription: 'Open the full options dialog on every new chat instead of creating instantly',
    },

    // Channels — settings hub for external integrations: outbound webhook
    // notifications + inbound automation surfaces (CLI, MCP, IM adapters).
    settingsChannels: {
        title: 'Channels',
        subtitle: 'Webhooks, automation CLI and chat integrations',
        // Pointer left behind on the Notifications page after WebhookGroup
        // moved here.
        movedTitle: 'Webhook notifications have moved',
        movedSubtitle: 'Configure your account webhook under Settings → Channels',
        cliTitle: 'Automation CLI (inbound)',
        cliIntro: 'Scripts and bots on the machine that runs your daemon can start sessions and talk to them — no extra credentials, the CLI reuses the daemon\'s. The daemon must be running to spawn.',
        cliSpawnLabel: 'Start a new session in a directory. Without --json it prints a clickable session URL; with --json it emits {"sessionId","url"}:',
        cliSpawnExit: 'Exit codes: 0 success · 1 spawn failed (no session created) · 2 session created but the first message failed (the URL is still printed).',
        cliSendLabel: 'Push a follow-up message into a session that is already running (it must have been spawned by this machine\'s daemon — the session key lives in ~/.happy/sessions.json):',
        cliSendExit: 'Exit codes: 0 delivered · 1 anything else (bad arguments, unknown session or missing key, send failed). Use --prompt-file <path> instead of --prompt for long or multi-line text.',
        mcpTitle: 'Clipboard tool (MCP)',
        mcpIntro: 'Give a plain claude CLI — for example one running inside a Happy web terminal — a copy_to_clipboard tool that pushes text to the clipboard of every web client you have open. Register it once per machine:',
        imTitle: 'IM adapter pattern',
        imIntro: 'Any chat app can become a remote control for Happy. Every webhook notification ends with a fixed, machine-parseable last line — "session: <id>" — that survives text-only relays. An adapter (our Tanka integration is the reference) forwards notifications into a group chat, listens to its own IM, and when you quote-reply to a notification it extracts the session id from that line and pipes your reply back with "very-happy send". Fresh tasks are started from chat via "very-happy spawn".',
        imDocs: 'Full documentation',
        imDocsSubtitle: 'docs/channels.md — webhook contract, CLI reference, adapter example',
    },

    // Diagnostics / health screen.
    diagnostics: {
        webBuild: 'Web build',
        webBuildVersion: 'Build',
        webBuildCheck: 'Check for update',
        webBuildChecking: 'Checking…',
        webBuildCurrent: 'Up to date',
        webBuildUpdating: 'New version found — reloading…',
        webBuildCheckFailed: 'Could not check (offline?)',
        title: 'Diagnostics',
        subtitle: 'Relay, machine and daemon health',
        relay: 'Relay',
        serverSocket: 'Server socket',
        realtime: 'Realtime / voice',
        statusConnected: 'Connected',
        statusConnecting: 'Connecting…',
        statusDisconnected: 'Disconnected',
        statusError: 'Error',
        statusIdle: 'Idle',
        lastConnected: 'Last connected',
        lastDisconnected: 'Last disconnected',
        machinesAndDaemons: 'Machines & daemons',
        noMachines: 'No machines connected yet.',
        online: 'Online',
        offline: 'Offline',
        daemonStatus: 'Daemon',
        cliMissing: ({ cli }: { cli: string }) => `${cli} not found — remote sessions will fail`,
        cliHint: 'If a CLI is missing while the machine is online, make sure the daemon launches with the CLI on its PATH (e.g. ~/.local/bin).',
        never: 'Never',
        developer: 'Developer',
        developerFooter: 'Troubleshooting toggles for this device only. Leave off unless you are debugging.',
        verboseLogging: 'Verbose network logging',
        verboseLoggingDescription: 'Log all socket requests and responses',
        consoleLogging: 'Console output',
        consoleLoggingDescription: 'Enable console logging in production builds',
    },

} as const;

export type Translations = typeof en;

/**
 * Generic translation type that matches the structure of Translations
 * but allows different string values (for other languages)
 */
export type TranslationStructure = {
    readonly [K in keyof Translations]: {
        readonly [P in keyof Translations[K]]: Translations[K][P] extends string
            ? string
            : Translations[K][P] extends (...args: any[]) => string
                ? Translations[K][P]
                : Translations[K][P] extends object
                    ? {
                        readonly [Q in keyof Translations[K][P]]: Translations[K][P][Q] extends string
                            ? string
                            : Translations[K][P][Q]
                      }
                    : Translations[K][P]
    }
};

/**
 * Deep-partial variant of TranslationStructure for minor languages.
 *
 * Minor-language files only carry REAL translations: any key they omit falls
 * back to English at runtime (see t() in index.ts). Only en (source of truth)
 * and zh-Hans (primary translation) are required to be complete.
 * Adding a new key therefore only touches _default.ts and zh-Hans.ts.
 */
type DeepPartialTranslations<T> = {
    readonly [K in keyof T]?: T[K] extends string
        ? string
        : T[K] extends (...args: any[]) => string
            ? T[K]
            : DeepPartialTranslations<T[K]>;
};
export type PartialTranslationStructure = DeepPartialTranslations<TranslationStructure>;
