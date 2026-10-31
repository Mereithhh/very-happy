import * as z from 'zod';

export const MessageMetaSchema = z.object({
  sentFrom: z.string().optional(),
  permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'read-only', 'safe-yolo', 'yolo']).optional(),
  model: z.string().nullable().optional(),
  fallbackModel: z.string().nullable().optional(),
  customSystemPrompt: z.string().nullable().optional(),
  appendSystemPrompt: z.string().nullable().optional(),
  allowedTools: z.array(z.string()).nullable().optional(),
  disallowedTools: z.array(z.string()).nullable().optional(),
  /** B-849b: the picker choice behind `model` ('latest' | 'default' | model id); the wrapper records it. */
  modelIntent: z.string().optional(),
  /** B-849b: the picker choice behind `effort` ('default' = auto | level). */
  effortIntent: z.string().optional(),
  /** Omitted/queue waits for the current turn; steer targets the live turn. */
  delivery: z.enum(['queue', 'steer']).optional(),
  displayText: z.string().optional(),
  /** B-619: set by the server on a message a shared-session driver wrote; never trusted for privilege. */
  sharedBy: z.object({ accountId: z.string(), displayName: z.string() }).optional(),
});
export type MessageMeta = z.infer<typeof MessageMetaSchema>;
