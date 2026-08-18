# Notionish Local MCP Bridge

## Purpose

Expose the currently open Notionish browser workspace to an AI through MCP without changing the product's local-first storage model. The browser remains the only process that reads or writes `localStorage`; the Node service only relays authenticated MCP requests.

## Architecture

```text
MCP client -- POST /mcp + Bearer token --> node server.js
                                              |
                                              | queued request
                                              v
Browser page <-- GET /api/bridge/poll --------+
Browser page -- POST /api/bridge/result ------> node server.js --> MCP response
```

`server.js` listens only on `127.0.0.1`. It generates a random bearer token each time it starts. The page requests that token only from the same local origin, then polls for queued MCP tool calls. The bridge never reads browser storage directly.

## Data Ownership

- Browser `localStorage` remains the source of truth.
- Browser `Store` APIs perform all mutations and save immediately after successful MCP writes.
- The Node process has no generic filesystem, workspace file, code execution, or internet MCP tools.
- A browser page must remain open for a tool call to complete. Calls time out after 30 seconds if it disconnects.

## MCP Transport

- Endpoint: `POST /mcp`
- Protocol: JSON-RPC 2.0, MCP protocol version `2025-03-26`
- Supported methods: `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`
- Authorization: `Authorization: Bearer <token printed by node server.js>` is mandatory for `tools/call`.

The server returns tool results as MCP `content` text containing JSON and as `structuredContent`.

## Tool Coverage

| Resource | Read tools | Write tools |
| --- | --- | --- |
| Workspace | `workspace.get` | `workspace.update_theme` |
| Pages and code files | `page.list`, `page.get` | `page.create`, `page.update`, `page.move`, `page.delete` |
| Blocks and comments | `block.list`, `block_comment.list` | `block.create`, `block.update`, `block.move`, `block.delete`, `block_comment.create`, `block_comment.delete` |
| Database records and schema | `database_schema.get`; records are available through `page.get` | `database_schema.update`, `database_row.create`, `database_row.update`, `database_row.delete` |
| Questions | `question.list`, `question.get` | `question.create`, `question.update`, `question.delete` |
| Flashcards | `flashcard.list`, `flashcard.get` | `flashcard.create`, `flashcard.update`, `flashcard.delete` |
| Templates | `template.list` | `template.create`, `template.delete` |
| Reminders | `reminder.list` | `reminder.create`, `reminder.complete`, `reminder.delete` |

Question blocks and flashcard blocks continue to reference independent local entities. Deleting a block does not remove its question or flashcard entity.

## Security Controls

- The Node listener is bound to loopback only.
- MCP write calls require a startup-scoped random bearer token.
- Browser bridge requests require the same token.
- Browser code implements an allow-list switch for all tools and rejects unrecognized operations.
- Existing origin checks remain enabled for non-MCP service endpoints. MCP and bridge routes depend on bearer-token authorization because MCP clients can run under a different local origin.
- Tool calls return explicit validation errors for unknown tools, malformed arguments, absent resources, bridge timeouts, and invalid tokens.

## Operational Notes

1. Start the local service: `node server.js`.
2. Open the printed local URL in a browser and wait for the top-bar `AI 已连接` state.
3. Configure the MCP client with the printed `/mcp` endpoint and bearer token.
4. Keep that page open while the AI works.

The token changes whenever the local server restarts, so update the MCP client configuration after each restart.
