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
        textLink: '#0A8772',          // accent-2 (readable teal on white)
        deleteAction: '#D9484D',
        warningCritical: '#D9484D',
        warning: '#A8770F',
        success: '#0A8772',
        surface: '#FFFFFF',                       // bg-1 panel
        surfaceRipple: 'rgba(16,22,32,0.06)',
        surfacePressed: '#E8ECF2',                // bg-3
        surfaceSelected: '#E8ECF2',
        surfacePressedOverlay: Platform.select({ ios: '#E8ECF2', default: 'transparent' }),
        surfaceHigh: '#F5F7FA',                   // bg-2 raised
        surfaceHighest: '#E8ECF2',                // bg-3
        divider: '#E4E8EE',                       // line
        shadow: {
            color: Platform.select({ default: '#101720', web: 'rgba(16,22,32,0.18)' }),
            opacity: 0.12,
        },

        //
        // System components
        //

        groupped: {
            background: '#EDF0F4',                // bg-0 page
            chevron: '#8A93A0',                   // text-faint
            sectionTitle: '#8A93A0',
        },
        header: {
            background: '#FFFFFF',
            tint: '#101720',
        },
        switch: {
            track: {
                active: 'rgba(21,194,166,0.16)',  // accent-dim
                inactive: '#CFD6DF',              // line-2
            },
            thumb: {
                active: '#15C2A6',                // accent
                inactive: '#FFFFFF',
            },
        },
        fab: {
            background: '#15C2A6',                 // accent
            backgroundPressed: '#0E9F88',
            icon: '#04130F',                      // accent-ink
        },
        radio: {
            active: '#0A8772',
            inactive: '#CFD6DF',
            dot: '#0A8772',
        },
        modal: {
            border: 'rgba(16,22,32,0.10)',
        },
        button: {
            primary: {
                background: '#15C2A6',            // accent fill
                tint: '#04130F',                  // accent-ink
                disabled: '#CFD6DF',
            },
            secondary: {
                tint: '#52606E',
            },
        },
        input: {
            background: '#F5F7FA',                // bg-2
            text: '#101720',
            placeholder: '#8A93A0',
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
            connected: '#15C2A6',
            connecting: '#A8770F',
            disconnected: '#8A93A0',
            error: '#D9484D',
            default: '#8A93A0',
        },

        // Permission mode colors — collapsed onto accent / warn / danger.
        permission: {
            default: '#8A93A0',
            approve: '#0A8772',
            acceptEdits: '#0A8772',
            bypass: '#A8770F',
            plan: '#0A8772',
            readOnly: '#52606E',
            safeYolo: '#A8770F',
            yolo: '#D9484D',
        },

        // Permission button colors
        permissionButton: {
            allow: {
                background: '#15C2A6',
                text: '#04130F',
            },
            deny: {
                background: '#D9484D',
                text: '#FFFFFF',
            },
            allowAll: {
                background: 'rgba(21,194,166,0.14)',
                text: '#0A8772',
            },
            inactive: {
                background: '#E8ECF2',
                border: '#CFD6DF',
                text: '#8A93A0',
            },
            selected: {
                background: '#F5F7FA',
                border: '#CFD6DF',
                text: '#101720',
            },
        },


        // Diff view (GitHub-light, with Console outline)
        diff: {
            outline: '#E4E8EE',
            success: '#0A8772',
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
            lineNumberText: '#8A93A0',
            hunkHeaderBg: '#EDF0F4',
            hunkHeaderText: '#0A8772',
            leadingSpaceDot: '#E4E8EE',
            inlineAddedBg: '#ACFFA6',
            inlineAddedText: '#0A3F0A',
            inlineRemovedBg: '#FFCECB',
            inlineRemovedText: '#5A0A05',
        },

        // Message View colors
        userMessageBackground: '#E8ECF2',         // bg-3 raised bubble
        userMessageText: '#101720',
        agentMessageText: '#101720',
        agentEventText: '#52606E',

        // Code/Syntax colors
        syntaxKeyword: '#1d4ed8',
        syntaxString: '#0A8772',
        syntaxComment: '#8A93A0',
        syntaxNumber: '#0891b2',
        syntaxFunction: '#9333ea',
        syntaxBracket1: '#ff6b6b',
        syntaxBracket2: '#0EA88E',
        syntaxBracket3: '#45b7d1',
        syntaxBracket4: '#f7b731',
        syntaxBracket5: '#5f27cd',
        syntaxDefault: '#374151',

        // Git status colors
        gitBranchText: '#8A93A0',
        gitFileCountText: '#8A93A0',
        gitAddedText: '#0A8772',
        gitRemovedText: '#D9484D',

        // Terminal/Command colors — the terminal stays dark in light mode too.
        terminal: {
            background: '#05070A',
            prompt: '#34E2C4',
            command: '#C7D0DC',
            stdout: '#C7D0DC',
            stderr: '#E6B450',
            error: '#FF6B6B',
            emptyOutput: '#5B6675',
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
        surface: '#0B0E13',                       // bg-1 panel
        surfaceRipple: 'rgba(232,237,244,0.06)',
        surfacePressed: '#171C25',                // bg-3
        surfaceSelected: '#11151C',               // bg-2 (active row)
        surfacePressedOverlay: Platform.select({ ios: '#171C25', default: 'transparent' }),
        surfaceHigh: '#11151C',                   // bg-2 raised
        surfaceHighest: '#171C25',                // bg-3
        divider: '#1E2530',                       // line
        shadow: {
            color: Platform.select({ default: '#000000', web: 'rgba(0,0,0,0.4)' }),
            opacity: 0.4,
        },

        //
        // System components
        //

        header: {
            background: '#0B0E13',
            tint: '#E8EDF4',
        },
        switch: {
            track: {
                active: '#15433B',                // accent-dim
                inactive: '#171C25',              // bg-3
            },
            thumb: {
                active: '#34E2C4',                // accent
                inactive: '#5B6675',              // text-faint
            },
        },
        groupped: {
            background: '#07090D',                // bg-0 page
            chevron: '#5B6675',                   // text-faint
            sectionTitle: '#5B6675',
        },
        fab: {
            background: '#34E2C4',                 // accent
            backgroundPressed: '#27C7AB',
            icon: '#04110E',                      // accent-ink
        },
        radio: {
            active: '#34E2C4',
            inactive: '#2A3340',
            dot: '#34E2C4',
        },
        modal: {
            border: 'rgba(122,162,214,0.13)',
        },
        button: {
            primary: {
                background: '#34E2C4',            // accent fill
                tint: '#04110E',                  // accent-ink
                disabled: '#2A3340',
            },
            secondary: {
                tint: '#9AA4B2',
            },
        },
        input: {
            background: '#11151C',                // bg-2
            text: '#E8EDF4',
            placeholder: '#5B6675',
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
            disconnected: '#5B6675',
            error: '#FF6B6B',
            default: '#5B6675',
        },

        // Permission mode colors — collapsed onto accent / warn / danger.
        permission: {
            default: '#5B6675',
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
                background: '#171C25',
                border: '#2A3340',
                text: '#5B6675',
            },
            selected: {
                background: '#11151C',
                border: '#2A3340',
                text: '#E8EDF4',
            },
        },


        // Diff view (GitHub-dark, with Console surfaces)
        diff: {
            outline: '#1E2530',
            success: '#34E2C4',
            error: '#FF6B6B',
            addedBg: '#0D2E1F',
            addedBorder: '#1E7A5A',
            addedText: '#C9D1D9',
            removedBg: '#3F1B23',
            removedBorder: '#9E3B43',
            removedText: '#C9D1D9',
            contextBg: '#11151C',
            contextText: '#9AA4B2',
            lineNumberBg: '#11151C',
            lineNumberText: '#5B6675',
            hunkHeaderBg: '#11151C',
            hunkHeaderText: '#34E2C4',
            leadingSpaceDot: '#1E2530',
            inlineAddedBg: '#1E5A3F',
            inlineAddedText: '#7AFFC4',
            inlineRemovedBg: '#5A2A2A',
            inlineRemovedText: '#FF9A9A',
        },

        // Message View colors
        userMessageBackground: '#171C25',         // bg-3 raised bubble
        userMessageText: '#E8EDF4',
        agentMessageText: '#E8EDF4',
        agentEventText: '#5B6675',

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
        gitBranchText: '#5B6675',
        gitFileCountText: '#5B6675',
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
            emptyOutput: '#5B6675',
        },

    },

    ...sharedSpacing,
} satisfies typeof lightTheme;

export type Theme = typeof lightTheme;
