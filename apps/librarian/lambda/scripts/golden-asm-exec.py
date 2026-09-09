#!/usr/bin/env python3
"""Run asm-exec with compatibility for the current AWS MCP tool contract.

The bundled resolver owns dynamic-reference parsing and child-process execution.
This adapter changes only its MCP retrieval operation when the endpoint exposes
``aws___run_script`` instead of the older ``aws___call_aws`` tool.  A resolved
value remains in this process and the child process; it is never logged.
"""

import json
import os
import runpy
import sys


def fail(message):
    print(f"golden-asm-exec: ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


source = os.environ.get("ASM_EXEC_SOURCE")
if not source:
    fail("ASM_EXEC_SOURCE is required")

resolver = runpy.run_path(source, run_name="golden_asm_exec_source")

# AWS MCP scripts may take longer than asm-exec's legacy ten-second transport
# timeout.  This applies only inside this short-lived local adapter process.
urlopen = resolver["urllib"].request.urlopen
resolver["urllib"].request.urlopen = lambda request, timeout=None: urlopen(request, timeout=60)


def available_tools(session_id):
    response, _ = resolver["_mcp_post"](
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}, session_id
    )
    return {tool.get("name") for tool in response.get("result", {}).get("tools", [])}


def resolve_via_current_mcp(secret_name, label, region):
    try:
        _, session_id = resolver["_mcp_post"](
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "clientInfo": {"name": "librarian-golden-asm-exec", "version": "1.0.0"},
                    "capabilities": {},
                },
            }
        )
        resolver["_mcp_post"]({"jsonrpc": "2.0", "method": "notifications/initialized"}, session_id)
        if "aws___run_script" not in available_tools(session_id):
            return None

        code = "\n".join(
            [
                "reply = await call_boto3(",
                '    service_name="secretsmanager",',
                '    operation_name="GetSecretValue",',
                f"    region_name={json.dumps(region)},",
                f"    params={{'SecretId': {json.dumps(secret_name)}, 'VersionStage': {json.dumps(label)}}},",
                ")",
                "result = reply['SecretString']",
                "result",
            ]
        )
        response, _ = resolver["_mcp_post"](
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "aws___run_script", "arguments": {"code": code}},
            },
            session_id,
        )
        value = response.get("result", {}).get("structuredContent", {}).get("return_value")
        return value if isinstance(value, str) else None
    except Exception:
        return None


resolver["main"].__globals__["_resolve_via_mcp"] = resolve_via_current_mcp
resolver["main"]()
