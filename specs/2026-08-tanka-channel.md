# Generic IM adapter: spawn, send, and webhook loop

> Status: Shipped. The original implementation was proven with a private Tanka
> adapter; the public contract is IM-agnostic and lives in `docs/channels.md`.

## Problem

An agent task often arrives in chat, while execution belongs on a trusted user
machine. Operators need a narrow adapter contract that can start a visible Very
Happy session, return attention events to chat, and let an authorized reply
continue the same session without teaching the core about a specific IM.

## Goals

- An authorized chat command starts a session in an allowlisted workspace.
- The acknowledgement includes a Web session URL when configured.
- Completion and permission events can return through an account HTTPS webhook.
- An authorized quote-reply can continue the session through the CLI.
- Organization-specific identity, routing, and policy stay outside Very Happy.

## Non-goals

- Treating a message prefix or the `session:` trailer as authentication.
- Accepting arbitrary machine paths or commands from chat input.
- Binding the core product to Tanka or any other IM vendor.
- Making webhook delivery a durable queue.
- Routing chat through the in-product Claude coordinator. These are separate
  extension paths today.

## Public contract

### Start a session

The adapter runs on the daemon machine and invokes:

```sh
very-happy spawn --dir /allowlisted/project --prompt-file request.txt --json
```

The directory must already exist. Exit `0` means the session and first message
succeeded. Exit `2` means the session exists but the first message failed; the
adapter may still return the session URL and must not silently start another.

### Return attention events

The account webhook forwards best-effort completion and permission events. When
a session id exists, the message ends with a stable `session: <id>` line. A Web
origin is included only when the server operator configures one explicitly.

### Continue a session

After authorizing the reply, the adapter extracts the final `session:` trailer
from the quoted notification and invokes:

```sh
very-happy send --session <id> --prompt-file reply.txt --json
```

The trailer is only a routing key. The local CLI still needs the session key,
but the adapter must independently authenticate and authorize the chat input.

## Security invariants

1. Fail closed unless both sender and chat are allowlisted.
2. Map chats to fixed workspace roots; never accept a directory or executable
   from message text.
3. Deduplicate message ids, rate-limit senders, and keep a redacted audit log.
4. Preserve normal agent permission prompts unless the operator has explicitly
   accepted a stronger remote-execution threat model.
5. Run as a least-privileged local user. Never expose the daemon loopback
   control server on the network.
6. Treat the relay as trusted infrastructure and webhook delivery as a hint,
   not a queue.

## Compatibility and release order

`spawn` and `send` are additive CLI commands. The webhook trailer is appended
plain text and ignored by old receivers. Deploy server support before the CLI
when both change; Web has no protocol dependency on this adapter.

## Acceptance evidence

- Authorized message starts one session and returns its URL.
- Completion or permission produces a webhook notification.
- Authorized quote-reply reaches the original session.
- Unauthorized sender/chat, duplicate message, non-allowlisted directory, and
  malformed trailer do not trigger execution.
- Adapter failure is visible and does not cause an unbounded retry loop.
