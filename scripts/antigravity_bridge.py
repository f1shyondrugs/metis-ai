#!/usr/bin/env python3
"""JSONL bridge for the official Google Antigravity Python SDK.

Credentials come from the parent process (GEMINI_API_KEY / Vertex env).
Metis MCP servers are attached through the public SDK mcp_servers API so
the agent has the same tool surface as the agy CLI OAuth path.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from typing import Any


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":"), default=str) + "\n")
    sys.stdout.flush()


def _tool_name(value: Any) -> str:
    if value is None:
        return "Antigravity tool"
    return str(getattr(value, "value", value))


def _mcp_servers(raw: Any) -> list[Any]:
    from google.antigravity.types import McpStdioServer, McpStreamableHttpServer

    servers: list[Any] = []
    if not isinstance(raw, list):
        return servers
    for item in raw:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        kind = str(item.get("type") or "").strip().lower()
        if not name:
            continue
        if kind == "http":
            url = str(item.get("url") or "").strip()
            if not url:
                continue
            headers = item.get("headers") if isinstance(item.get("headers"), dict) else None
            servers.append(
                McpStreamableHttpServer(
                    name=name,
                    url=url,
                    headers={str(k): str(v) for k, v in (headers or {}).items()},
                )
            )
            continue
        command = str(item.get("command") or "").strip()
        if not command:
            continue
        args = item.get("args") if isinstance(item.get("args"), list) else []
        env = item.get("env") if isinstance(item.get("env"), dict) else None
        servers.append(
            McpStdioServer(
                name=name,
                command=command,
                args=[str(arg) for arg in args],
                env={str(k): str(v) for k, v in (env or {}).items()} or None,
            )
        )
    return servers


async def _stream_response(response: Any) -> None:
    # Consume the rich stream exactly once so ToolCall and ToolResult events
    # stay ordered and the Metis timeline can close running tool rows.
    from google.antigravity.types import Text, Thought, ToolCall, ToolResult

    async for chunk in response.chunks:
        if isinstance(chunk, Text):
            if chunk.text:
                emit({"type": "text", "text": str(chunk.text)})
            continue
        if isinstance(chunk, Thought):
            if chunk.text:
                emit({"type": "thinking", "text": str(chunk.text)})
            continue
        if isinstance(chunk, ToolCall):
            emit({
                "type": "tool",
                "id": chunk.id,
                "name": _tool_name(chunk.name),
                "input": chunk.args or {},
                "status": "running",
                "server": chunk.server_name,
            })
            continue
        if isinstance(chunk, ToolResult):
            emit({
                "type": "tool",
                "id": chunk.id,
                "name": _tool_name(chunk.name),
                "result": chunk.result,
                "error": chunk.error,
                "status": "error" if chunk.error else "completed",
                "server": chunk.server_name,
            })

async def run(payload: dict[str, Any]) -> None:
    try:
        from google.antigravity import Agent, LocalAgentConfig
        from google.antigravity.types import CapabilitiesConfig, SessionContinuationMode
    except Exception as exc:  # pragma: no cover - optional runtime
        emit(
            {
                "type": "error",
                "message": (
                    "Google Antigravity SDK is not installed. "
                    "Install it with: pip install google-antigravity"
                ),
                "detail": str(exc),
            }
        )
        raise

    prompt = str(payload.get("prompt") or "").strip() or "Continue the current task."
    model = str(payload.get("model") or "").strip()
    cwd = str(payload.get("cwd") or "").strip()
    if cwd:
        os.chdir(cwd)

    kwargs: dict[str, Any] = {
        "capabilities": CapabilitiesConfig(
            enabled_tools=[],
            enable_subagents=True,
            max_subagent_depth=2,
        ),
        "mcp_servers": _mcp_servers(payload.get("mcp_servers")),
    }
    if cwd:
        kwargs["workspaces"] = [cwd]
    if model:
        kwargs["model"] = model

    conversation_id = str(payload.get("conversation_id") or "").strip()
    session_dir = str(payload.get("session_dir") or "").strip()
    if conversation_id:
        kwargs["conversation_id"] = conversation_id
        kwargs["session_continuation_mode"] = SessionContinuationMode.CREATE_OR_RESUME
    else:
        kwargs["session_continuation_mode"] = SessionContinuationMode.CREATE_ONLY
    if session_dir:
        os.makedirs(session_dir, mode=0o700, exist_ok=True)
        save_dir = os.path.join(session_dir, "sessions")
        app_data_dir = os.path.join(session_dir, "app-data")
        os.makedirs(save_dir, mode=0o700, exist_ok=True)
        os.makedirs(app_data_dir, mode=0o700, exist_ok=True)
        kwargs["save_dir"] = save_dir
        kwargs["app_data_dir"] = app_data_dir

    api_key = (
        str(payload.get("api_key") or "").strip()
        or os.environ.get("GEMINI_API_KEY", "").strip()
        or os.environ.get("GOOGLE_API_KEY", "").strip()
        or os.environ.get("GOOGLE_API_KEY", "").strip()
    )
    use_vertex = str(
        payload.get("vertex")
        or os.environ.get("GOOGLE_GENAI_USE_VERTEXAI", "")
        or os.environ.get("GOOGLE_GENAI_USE_VERTEXAI", "")
    ).strip().lower() in {"1", "true", "yes", "on"}
    if use_vertex:
        kwargs["vertex"] = True
        project = str(
            payload.get("project")
            or os.environ.get("GOOGLE_CLOUD_PROJECT")
            or os.environ.get("GOOGLE_CLOUD_PROJECT")
            or ""
        ).strip()
        location = str(
            payload.get("location")
            or os.environ.get("GOOGLE_CLOUD_LOCATION")
            or os.environ.get("GOOGLE_CLOUD_LOCATION")
            or ""
        ).strip()
        if project:
            kwargs["project"] = project
        if location:
            kwargs["location"] = location
    elif api_key:
        kwargs["api_key"] = api_key

    config = LocalAgentConfig(**kwargs)
    async with Agent(config) as agent:
        response = await agent.chat(prompt)
        await _stream_response(response)
        usage = response.usage_metadata
        if usage is not None:
            emit({
                "type": "usage",
                "input_tokens": usage.prompt_token_count,
                "cached_tokens": usage.cached_content_token_count,
                "output_tokens": usage.candidates_token_count,
                "thinking_tokens": usage.thoughts_token_count,
                "total_tokens": usage.total_token_count,
            })
        emit({"type": "session", "conversation_id": agent.conversation_id})
    emit({"type": "done"})


async def main() -> int:
    line = sys.stdin.readline()
    if not line:
        emit({"type": "error", "message": "No Antigravity request was provided."})
        return 1
    try:
        payload = json.loads(line)
        if not isinstance(payload, dict):
            raise ValueError("Request must be a JSON object.")
        await run(payload)
        return 0
    except Exception as exc:
        if not isinstance(exc, (KeyboardInterrupt, SystemExit)):
            emit({"type": "error", "message": str(exc)})
        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
