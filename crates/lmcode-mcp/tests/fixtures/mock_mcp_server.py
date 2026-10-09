"""Minimal MCP stdio server used by the Rust end-to-end tests.

Speaks newline-delimited JSON-RPC 2.0: initialize / tools/list / tools/call.
"""

import json
import sys

TOOLS = [
    {
        "name": "echo",
        "description": "Echo the text argument back",
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    },
    {
        "name": "fail",
        "description": "Always returns an error result",
        "inputSchema": {"type": "object"},
    },
]


def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    message = json.loads(line)
    method = message.get("method")
    message_id = message.get("id")

    if method == "initialize":
        send(
            {
                "jsonrpc": "2.0",
                "id": message_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "mock-mcp", "version": "0.1.0"},
                },
            }
        )
    elif method == "notifications/initialized":
        pass  # notification: no response
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": message_id, "result": {"tools": TOOLS}})
    elif method == "tools/call":
        params = message.get("params") or {}
        name = params.get("name")
        arguments = params.get("arguments") or {}
        if name == "echo":
            send(
                {
                    "jsonrpc": "2.0",
                    "id": message_id,
                    "result": {
                        "content": [
                            {
                                "type": "text",
                                "text": "echo: " + str(arguments.get("text", "")),
                            }
                        ],
                        "isError": False,
                    },
                }
            )
        elif name == "fail":
            send(
                {
                    "jsonrpc": "2.0",
                    "id": message_id,
                    "result": {
                        "content": [{"type": "text", "text": "intentional failure"}],
                        "isError": True,
                    },
                }
            )
        else:
            send(
                {
                    "jsonrpc": "2.0",
                    "id": message_id,
                    "error": {"code": -32601, "message": "unknown tool"},
                }
            )
    elif message_id is not None:
        send(
            {
                "jsonrpc": "2.0",
                "id": message_id,
                "error": {"code": -32601, "message": "unknown method"},
            }
        )
