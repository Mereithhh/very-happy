import * as React from "react";
import { View, Text, Pressable, Platform } from "react-native";
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { MarkdownView } from "./markdown/MarkdownView";
import { t } from '@/text';
import { Message, UserTextMessage, AgentTextMessage, ToolCallMessage } from "@/sync/typesMessage";
import { Metadata } from "@/sync/storageTypes";
import { ToolView } from "./tools/ToolView";
import { AgentEvent } from "@/sync/typesRaw";
import { sync } from '@/sync/sync';
import { Option } from './markdown/MarkdownView';
import { layout } from "./layout";
import { parseLocalCommandMessage, isUserSlashCommandEcho } from './parseLocalCommandMessage';
import { MessageMetaRow, MessageMetaUsage } from './MessageMetaRow';


export const MessageView = React.memo((props: {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
  /**
   * Approximate thinking duration in ms for thinking blocks, derived by
   * ChatList from message timestamps (thinking createdAt → next output
   * createdAt). Undefined when it can't be computed reliably.
   */
  thinkingDurationMs?: number;
  /**
   * When true, this agent-text message is the latest assistant answer in the
   * session, so we render the metadata row (model + token usage) beneath it.
   */
  showMetaRow?: boolean;
  /** Session-level latest usage snapshot, for the metadata row. */
  latestUsage?: MessageMetaUsage | null;
  /**
   * Long-press handler for user-text bubbles. Wired by ChatList from
   * the active session screen and used by the fork-from-message flow.
   */
  onForkFromUserMessage?: (messageId: string, rewindPointId: string | undefined, messageText: string) => void;
}) => {
  return (
    <View
      style={styles.messageContainer}
      renderToHardwareTextureAndroid={Platform.OS !== 'web'}
    >
      <View style={styles.messageContent}>
        <RenderBlock
          message={props.message}
          metadata={props.metadata}
          sessionId={props.sessionId}
          getMessageById={props.getMessageById}
          thinkingDurationMs={props.thinkingDurationMs}
          showMetaRow={props.showMetaRow}
          latestUsage={props.latestUsage}
          onForkFromUserMessage={props.onForkFromUserMessage}
        />
      </View>
    </View>
  );
});

// RenderBlock function that dispatches to the correct component based on message kind
function RenderBlock(props: {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
  thinkingDurationMs?: number;
  showMetaRow?: boolean;
  latestUsage?: MessageMetaUsage | null;
  onForkFromUserMessage?: (messageId: string, rewindPointId: string | undefined, messageText: string) => void;
}): React.ReactElement {
  switch (props.message.kind) {
    case 'user-text':
      return (
        <UserTextBlock
          message={props.message}
          metadata={props.metadata}
          sessionId={props.sessionId}
          onForkFromUserMessage={props.onForkFromUserMessage}
        />
      );

    case 'agent-text':
      return (
        <AgentTextBlock
          message={props.message}
          metadata={props.metadata}
          sessionId={props.sessionId}
          thinkingDurationMs={props.thinkingDurationMs}
          showMetaRow={props.showMetaRow}
          latestUsage={props.latestUsage}
        />
      );

    case 'tool-call':
      return <ToolCallBlock
        message={props.message}
        metadata={props.metadata}
        sessionId={props.sessionId}
        getMessageById={props.getMessageById}
      />;

    case 'agent-event':
      return <AgentEventBlock event={props.message.event} metadata={props.metadata} />;


    default:
      // Exhaustive check - TypeScript will error if we miss a case
      const _exhaustive: never = props.message;
      throw new Error(`Unknown message kind: ${_exhaustive}`);
  }
}

function UserTextBlock(props: {
  message: UserTextMessage;
  metadata: Metadata | null;
  sessionId: string;
  onForkFromUserMessage?: (messageId: string, rewindPointId: string | undefined, messageText: string) => void;
}) {
  const handleOptionPress = React.useCallback((option: Option) => {
    sync.sendMessage(props.sessionId, option.title, { source: 'option' });
  }, [props.sessionId]);

  const rewindPointId = props.message.claudeUuid ?? props.message.codexItemId;
  const canFork = Boolean(props.onForkFromUserMessage)
    && (Boolean(rewindPointId) || props.metadata?.flavor === 'codex');
  const handleLongPress = React.useCallback(() => {
    if (props.onForkFromUserMessage) {
      props.onForkFromUserMessage(props.message.id, rewindPointId, props.message.text);
    }
  }, [props.message.id, props.message.text, props.onForkFromUserMessage, rewindPointId]);

  // Claude Agent SDK emits synthetic user messages wrapped in tags like
  // <local-command-caveat>…</local-command-caveat> and
  // <command-message>…</command-message><command-name>/foo</command-name>
  // whenever a slash command runs. The plain MarkdownView renders these as
  // literal text, which looks broken. Collapse them into chips or hide
  // them entirely depending on what kind of wrapper this is.
  // The user's own slash-command input is shown optimistically (carries a
  // localId); the SDK then injects the canonical wrapper chip. Hide the raw
  // echo so we don't render the command twice. Gated to Claude flavor only:
  // Codex/Gemini don't reliably emit the <command-*> wrapper, so hiding the
  // echo there would drop the command with nothing to replace it. (Absent
  // flavor == Claude, matching the convention used elsewhere.)
  const isClaudeFlavor = !props.metadata?.flavor || props.metadata.flavor === 'claude';
  if (isClaudeFlavor && isUserSlashCommandEcho(props.message.text, props.message.localId != null)) {
    return null;
  }

  const parsed = parseLocalCommandMessage(props.message.displayText || props.message.text);
  if (parsed.kind === 'caveat') {
    return null;
  }
  if (parsed.kind === 'command-run') {
    return (
      <View style={styles.userMessageContainer}>
        <View style={styles.commandChip}>
          <Text style={styles.commandChipText}>/{parsed.commandName}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.userMessageContainer}>
      <Pressable
        onLongPress={canFork ? handleLongPress : undefined}
        delayLongPress={400}
        style={styles.userMessageBubble}
      >
        <MarkdownView markdown={parsed.text} onOptionPress={handleOptionPress} sessionId={props.sessionId} />
      </Pressable>
    </View>
  );
}

function AgentTextBlock(props: {
  message: AgentTextMessage;
  metadata: Metadata | null;
  sessionId: string;
  thinkingDurationMs?: number;
  showMetaRow?: boolean;
  latestUsage?: MessageMetaUsage | null;
}) {
  const handleOptionPress = React.useCallback((option: Option) => {
    sync.sendMessage(props.sessionId, option.title, { source: 'option' });
  }, [props.sessionId]);

  // Thinking blocks render as a collapsed, subdued "Thinking" card.
  if (props.message.isThinking) {
    return (
      <ThinkingBlock
        text={props.message.text}
        durationMs={props.thinkingDurationMs}
        sessionId={props.sessionId}
      />
    );
  }

  // Per-turn metadata stamped from the SDK result message. When present this
  // message is the final answer of a completed turn — show its own accurate
  // usage / cost / duration / turns. Otherwise fall back to the session-level
  // latest-usage snapshot, but only on the latest answer (showMetaRow), which
  // covers the in-flight turn that has no result yet.
  const m = props.message;
  const hasOwnMeta =
    m.usage !== undefined ||
    typeof m.costUsd === 'number' ||
    typeof m.totalDurationMs === 'number' ||
    typeof m.numTurns === 'number';
  const renderMeta = hasOwnMeta || props.showMetaRow;

  return (
    <View style={styles.agentMessageContainer}>
      <MarkdownView markdown={props.message.text} onOptionPress={handleOptionPress} sessionId={props.sessionId} />
      {renderMeta ? (
        <MessageMetaRow
          model={m.meta?.model ?? undefined}
          usage={m.usage ?? (props.showMetaRow ? props.latestUsage : undefined)}
          costUsd={m.costUsd}
          totalDurationMs={m.totalDurationMs}
          numTurns={m.numTurns}
        />
      ) : null}
    </View>
  );
}

function ThinkingBlock(props: {
  text: string;
  durationMs?: number;
  sessionId: string;
}) {
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = React.useState(false);

  // Strip the reducer's `*...*` italic wrapper; if there's no real thinking
  // text (common in remote/SDK mode where thinking content isn't emitted),
  // render nothing instead of an empty expandable card.
  const content = React.useMemo(() => {
    let t = (props.text ?? '').trim();
    if (t.startsWith('*') && t.endsWith('*')) t = t.slice(1, -1).trim();
    return t;
  }, [props.text]);

  // Duration label: only shown when we could derive a positive duration.
  const durationLabel = React.useMemo(() => {
    if (typeof props.durationMs !== 'number' || props.durationMs <= 0) return null;
    const seconds = Math.round(props.durationMs / 1000);
    if (seconds < 1) return null;
    if (seconds < 60) return `Thought for ${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const rem = seconds % 60;
    return `Thought for ${minutes}m${rem.toString().padStart(2, '0')}s`;
  }, [props.durationMs]);

  if (!content) return null;

  return (
    <Animated.View style={styles.thinkingContainer} layout={LinearTransition.duration(200)}>
      <Pressable
        style={styles.thinkingHeader}
        onPress={() => setExpanded((e) => !e)}
        hitSlop={6}
      >
        <Text style={styles.thinkingEmoji}>💭</Text>
        <Text style={styles.thinkingTitle} numberOfLines={1}>
          {durationLabel ?? 'Thinking'}
        </Text>
        <Ionicons
          name={expanded ? 'chevron-down' : 'chevron-forward'}
          size={14}
          color={theme.colors.textSecondary}
        />
      </Pressable>
      {expanded ? (
        <Animated.View
          entering={FadeIn.duration(160)}
          exiting={FadeOut.duration(120)}
          style={styles.thinkingContent}
        >
          <MarkdownView markdown={content} sessionId={props.sessionId} />
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

function AgentEventBlock(props: {
  event: AgentEvent;
  metadata: Metadata | null;
}) {
  if (props.event.type === 'switch') {
    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>{t('message.switchedToMode', { mode: props.event.mode })}</Text>
      </View>
    );
  }
  if (props.event.type === 'message') {
    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>{props.event.message}</Text>
      </View>
    );
  }
  if (props.event.type === 'limit-reached') {
    const formatTime = (timestamp: number): string => {
      try {
        const date = new Date(timestamp * 1000); // Convert from Unix timestamp
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } catch {
        return t('message.unknownTime');
      }
    };

    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>
          {t('message.usageLimitUntil', { time: formatTime(props.event.endsAt) })}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.agentEventContainer}>
      <Text style={styles.agentEventText}>{t('message.unknownEvent')}</Text>
    </View>
  );
}

function ToolCallBlock(props: {
  message: ToolCallMessage;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
}) {
  if (!props.message.tool) {
    return null;
  }
  return (
    <View style={styles.toolContainer}>
      <ToolView
        tool={props.message.tool}
        metadata={props.metadata}
        messages={props.message.children}
        sessionId={props.sessionId}
        messageId={props.message.id}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  messageContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
  },
  messageContent: {
    flexDirection: 'column',
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
    maxWidth: layout.maxWidth,
    overflow: 'hidden',
  },
  userMessageContainer: {
    maxWidth: '100%',
    flexDirection: 'column',
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
  },
  userMessageBubble: {
    backgroundColor: theme.colors.userMessageBackground,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    marginBottom: 12,
    maxWidth: '100%',
  },
  commandChip: {
    backgroundColor: theme.colors.userMessageBackground,
    paddingHorizontal: 10,
    paddingVertical: 2,
    borderRadius: 10,
    marginBottom: 12,
    maxWidth: '100%',
    opacity: 0.65,
  },
  commandChipText: {
    color: theme.colors.input.text,
    fontSize: 13,
    fontFamily: 'monospace',
  },
  agentMessageContainer: {
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 16,
    maxWidth: '100%',
  },
  thinkingContainer: {
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 10,
    backgroundColor: theme.colors.surfaceHigh,
    overflow: 'hidden',
    maxWidth: '100%',
  },
  thinkingHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  thinkingEmoji: {
    fontSize: 13,
    opacity: 0.7,
  },
  thinkingTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: 13,
    fontWeight: '500',
    color: theme.colors.textSecondary,
  },
  thinkingContent: {
    paddingHorizontal: 10,
    paddingBottom: 6,
    opacity: 0.8,
  },
  agentEventContainer: {
    marginHorizontal: 8,
    alignItems: 'center',
    paddingVertical: 8,
  },
  agentEventText: {
    color: theme.colors.agentEventText,
    fontSize: 14,
  },
  toolContainer: {
    marginHorizontal: 8,
    maxWidth: '100%',
    overflow: 'hidden',
  },
  debugText: {
    color: theme.colors.agentEventText,
    fontSize: 12,
  },
}));
