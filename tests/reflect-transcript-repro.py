#!/usr/bin/env python3
import hashlib
import json
import os
import re
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest


REPO = Path(__file__).resolve().parents[1]
RESOLVER = REPO / "skills/poteto-mode/scripts/resolve-codex-transcript.py"
CHAT = "00000000-1111-2222-3333-444444444444"
OTHER = "00000000-1111-2222-3333-555555555555"
OPENING = "Reflect on this synthetic request."


def metadata(chat=CHAT):
    return {"type": "session_meta", "payload": {"id": chat}}


def user(text=OPENING):
    return {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}}


class ResolverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pstack reflect ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.home = self.root / "codex # redirected home"
        self.home.mkdir()
        self.path = self.home / "sessions/2026/10/05/known.jsonl"
        self.path.parent.mkdir(parents=True)
        self.write_records([metadata(), user()])
        self.index()

    def write_records(self, records, path=None):
        target = path or self.path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")

    def index(self, name="unversioned.sqlite", rows=None, table="threads"):
        connection = sqlite3.connect(self.home / name)
        connection.execute('CREATE TABLE "' + table + '" (id TEXT, rollout_path TEXT)')
        connection.executemany('INSERT INTO "' + table + '" VALUES (?, ?)', rows or [(CHAT, str(self.path))])
        connection.commit()
        connection.close()

    def run_resolver(self, *arguments, chat=CHAT, env=None):
        environment = dict(os.environ, CODEX_HOME=str(self.home))
        if env:
            environment.update(env)
        result = subprocess.run(
            [sys.executable, str(RESOLVER), chat, *arguments],
            env=environment, capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.stderr, "")
        self.assertLess(len(result.stdout), 5000)
        return result.returncode, json.loads(result.stdout)

    def unresolved(self, reason, *arguments, **kwargs):
        code, result = self.run_resolver(*arguments, **kwargs)
        self.assertEqual(code, 1)
        self.assertEqual(result, {"status": "unresolved", "reason": reason, "fallback": "session_digest"})

    def test_metadata_first_and_redirected_home_with_spaces(self):
        self.write_records([metadata(), {"type": "event_msg", "payload": {"type": "task_started"}}, {"type": "response_item", "payload": {"role": "developer"}}, user()])
        before = {path.relative_to(self.home): path.read_bytes() for path in self.home.rglob("*") if path.is_file()}
        code, result = self.run_resolver()
        self.assertEqual(code, 0)
        self.assertEqual(result["path"], str(self.path))
        self.assertEqual(result["opening_user_message"], {"line": 4, "record_type": "response_item", "characters": len(OPENING), "sha256": hashlib.sha256(OPENING.encode()).hexdigest(), "expected_hash_verified": False})
        self.assertNotIn(OPENING, json.dumps(result))
        after = {path.relative_to(self.home): path.read_bytes() for path in self.home.rglob("*") if path.is_file()}
        self.assertEqual(after, before)

    def test_injected_user_context_is_not_the_opening_request(self):
        injected = user("# AGENTS.md instructions\n<INSTRUCTIONS>Private context</INSTRUCTIONS>")
        injected["payload"]["content"].append({"type": "input_text", "text": "<environment_context>private</environment_context>"})
        self.write_records([metadata(), injected, user()])
        self.unresolved("opening_message_ambiguous")
        code, result = self.run_resolver("--expected-opening-sha256", hashlib.sha256(OPENING.encode()).hexdigest())
        self.assertEqual(code, 0)
        self.assertEqual(result["opening_user_message"]["line"], 3)

    def test_current_envelope_requires_known_opening_binding(self):
        injected = user("# AGENTS.md instructions for /workspace\n\n<INSTRUCTIONS>Private</INSTRUCTIONS>\n")
        injected["payload"]["content"].append({"type": "input_text", "text": "<environment_context>private</environment_context>"})
        self.write_records([metadata(), injected, user()])
        self.unresolved("opening_message_ambiguous")
        code, result = self.run_resolver("--expected-opening-sha256", hashlib.sha256(OPENING.encode()).hexdigest())
        self.assertEqual(code, 0)
        self.assertEqual(result["opening_user_message"]["line"], 3)
        self.unresolved("opening_message_mismatch", "--expected-opening-sha256", "a" * 64)

    def test_human_instruction_lookalikes_are_actual_openings(self):
        for text in ["# AGENTS.md instructions for /workspace\nPlease explain this heading.",
                     "<environment_context>How does this tag work?",
                     "# AGENTS.md instructions\n<INSTRUCTIONS>unfinished",
                     "<environment_context>example</environment_context> followed by a question"]:
            self.write_records([metadata(), user(text), user()])
            code, result = self.run_resolver()
            self.assertEqual(code, 0)
            self.assertEqual(result["opening_user_message"]["line"], 2)
            self.assertEqual(result["opening_user_message"]["sha256"], hashlib.sha256(text.encode()).hexdigest())
            self.unresolved("opening_message_mismatch", "--expected-opening-sha256", hashlib.sha256(OPENING.encode()).hexdigest())

    def test_complete_human_envelope_can_be_bound_but_is_ambiguous_without_evidence(self):
        for text in ["# AGENTS.md instructions for /workspace\n<INSTRUCTIONS>Explain this example.</INSTRUCTIONS>",
                     "<environment_context>Explain this example.</environment_context>"]:
            self.write_records([metadata(), user(text), user()])
            self.unresolved("opening_message_ambiguous")
            code, result = self.run_resolver("--expected-opening-sha256", hashlib.sha256(text.encode()).hexdigest())
            self.assertEqual(code, 0)
            self.assertEqual(result["opening_user_message"]["line"], 2)

    def test_documented_reflect_and_audit_callers_use_the_real_helper(self):
        reference = REPO / "skills/poteto-mode/references/codex-tools.md"
        commands = re.findall(r"```bash\n(.*?)\n```", reference.read_text(), re.S)
        command = next(code for code in commands if "resolve-codex-transcript.py" in code)
        plugin = self.root / "plugin with spaces"
        plugin.symlink_to(REPO, target_is_directory=True)
        self.write_records([metadata(), user("# AGENTS.md instructions for /workspace\n<INSTRUCTIONS>Private</INSTRUCTIONS>"), user()])
        environment = dict(os.environ, CODEX_HOME=str(self.home), plugin_root=str(plugin), chat_id=CHAT,
                           opening_sha256=hashlib.sha256(OPENING.encode()).hexdigest())
        for caller in ["reflect", "show-me-your-work"]:
            instructions = (REPO / "skills" / caller / "SKILL.md").read_text()
            self.assertIn("On Codex", instructions)
            self.assertIn("../poteto-mode/references/codex-tools.md#active-transcripts", instructions)
            invocation = subprocess.run(["bash", "-c", command], env=environment, capture_output=True, text=True)
            self.assertEqual(invocation.returncode, 0, invocation.stderr + invocation.stdout)
            result = json.loads(invocation.stdout)
            self.assertEqual(result["path"], str(self.path))
            self.assertEqual(result["opening_user_message"]["line"], 3)
            self.assertTrue(result["opening_user_message"]["expected_hash_verified"])

    def test_default_home_for_unset_and_empty_variable(self):
        (self.root / ".codex").symlink_to(self.home, target_is_directory=True)
        for value in (None, ""):
            environment = dict(os.environ, HOME=str(self.root))
            if value is None:
                environment.pop("CODEX_HOME", None)
            else:
                environment["CODEX_HOME"] = value
            result = subprocess.run([sys.executable, str(RESOLVER), CHAT], env=environment, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            self.assertEqual(json.loads(result.stdout)["path"], str(self.path))

    def test_schema_selection_ignores_filename_versions_and_unrelated_database(self):
        connection = sqlite3.connect(self.home / "state_999.sqlite")
        connection.execute("CREATE TABLE unrelated_table (private_value TEXT)")
        connection.execute("INSERT INTO unrelated_table VALUES ('unrelated private sentinel')")
        connection.commit()
        connection.close()
        code, result = self.run_resolver()
        self.assertEqual(code, 0)
        self.assertNotIn("sentinel", json.dumps(result))

    def test_exact_chat_selection_does_not_read_unrelated_rollouts(self):
        (self.home / "unversioned.sqlite").unlink()
        self.index(rows=[(OTHER, str(self.root / "unrelated-private.jsonl")), (CHAT + "suffix", str(self.root / "another-private.jsonl")), (CHAT, str(self.path))])
        code, result = self.run_resolver()
        self.assertEqual(code, 0)
        self.assertEqual(result["chat_id"], CHAT)
        self.unresolved("chat_missing", chat="00000000-1111-2222-3333-666666666666")

    def test_missing_index(self):
        (self.home / "unversioned.sqlite").unlink()
        self.unresolved("index_missing")

    def test_incompatible_index_schema(self):
        (self.home / "unversioned.sqlite").unlink()
        connection = sqlite3.connect(self.home / "state.sqlite")
        connection.execute("CREATE TABLE threads (id TEXT, title TEXT)")
        connection.close()
        self.unresolved("index_missing")

    def test_ambiguous_indexes(self):
        self.index("state_2.sqlite")
        self.unresolved("index_ambiguous")

    def test_unreadable_index_does_not_expose_parse_errors(self):
        (self.home / "broken.sqlite").write_bytes(b"unrelated private sentinel")
        self.unresolved("index_unreadable")

    def test_ambiguous_tables_in_one_database(self):
        connection = sqlite3.connect(self.home / "unversioned.sqlite")
        connection.execute("CREATE TABLE other_threads (id TEXT, rollout_path TEXT)")
        connection.close()
        self.unresolved("index_ambiguous")

    def test_duplicate_exact_chat_rows(self):
        connection = sqlite3.connect(self.home / "unversioned.sqlite")
        connection.execute("INSERT INTO threads VALUES (?, ?)", (CHAT, str(self.path)))
        connection.commit()
        connection.close()
        self.unresolved("chat_ambiguous")

    def test_malformed_jsonl_does_not_print_private_bytes(self):
        self.path.write_bytes((json.dumps(metadata()) + '\n{"private sentinel":\n').encode())
        self.unresolved("rollout_malformed")

    def test_nonobject_jsonl_and_invalid_utf8(self):
        for tail in (b"[]\n", b"\xff\n"):
            self.path.write_bytes(json.dumps(metadata()).encode() + b"\n" + tail)
            self.unresolved("rollout_malformed")

    def test_unpaired_surrogate_is_rejected_without_a_traceback(self):
        self.write_records([metadata(), user("\ud800")])
        self.unresolved("rollout_malformed")

    def test_ownership_mismatch(self):
        self.write_records([metadata(OTHER), user()])
        self.unresolved("rollout_owner_mismatch")

    def test_ownership_is_required_before_user_content(self):
        self.write_records([user()])
        self.unresolved("rollout_owner_unverified")

    def test_rollout_path_cannot_leave_the_config_home(self):
        outside = self.root / "private.jsonl"
        self.write_records([metadata(), user("unrelated private sentinel")], outside)
        connection = sqlite3.connect(self.home / "unversioned.sqlite")
        connection.execute("UPDATE threads SET rollout_path = ?", (str(outside),))
        connection.commit()
        connection.close()
        self.unresolved("rollout_path_scope")

    def test_rollout_symlink_cannot_escape_session_scope(self):
        outside = self.root / "private.jsonl"
        self.path.rename(outside)
        self.path.symlink_to(outside)
        self.unresolved("rollout_path_scope")

    def test_rollout_within_home_but_outside_sessions_is_rejected(self):
        private = self.home / "private.jsonl"
        self.path.rename(private)
        connection = sqlite3.connect(self.home / "unversioned.sqlite")
        connection.execute("UPDATE threads SET rollout_path = ?", (str(private),))
        connection.commit()
        connection.close()
        self.unresolved("rollout_path_scope")

    def test_relative_and_oversized_indexed_paths_are_rejected(self):
        connection = sqlite3.connect(self.home / "unversioned.sqlite")
        for path, reason in (("sessions/known.jsonl", "rollout_path_scope"), ("/" + "x" * 4096, "rollout_path_invalid")):
            connection.execute("UPDATE threads SET rollout_path = ?", (path,))
            connection.commit()
            self.unresolved(reason)
        connection.close()

    def test_rollout_symlink_loop_is_bounded(self):
        self.path.unlink()
        self.path.symlink_to(self.path)
        self.unresolved("rollout_unavailable")

    def test_index_symlink_cannot_escape_the_config_home(self):
        index = self.home / "unversioned.sqlite"
        outside = self.root / "outside.sqlite"
        index.rename(outside)
        index.symlink_to(outside)
        self.unresolved("index_path_scope")

    def test_archive_path_is_supported(self):
        archive = self.home / "archived_sessions/known.jsonl"
        self.write_records([metadata(), user()], archive)
        connection = sqlite3.connect(self.home / "unversioned.sqlite")
        connection.execute("UPDATE threads SET rollout_path = ?", (str(archive),))
        connection.commit()
        connection.close()
        code, result = self.run_resolver()
        self.assertEqual(code, 0)
        self.assertEqual(result["path"], str(archive))

    def test_line_byte_and_record_budgets(self):
        self.unresolved("rollout_record_budget", "--max-lines", "1")
        self.unresolved("rollout_line_budget", "--max-line-bytes", "8")
        self.unresolved("rollout_byte_budget", "--max-bytes", "8")

    def test_index_query_budget(self):
        self.unresolved("index_query_budget", "--max-index-steps", "1")

    def test_index_directory_budget(self):
        for number in range(257):
            (self.home / ("unrelated-" + str(number))).touch()
        self.unresolved("index_directory_budget")

    def test_index_count_budget(self):
        for number in range(33):
            (self.home / ("unrelated-" + str(number) + ".db")).touch()
        self.unresolved("index_count_budget")

    def test_expected_opening_hash_and_mismatch(self):
        expected = hashlib.sha256(OPENING.encode()).hexdigest()
        code, result = self.run_resolver("--expected-opening-sha256", expected)
        self.assertEqual(code, 0)
        self.assertTrue(result["opening_user_message"]["expected_hash_verified"])
        self.unresolved("opening_message_mismatch", "--expected-opening-sha256", "0" * 64)

    def test_event_user_message_and_text_parts(self):
        self.write_records([metadata(), {"type": "event_msg", "payload": {"type": "user_message", "message": OPENING}}])
        code, result = self.run_resolver()
        self.assertEqual(code, 0)
        self.assertEqual(result["opening_user_message"]["record_type"], "event_msg")
        message = user("Reflect on ")
        message["payload"]["content"].append({"type": "input_text", "text": "this synthetic request."})
        self.write_records([metadata(), message])
        code, result = self.run_resolver("--expected-opening-sha256", hashlib.sha256(OPENING.encode()).hexdigest())
        self.assertEqual(code, 0)
        self.assertEqual(result["opening_user_message"]["characters"], len(OPENING))

    def test_missing_and_unsupported_opening_messages(self):
        self.write_records([metadata()])
        self.unresolved("opening_message_missing")
        self.write_records([metadata(), user("")])
        self.unresolved("opening_message_unsupported")

    def test_invalid_known_chat_and_hash(self):
        self.unresolved("chat_id_invalid", chat="private title")
        self.unresolved("opening_hash_invalid", "--expected-opening-sha256", "private content")


if __name__ == "__main__":
    unittest.main()
