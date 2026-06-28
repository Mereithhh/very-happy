import { Platform } from 'react-native';

/**
 * very-happy "Console" design tokens.
 *
 * One token set, two skins: `dark` is the brand default (matte black + one
 * phosphor-teal "live" accent), `light` is the daylight terminal (cool paper +
 * the same teal darkened for contrast). Spec + styleguide live in the skills
 * repo: happy/references/very-happy-design-tokens.md.
 *
 * Rules of the system, encoded below:
 *  - teal === "live" (focus / active / connected / agent working). Never decor.
 *  - in light mode teal is split: a slightly deeper fill, and `*Link`/text uses
 *    a darker teal so it passes contrast on white.
 *  - the terminal is a terminal — it stays dark in BOTH themes.
 */

// Shared spacing, sizing constants (DRY - used by both themes)
const sharedSpacing = {
    // Spacing scale (4px base)
    margins: {
        xs: 4,
        sm: 8,
        md: 12,
        lg: 16,
        xl: 20,
        xxl: 24,
    },

    // Border radii — Console runs a touch rounder than stock happy.
    borderRadius: {
        sm: 6,    // small controls, chips
        md: 10,   // buttons, items
        lg: 12,   // input fields
        xl: 14,   // cards, panels
        xxl: 18,  // main containers
    },

    // Icon sizes (based on actual usage patterns)
    iconSize: {
        small: 12,
        medium: 16,
        large: 20,
        xlarge: 24,
    },
} as const;

export const lightTheme = {
    dark: false,
    colors: {

        //
        // Main colors
        //

        text: '#101720',
        textDestructive: '#D9484D',
        textSecondary: '#52606E',
        textLink: '#07735F',          // accent-2 (readable teal on white)
        deleteAction: '#D9484D',
        warningCritical: '#D9484D',
        warning: '#A8770F',
        success: '#07735F',
        surface: '#FFFFFF',                       // bg-1 panel
        surfaceRipple: 'rgba(16,22,32,0.06)',
        surfacePressed: '#E6EAF0',                // bg-3
        surfaceSelected: '#E6EAF0',
        surfacePressedOverlay: Platform.select({ ios: '#E6EAF0', default: 'transparent' }),
        surfaceHigh: '#F5F7FA',                   // bg-2 raised
        surfaceHighest: '#E6EAF0',                // bg-3
        divider: '#D8DEE6',                       // line
        shadow: {
            color: Platform.select({ default: '#101720', web: 'rgba(16,22,32,0.18)' }),
            opacity: 0.12,
        },

        //
        // System components
        //

        groupped: {
            background: '#EDF0F4',                // bg-0 page
            chevron: '#69737F',                   // text-faint
            sectionTitle: '#69737F',
        },
        header: {
            background: '#FFFFFF',
            tint: '#101720',
        },
        switch: {
            track: {
                active: 'rgba(21,194,166,0.16)',  // accent-dim
                inactive: '#C2CAD5',              // line-2
            },
            thumb: {
                active: '#0A7D69',                // accent
                inactive: '#FFFFFF',
            },
        },
        fab: {
            background: '#0A7D69',                 // accent
            backgroundPressed: '#08664F',
            icon: '#FFFFFF',                      // accent-ink
        },
        radio: {
            active: '#07735F',
            inactive: '#C2CAD5',
            dot: '#07735F',
        },
        modal: {
            border: 'rgba(16,22,32,0.10)',
        },
        button: {
            primary: {
                background: '#0A7D69',            // accent fill
                tint: '#FFFFFF',                  // accent-ink
                disabled: '#C2CAD5',
            },
            secondary: {
                tint: '#52606E',
            },
        },
        input: {
            background: '#F5F7FA',                // bg-2
            text: '#101720',
            placeholder: '#69737F',
        },
        box: {
            warning: {
                background: 'rgba(168,119,15,0.10)',
                border: '#A8770F',
                text: '#A8770F',
            },
            error: {
                background: 'rgba(217,72,77,0.10)',
                border: '#D9484D',
                text: '#D9484D',
            },
        },

        //
        // App components
        //

        status: {
            connected: '#0A7D69',
            connecting: '#A8770F',
            disconnected: '#69737F',
            error: '#D9484D',
            default: '#69737F',
        },

        // Permission mode colors — collapsed onto accent / warn / danger.
        permission: {
            default: '#69737F',
            approve: '#07735F',
            acceptEdits: '#07735F',
            bypass: '#A8770F',
            plan: '#07735F',
            readOnly: '#52606E',
            safeYolo: '#A8770F',
            yolo: '#D9484D',
        },

        // Permission button colors
        permissionButton: {
            allow: {
                background: '#0A7D69',
                text: '#FFFFFF',
            },
            deny: {
                background: '#D9484D',
                text: '#FFFFFF',
            },
            allowAll: {
                background: 'rgba(21,194,166,0.14)',
                text: '#07735F',
            },
            inactive: {
                background: '#E6EAF0',
                border: '#C2CAD5',
                text: '#69737F',
            },
            selected: {
                background: '#F5F7FA',
                border: '#C2CAD5',
                text: '#101720',
            },
        },


        // Diff view (GitHub-light, with Console outline)
        diff: {
            outline: '#D8DEE6',
            success: '#07735F',
            error: '#D9484D',
            addedBg: '#E6FFED',
            addedBorder: '#34D058',
            addedText: '#24292E',
            removedBg: '#FFEEF0',
            removedBorder: '#D73A49',
            removedText: '#24292E',
            contextBg: '#F5F7FA',
            contextText: '#52606E',
            lineNumberBg: '#F5F7FA',
            lineNumberText: '#69737F',
            hunkHeaderBg: '#EDF0F4',
            hunkHeaderText: '#07735F',
            leadingSpaceDot: '#D8DEE6',
            inlineAddedBg: '#ACFFA6',
            inlineAddedText: '#0A3F0A',
            inlineRemovedBg: '#FFCECB',
            inlineRemovedText: '#5A0A05',
        },

        // Message View colors
        userMessageBackground: '#E6EAF0',         // bg-3 raised bubble
        userMessageText: '#101720',
        agentMessageText: '#101720',
        agentEventText: '#52606E',

        // Code/Syntax colors
        syntaxKeyword: '#1d4ed8',
        syntaxString: '#07735F',
        syntaxComment: '#69737F',
        syntaxNumber: '#0891b2',
        syntaxFunction: '#9333ea',
        syntaxBracket1: '#ff6b6b',
        syntaxBracket2: '#0EA88E',
        syntaxBracket3: '#45b7d1',
        syntaxBracket4: '#f7b731',
        syntaxBracket5: '#5f27cd',
        syntaxDefault: '#374151',

        // Git status colors
        gitBranchText: '#69737F',
        gitFileCountText: '#69737F',
        gitAddedText: '#07735F',
        gitRemovedText: '#D9484D',

        // Terminal/Command colors — the terminal stays dark in light mode too.
        terminal: {
            background: '#05070A',
            prompt: '#34E2C4',
            command: '#C7D0DC',
            stdout: '#C7D0DC',
            stderr: '#E6B450',
            error: '#FF6B6B',
            emptyOutput: '#727D8D',
        },

    },

    ...sharedSpacing,
};

export const darkTheme = {
    dark: true,
    colors: {

        //
        // Main colors
        //

        text: '#E8EDF4',
        textDestructive: '#FF6B6B',
        textSecondary: '#9AA4B2',
        textLink: '#34E2C4',          // accent (== accent-2 in dark)
        deleteAction: '#FF6B6B',
        warningCritical: '#FF6B6B',
        warning: '#E6B450',
        success: '#34E2C4',
        surface: '#11161E',                       // bg-1 panel
        surfaceRipple: 'rgba(232,237,244,0.06)',
        surfacePressed: '#27313F',                // bg-3
        surfaceSelected: '#1B2230',               // bg-2 (active row)
        surfacePressedOverlay: Platform.select({ ios: '#27313F', default: 'transparent' }),
        surfaceHigh: '#1B2230',                   // bg-2 raised
        surfaceHighest: '#27313F',                // bg-3
        divider: '#333D4D',                       // line
        shadow: {
            color: Platform.select({ default: '#000000', web: 'rgba(0,0,0,0.4)' }),
            opacity: 0.4,
        },

        //
        // System components
        //

        header: {
            background: '#11161E',
            tint: '#E8EDF4',
        },
        switch: {
            track: {
                active: '#15433B',                // accent-dim
                inactive: '#27313F',              // bg-3
            },
            thumb: {
                active: '#34E2C4',                // accent
                inactive: '#727D8D',              // text-faint
            },
        },
        groupped: {
            background: '#06080C',                // bg-0 page
            chevron: '#727D8D',                   // text-faint
            sectionTitle: '#727D8D',
        },
        fab: {
            background: '#34E2C4',                 // accent
            backgroundPressed: '#27C7AB',
            icon: '#04110E',                      // accent-ink
        },
        radio: {
            active: '#34E2C4',
            inactive: '#3E495B',
            dot: '#34E2C4',
        },
        modal: {
            border: 'rgba(122,162,214,0.13)',
        },
        button: {
            primary: {
                background: '#34E2C4',            // accent fill
                tint: '#04110E',                  // accent-ink
                disabled: '#3E495B',
            },
            secondary: {
                tint: '#9AA4B2',
            },
        },
        input: {
            background: '#1B2230',                // bg-2
            text: '#E8EDF4',
            placeholder: '#727D8D',
        },
        box: {
            warning: {
                background: 'rgba(230,180,80,0.14)',
                border: '#E6B450',
                text: '#E6B450',
            },
            error: {
                background: 'rgba(255,107,107,0.14)',
                border: '#FF6B6B',
                text: '#FF6B6B',
            },
        },

        //
        // App components
        //

        status: { // App Connection Status
            connected: '#34E2C4',
            connecting: '#E6B450',
            disconnected: '#727D8D',
            error: '#FF6B6B',
            default: '#727D8D',
        },

        // Permission mode colors — collapsed onto accent / warn / danger.
        permission: {
            default: '#727D8D',
            approve: '#34E2C4',
            acceptEdits: '#34E2C4',
            bypass: '#E6B450',
            plan: '#34E2C4',
            readOnly: '#9AA4B2',
            safeYolo: '#E6B450',
            yolo: '#FF6B6B',
        },

        // Permission button colors
        permissionButton: {
            allow: {
                background: '#34E2C4',
                text: '#04110E',
            },
            deny: {
                background: '#FF6B6B',
                text: '#04110E',
            },
            allowAll: {
                background: '#15433B',
                text: '#34E2C4',
            },
            inactive: {
                background: '#27313F',
                border: '#3E495B',
                text: '#727D8D',
            },
            selected: {
                background: '#1B2230',
                border: '#3E495B',
                text: '#E8EDF4',
            },
        },


        // Diff view (GitHub-dark, with Console surfaces)
        diff: {
            outline: '#333D4D',
            success: '#34E2C4',
            error: '#FF6B6B',
            addedBg: '#0D2E1F',
            addedBorder: '#1E7A5A',
            addedText: '#C9D1D9',
            removedBg: '#3F1B23',
            removedBorder: '#9E3B43',
            removedText: '#C9D1D9',
            contextBg: '#1B2230',
            contextText: '#9AA4B2',
            lineNumberBg: '#1B2230',
            lineNumberText: '#727D8D',
            hunkHeaderBg: '#1B2230',
            hunkHeaderText: '#34E2C4',
            leadingSpaceDot: '#333D4D',
            inlineAddedBg: '#1E5A3F',
            inlineAddedText: '#7AFFC4',
            inlineRemovedBg: '#5A2A2A',
            inlineRemovedText: '#FF9A9A',
        },

        // Message View colors
        userMessageBackground: '#27313F',         // bg-3 raised bubble
        userMessageText: '#E8EDF4',
        agentMessageText: '#E8EDF4',
        agentEventText: '#727D8D',

        // Code/Syntax colors (brighter for dark mode)
        syntaxKeyword: '#569CD6',
        syntaxString: '#CE9178',
        syntaxComment: '#6A9955',
        syntaxNumber: '#B5CEA8',
        syntaxFunction: '#DCDCAA',
        syntaxBracket1: '#FFD700',
        syntaxBracket2: '#34E2C4',
        syntaxBracket3: '#179FFF',
        syntaxBracket4: '#FF8C00',
        syntaxBracket5: '#C586C0',
        syntaxDefault: '#D4D4D4',

        // Git status colors
        gitBranchText: '#727D8D',
        gitFileCountText: '#727D8D',
        gitAddedText: '#34E2C4',
        gitRemovedText: '#FF6B6B',

        // Terminal/Command colors
        terminal: {
            background: '#05070A',
            prompt: '#34E2C4',
            command: '#C7D0DC',
            stdout: '#C7D0DC',
            stderr: '#E6B450',
            error: '#FF6B6B',
            emptyOutput: '#727D8D',
        },

    },

    ...sharedSpacing,
} satisfies typeof lightTheme;

export type Theme = typeof lightTheme;
