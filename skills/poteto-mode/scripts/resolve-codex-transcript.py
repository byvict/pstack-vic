#!/usr/bin/env python3
"""Resolve one known Codex chat without printing transcript content.

Adapted from dnncha/open-pstack 23ddb8c (#140); provenance in NOTICE.md.
"""

import argparse
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys


MAX_ENTRIES = 256
MAX_INDEXES = 32
MAX_TABLES = 128
MAX_COLUMNS = 256
MAX_PATH = 4096
MAX_LINES = 500
MAX_BYTES = 2 * 1024 * 1024
MAX_LINE_BYTES = 256 * 1024
MAX_INDEX_STEPS = 200_000


@dataclass(frozen=True)
class ScanBudget:
    lines: int = MAX_LINES
    bytes: int = MAX_BYTES
    line_bytes: int = MAX_LINE_BYTES
    index_steps: int = MAX_INDEX_STEPS


class Unresolved(Exception):
    pass


def quoted_identifier(name):
    return '"' + name.replace('"', '""') + '"'


def indexed_rollout(home, chat_id, budget):
    candidates = []
    try:
        with os.scandir(home) as entries:
            for number, entry in enumerate(entries, 1):
                if number > MAX_ENTRIES:
                    raise Unresolved("index_directory_budget")
                if Path(entry.name).suffix not in (".sqlite", ".sqlite3", ".db"):
                    continue
                path = Path(entry.path).resolve(strict=True)
                if path.parent != home or not path.is_file():
                    raise Unresolved("index_path_scope")
                candidates.append(path)
                if len(candidates) > MAX_INDEXES:
                    raise Unresolved("index_count_budget")
    except (OSError, RuntimeError):
        raise Unresolved("index_directory_unavailable") from None

    connections = []
    indexes = []
    remaining_steps = budget.index_steps
    step_interval = min(100, budget.index_steps)

    def progress():
        nonlocal remaining_steps
        remaining_steps -= step_interval
        return remaining_steps < 0

    try:
        for path in sorted(candidates):
            connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=0)
            connections.append(connection)
            connection.set_progress_handler(progress, step_interval)
            connection.execute("PRAGMA query_only = ON")
            tables = connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' LIMIT ?",
                (MAX_TABLES + 1,),
            ).fetchall()
            if len(tables) > MAX_TABLES:
                raise Unresolved("index_schema_budget")
            for (table,) in tables:
                if len(table) > 256:
                    raise Unresolved("index_schema_budget")
                columns = connection.execute(
                    "PRAGMA table_info(" + quoted_identifier(table) + ")"
                ).fetchmany(MAX_COLUMNS + 1)
                if len(columns) > MAX_COLUMNS:
                    raise Unresolved("index_schema_budget")
                names = {column[1] for column in columns}
                if {"id", "rollout_path"} <= names:
                    indexes.append((connection, table))
        if not indexes:
            raise Unresolved("index_missing")
        if len(indexes) != 1:
            raise Unresolved("index_ambiguous")
        connection, table = indexes[0]
        rows = connection.execute(
            "SELECT rollout_path FROM " + quoted_identifier(table) + " WHERE id = ? LIMIT 2",
            (chat_id,),
        ).fetchall()
        if not rows:
            raise Unresolved("chat_missing")
        if len(rows) != 1:
            raise Unresolved("chat_ambiguous")
        rollout = rows[0][0]
        if not isinstance(rollout, str) or not rollout or len(rollout) > MAX_PATH:
            raise Unresolved("rollout_path_invalid")
        return rollout
    except sqlite3.Error:
        reason = "index_query_budget" if remaining_steps < 0 else "index_unreadable"
        raise Unresolved(reason) from None
    finally:
        for connection in connections:
            connection.close()


def scoped_rollout(home, indexed_path):
    path = Path(indexed_path)
    if not path.is_absolute():
        raise Unresolved("rollout_path_scope")
    try:
        path = path.resolve(strict=True)
        if not any(root in path.parents for root in (home / "sessions", home / "archived_sessions")):
            raise Unresolved("rollout_path_scope")
        if path.suffix != ".jsonl" or not stat.S_ISREG(path.stat().st_mode):
            raise Unresolved("rollout_path_invalid")
        if len(str(path)) > MAX_PATH:
            raise Unresolved("rollout_path_invalid")
        return path
    except (OSError, RuntimeError, ValueError):
        raise Unresolved("rollout_unavailable") from None


def user_text(record):
    payload = record.get("payload")
    if not isinstance(payload, dict):
        return None
    if record.get("type") == "event_msg" and payload.get("type") == "user_message":
        text = payload.get("message")
        if not isinstance(text, str) or not text.strip():
            raise Unresolved("opening_message_unsupported")
        return text, [text]
    if record.get("type") != "response_item" or payload.get("role") != "user":
        return None
    if payload.get("type") != "message" or not isinstance(payload.get("content"), list):
        raise Unresolved("opening_message_unsupported")
    parts = []
    for part in payload["content"]:
        if not isinstance(part, dict):
            raise Unresolved("opening_message_unsupported")
        if part.get("type") in ("input_text", "text"):
            if not isinstance(part.get("text"), str):
                raise Unresolved("opening_message_unsupported")
            parts.append(part["text"])
    text = "".join(parts)
    if not text.strip():
        raise Unresolved("opening_message_unsupported")
    return text, parts


def injected_context(parts):
    return all(
        re.fullmatch(r"# AGENTS\.md instructions(?: for [^\r\n]+)?\r?\n\s*<INSTRUCTIONS>[\s\S]*</INSTRUCTIONS>\s*", part) is not None
        or re.fullmatch(r"<environment_context>[\s\S]*</environment_context>\s*", part) is not None
        for part in parts
    )


def opening_message(path, chat_id, budget, expected_hash):
    owned = False
    consumed = 0
    try:
        with path.open("rb") as stream:
            for line in range(1, budget.lines + 1):
                allowance = min(budget.line_bytes, budget.bytes - consumed)
                if allowance <= 0:
                    raise Unresolved("rollout_byte_budget")
                raw = stream.readline(allowance + 1)
                if not raw:
                    raise Unresolved("opening_message_missing")
                if len(raw) > allowance:
                    reason = "rollout_line_budget" if allowance == budget.line_bytes else "rollout_byte_budget"
                    raise Unresolved(reason)
                consumed += len(raw)
                if not raw.strip():
                    continue
                try:
                    record = json.loads(raw)
                except (ValueError, UnicodeError, RecursionError):
                    raise Unresolved("rollout_malformed") from None
                if not isinstance(record, dict):
                    raise Unresolved("rollout_malformed")
                if record.get("type") == "session_meta":
                    payload = record.get("payload")
                    if not isinstance(payload, dict) or payload.get("id") != chat_id:
                        raise Unresolved("rollout_owner_mismatch")
                    owned = True
                candidate = user_text(record)
                if candidate is None:
                    continue
                if not owned:
                    raise Unresolved("rollout_owner_unverified")
                text, parts = candidate
                try:
                    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
                except UnicodeError:
                    raise Unresolved("rollout_malformed") from None
                if digest != expected_hash and injected_context(parts):
                    if expected_hash is None:
                        raise Unresolved("opening_message_ambiguous")
                    continue
                if expected_hash is not None and digest != expected_hash:
                    raise Unresolved("opening_message_mismatch")
                return {
                    "line": line,
                    "record_type": record["type"],
                    "characters": len(text),
                    "sha256": digest,
                    "expected_hash_verified": expected_hash is not None,
                }
    except OSError:
        raise Unresolved("rollout_unavailable") from None
    raise Unresolved("rollout_record_budget")


def bounded_integer(maximum):
    def parse(value):
        try:
            number = int(value)
        except ValueError:
            raise argparse.ArgumentTypeError("budget must be an integer") from None
        if not 1 <= number <= maximum:
            raise argparse.ArgumentTypeError("budget must be between 1 and " + str(maximum))
        return number
    return parse


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("chat_id", help="the parent's known UUID, never a title or search term")
    parser.add_argument("--expected-opening-sha256", help="SHA256 of concatenated opening user text parts")
    parser.add_argument("--max-lines", type=bounded_integer(MAX_LINES), default=MAX_LINES)
    parser.add_argument("--max-bytes", type=bounded_integer(MAX_BYTES), default=MAX_BYTES)
    parser.add_argument("--max-line-bytes", type=bounded_integer(MAX_LINE_BYTES), default=MAX_LINE_BYTES)
    parser.add_argument("--max-index-steps", type=bounded_integer(MAX_INDEX_STEPS), default=MAX_INDEX_STEPS)
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", args.chat_id):
        print(json.dumps({"status": "unresolved", "reason": "chat_id_invalid", "fallback": "session_digest"}))
        return 1
    if args.expected_opening_sha256 is not None and not re.fullmatch(r"[0-9a-f]{64}", args.expected_opening_sha256):
        print(json.dumps({"status": "unresolved", "reason": "opening_hash_invalid", "fallback": "session_digest"}))
        return 1
    budget = ScanBudget(args.max_lines, args.max_bytes, args.max_line_bytes, args.max_index_steps)
    try:
        home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex").resolve(strict=True)
        rollout = scoped_rollout(home, indexed_rollout(home, args.chat_id, budget))
        opening = opening_message(rollout, args.chat_id, budget, args.expected_opening_sha256)
        print(json.dumps({"status": "resolved", "chat_id": args.chat_id, "path": str(rollout), "opening_user_message": opening}))
        return 0
    except (OSError, RuntimeError, ValueError):
        reason = "config_home_unavailable"
    except Unresolved as exc:
        reason = str(exc)
    print(json.dumps({"status": "unresolved", "reason": reason, "fallback": "session_digest"}))
    return 1


if __name__ == "__main__":
    sys.exit(main())
