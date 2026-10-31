import { z } from 'zod';

// Shared message metadata schema
export const MessageMetaSchema = z.object({
    reportedModel: z.string().optional(), // Actual model reported by a linked child assistant, never a requested alias.
    sentFrom: z.string().optional(), // Source identifier
    permissionMode: z.string().optional(), // Permission mode key for this message
    model: z.string().nullable().optional(), // Model name for this message (null = reset)
    fallbackModel: z.string().nullable().optional(), // Fallback model for this message (null = reset)
    customSystemPrompt: z.string().nullable().optional(), // Custom system prompt for this message (null = reset)
    appendSystemPrompt: z.string().nullable().optional(), // Append to system prompt for this message (null = reset)
    allowedTools: z.array(z.string()).nullable().optional(), // Allowed tools for this message (null = reset)
    disallowedTools: z.array(z.string()).nullable().optional(), // Disallowed tools for this message (null = reset)
    effort: z.string().nullable().optional(), // Reasoning / thinking effort for this message (null = reset)
    modelIntent: z.string().optional(), // B-849b: picker choice behind `model` (the wrapper records it)
    effortIntent: z.string().optional(), // B-849b: picker choice behind `effort`
    delivery: z.enum(['queue', 'steer']).optional(), // Omitted/queue = next turn; steer = current live turn
    displayText: z.string().optional(), // Optional text to display in UI instead of actual message text
    // Web-only compatibility hint: this ordinary chat input was submitted
    // while the current agent turn was still running. Old CLIs strip this
    // unknown field; the Web clears the visual queue at the next turn-end.
    queuedAt: z.number().optional(),
    // B-619: the server stamps this on a message a shared-session driver wrote
    // (sentFrom === 'shared'). Display only — never a privilege.
    sharedBy: z.object({ accountId: z.string(), displayName: z.string() }).optional(),
});

export type MessageMeta = z.infer<typeof MessageMetaSchema>;
