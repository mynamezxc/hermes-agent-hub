"""Tests for agents-hub plugin_api. Run: python -m unittest test_plugin_api -v

Builds a fake HERMES_HOME under the Hermes scratch dir (schemas copied from the real
databases' sqlite_master — structure only, never rows).
"""
import importlib.util
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import unittest
from pathlib import Path

REAL = Path(os.environ.get("AGENTS_HUB_REAL_HOME") or Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "hermes")
FIX = Path(os.environ.get("AGENTS_HUB_FIXTURE_DIR") or REAL / "cache" / "scratch" / "agents-hub-test")
API = Path(__file__).resolve().parent.parent / "dashboard" / "plugin_api.py"


def real_schema(rel: str) -> list[str]:
    con = sqlite3.connect("file:" + (REAL / rel).as_posix() + "?mode=ro", uri=True)
    try:
        return [r[0] for r in con.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL AND name NOT LIKE '%fts%' "
            "AND name NOT LIKE 'sqlite_%'")]
    finally:
        con.close()


def make_db(path: Path, schema_from: str, inserts: list[tuple[str, tuple]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    for ddl in real_schema(schema_from):
        try:
            con.execute(ddl)
        except sqlite3.Error:
            pass
    for sql, params in inserts:
        con.execute(sql, params)
    con.commit()
    con.close()


def git(repo: Path, *a: str) -> None:
    subprocess.run(["git", "-C", str(repo), "-c", "user.email=t@t", "-c", "user.name=t", *a],
                   check=True, capture_output=True)


SECRET = "sk-" + "abcdefghijklmnopqrstuvwx"  # fake key, built at runtime so scanners do not flag it
FB = "EAAB" + "x" * 30


class AgentsHubTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if FIX.exists():
            def _unlock(fn, path, _exc):
                os.chmod(path, 0o700)
                fn(path)
            shutil.rmtree(FIX, onexc=_unlock)
        home = FIX / "home"
        repo = FIX / "repo"
        repo.mkdir(parents=True)
        git(repo, "init", "-q")
        (repo / "a.txt").write_text("one\ntwo\n")
        (repo / "private").mkdir()
        (repo / "private" / "x.txt").write_text("secret stuff\n")
        (repo / ".env").write_text("A=1\n")
        git(repo, "add", "-f", "a.txt", "private/x.txt", ".env")
        git(repo, "commit", "-qm", "init")
        (repo / "a.txt").write_text("one\ntwo\nthree\napi_key = " + SECRET + "\n")
        (repo / "private" / "x.txt").write_text("changed secret\n")
        (repo / ".env").write_text("A=2\n")
        (repo / "new.txt").write_text("hello\nworld\n")
        (repo / "sub").mkdir()
        (repo / "sub" / "my_token.txt").write_text("tok\n")
        (repo / "sub" / "ok.txt").write_text("fine\n")
        (repo / "key.pem").write_text("-----BEGIN-----\n")
        cls.repo = repo

        now = time.time()
        (home / "profiles" / "dev-backend").mkdir(parents=True)
        (home / "profiles" / "newbie").mkdir(parents=True)
        (home / "config.yaml").write_text("model:\n  # c\n  default: \"claude-opus-5-5\"\n  provider: anthropic\n")
        (home / "agents-hub").mkdir(parents=True, exist_ok=True)
        (home / "agents-hub" / "team.json").write_text(json.dumps({"version": 1, "agents": {
            "default": {"name": "CEO Hermes", "role": "Coordinator", "reports_to": "Owner", "avatar": "default"},
            "dev-backend": {"name": "Dev Backend", "role": "Lập trình backend", "reports_to": "tech-lead", "avatar": "dev-backend"}}}))
        (home / "profiles" / "dev-backend" / "config.yaml").write_text("model:\n  default: claude-sonnet-5-5\n")
        sess = ("INSERT INTO sessions (id, source, started_at, ended_at, end_reason, parent_session_id, "
                "message_count, input_tokens, output_tokens, display_name) VALUES (?,?,?,?,?,?,?,?,?,?)")
        msg = "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)"
        make_db(home / "state.db", "state.db", [
            (sess, ("root", "desktop", now - 100, None, None, None, 2, 10, 20, "root chat")),
            (sess, ("child1", "subagent", now - 90, now - 50, None, "root", 2, 5, 5, "sub task")),
            (sess, ("comp", "desktop", now - 40, None, None, "ended", 1, 0, 0, "compression child")),
            (sess, ("ended", "desktop", now - 300, now - 41, "compression", None, 1, 0, 0, "x")),
            (msg, ("root", "user", "hi", now - 99)),
            (msg, ("root", "assistant", "token: abc123secret", now - 5)),
            (msg, ("child1", "user", "do this with Bearer abcdefgh12345678", now - 89)),
            (msg, ("child1", "assistant", "done " + FB, now - 60)),
            ("INSERT INTO async_delegations (delegation_id, origin_session, state, dispatched_at, updated_at, "
             "event_json) VALUES ('d1','root','running',?,?,?)", (now - 10, now - 10, json.dumps({"goal": "build X"}))),
        ])
        make_db(home / "profiles" / "dev-backend" / "state.db", "state.db", [
            (sess, ("old", "desktop", now - 7200, now - 7000, "cli_close", None, 1, 1, 1, "old")),
            (sess, ("tool1", "tool", now - 500, now - 400, "cli_close", None, 1, 1, 1, "cross")),
            (msg, ("tool1", "user", "from ceo", now - 499)),
        ])
        make_db(home / "kanban.db", "kanban.db", [
            ("INSERT INTO tasks (id,title,assignee,status,priority,created_by,created_at,workspace_path) "
             "VALUES ('t1','Task one','dev-backend','running',1,'manager',?,?)", (int(now - 500), str(repo))),
            ("INSERT INTO tasks (id,title,assignee,status,created_by,created_at) VALUES "
             "('t2','Done task','sales','done','default',?)", (int(now - 900),)),
            ("INSERT INTO task_comments (task_id,author,body,created_at) VALUES ('t1','manager','please do',?)",
             (int(now - 400),)),
            ("INSERT INTO task_comments (task_id,author,body,created_at) VALUES ('t1','dev-backend','ok',?)",
             (int(now - 300),)),
            ("INSERT INTO task_runs (task_id,profile,status,started_at) VALUES ('t1','dev-backend','running',?)",
             (int(now - 200),)),
        ])
        make_db(home / "projects.db", "projects.db", [])
        (home / "cron").mkdir()
        (home / "cron" / "jobs.json").write_text(json.dumps({"jobs": [{
            "id": "j1", "name": "Nightly", "enabled": True, "state": "scheduled", "schedule_display": "0 3 * * *",
            "last_run_at": "2026-10-28T03:00:00+07:00", "next_run_at": "2026-10-29T03:00:00+07:00",
            "last_status": "ok", "last_error": None}]}))
        (home / "agents-hub.json").write_text(json.dumps({"repos": [repo.as_posix()]}))
        cls.home = home
        os.environ["HERMES_HOME"] = str(home)

        spec = importlib.util.spec_from_file_location("agents_hub_api", API)
        assert spec is not None and spec.loader is not None
        cls.m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.m)
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        app = FastAPI()
        app.include_router(cls.m.router, prefix="/api/plugins/agents-hub")
        cls.c = TestClient(app)

    def get(self, url, **kw):
        r = self.c.get("/api/plugins/agents-hub" + url, **kw)
        return r

    # --- endpoints ---------------------------------------------------------
    def test_health(self):
        self.assertEqual(self.get("/health").json(), {"ok": True, "version": "1"})

    def test_agents(self):
        a = {x["id"]: x for x in self.get("/agents").json()["agents"]}
        self.assertEqual(set(a), {"default", "dev-backend", "newbie"})
        self.assertEqual(a["default"]["status"], "active")
        self.assertEqual(a["default"]["model"], "claude-opus-5-5")
        self.assertEqual(a["default"]["provider"], "anthropic")
        self.assertEqual(a["default"]["cron_jobs"], 1)
        self.assertEqual(a["dev-backend"]["reports_to"], "tech-lead")
        self.assertEqual(a["dev-backend"]["status"], "idle")
        self.assertEqual(a["dev-backend"]["sessions_total"], 2)
        self.assertEqual(a["newbie"]["role"], "Agent")
        self.assertEqual(a["newbie"]["name"], "Newbie")  # generated roster entry for a new profile
        self.assertRegex(a["newbie"]["avatar"], r"^[0-9a-f]{8}$")  # random avatar seed
        self.assertEqual(a["dev-backend"]["avatar"], "dev-backend")  # existing entries are kept as edited
        team = json.loads((FIX / "home" / "agents-hub" / "team.json").read_text(encoding="utf-8"))["agents"]
        self.assertEqual(set(team), {"default", "dev-backend", "newbie"})
        self.assertIn("`newbie`", (FIX / "home" / "agents-hub" / "TEAM.md").read_text(encoding="utf-8"))
        self.assertEqual(a["dev-backend"]["name"], "Dev Backend")
        self.assertEqual(a["default"]["name"], "CEO Hermes")
        self.assertEqual(a["newbie"]["reports_to"], "default")
        self.assertEqual(a["newbie"]["status"], "offline")
        self.assertEqual(a["default"]["sessions_24h"], 4)

    def test_conversations(self):
        cs = self.get("/conversations").json()["conversations"]
        kinds = {c["id"]: c for c in cs}
        self.assertIn("delegation:default:child1", kinds)
        self.assertEqual(kinds["delegation:default:child1"]["from_agent"], "default")
        self.assertNotIn("delegation:default:comp", kinds)  # compression continuation skipped
        self.assertIn("cross_profile:dev-backend:tool1", kinds)
        self.assertIn("kanban:t1", kinds)
        self.assertEqual(kinds["kanban:t1"]["kind"], "kanban")
        self.assertIn("async:default:d1", kinds)
        starts = [c["started_at"] for c in cs]
        self.assertEqual(starts, sorted(starts, reverse=True))
        self.assertNotIn(SECRET, json.dumps(cs))
        only = self.get("/conversations?agent=dev-backend&limit=1").json()["conversations"]
        self.assertEqual(len(only), 1)

    def test_conversation_detail_redacted(self):
        d = self.get("/conversations/default/child1").json()
        self.assertEqual(d["meta"]["to_agent"], "default")
        txt = json.dumps(d)
        self.assertNotIn(FB, txt)
        self.assertNotIn("abcdefgh12345678", txt)
        self.assertIn("[REDACTED]", txt)
        k = self.get("/conversations/kanban/t1").json()
        self.assertEqual([m["speaker"] for m in k["messages"]], ["manager", "dev-backend"])
        self.assertEqual(self.get("/conversations/nope/x").status_code, 404)
        self.assertEqual(self.get("/conversations/default/missing").status_code, 404)
        self.assertEqual(self.get("/conversations/default/async:d1").status_code, 200)

    def test_titles(self):
        cs = {c["id"]: c for c in self.get("/conversations").json()["conversations"]}
        # delegation: first user message of the child session, one line, redacted, <= 90 chars
        t = cs["delegation:default:child1"]["title"]
        self.assertTrue(t.startswith("do this with"))
        self.assertNotIn("abcdefgh12345678", t)
        self.assertLessEqual(len(t), 91)
        self.assertNotIn("\n", t)
                # cross_profile: generic/empty session title -> first user message (B3)
        self.assertEqual(cs["cross_profile:dev-backend:tool1"]["title"], "from ceo")

    def test_decode_content(self):
        d = self.m.decode_content
        self.assertEqual(d("plain **md** text\\n"), "plain **md** text\\n")  # not JSON: untouched
        self.assertEqual(d(json.dumps([{"type": "text", "text": "a"}, {"type": "text", "text": "b"}])), "a\n\nb")
        self.assertEqual(d(json.dumps({"summary": "short", "result": "long"})), "short")
        self.assertEqual(d(json.dumps({"result": "line1\\nline2"})), "line1\nline2")
        self.assertEqual(d(json.dumps("hello\\nworld")), "hello\nworld")
        pretty = d(json.dumps({"ok": True, "n": 1}))
        self.assertIn('"ok": true', pretty)
        self.assertEqual(d("{not json"), "{not json")
        self.assertEqual(d(None), "")

    def test_tool_message_decoded_then_redacted(self):
        con = sqlite3.connect(self.home / "state.db")
        con.execute("INSERT INTO messages (session_id, role, content, tool_name, timestamp) VALUES "
                    "('child1','tool',?,'terminal',?)",
                    (json.dumps({"summary": "ok\nline2 api_key = hunter99", "x": 1}), time.time()))
        con.commit()
        con.close()
        msgs = self.get("/conversations/default/child1").json()["messages"]
        tool = [m for m in msgs if m["role"] == "tool"][-1]
        self.assertIn("line2", tool["content"])
        self.assertIn("\n", tool["content"])
        self.assertNotIn("{", tool["content"])
        self.assertNotIn("hunter99", tool["content"])
        self.assertIn("[REDACTED]", tool["content"])

    def test_content_truncated(self):
        con = sqlite3.connect(self.home / "state.db")
        con.execute("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('child1','assistant',?,?)",
                    ("y" * 9000, time.time()))
        con.commit()
        con.close()
        msgs = self.get("/conversations/default/child1").json()["messages"]
        self.assertLessEqual(max(len(m["content"]) for m in msgs), 4001)

    def test_works(self):
        w = {x["id"]: x for x in self.get("/works").json()["works"]}
        self.assertEqual(w["cron:default:j1"]["kind"], "cron")
        self.assertIsInstance(w["cron:default:j1"]["next_run_at"], float)
        self.assertTrue(any(x["kind"] == "run" and x["status"] == "running" for x in w.values()))
        self.assertTrue(any(x["kind"] == "delegation" for x in w.values()))

    def test_tasks(self):
        t = self.get("/tasks").json()
        self.assertEqual(t["counts"], {"running": 1, "done": 1})
        t1 = next(x for x in t["tasks"] if x["id"] == "t1")
        self.assertEqual(t1["comments"], 2)

    def test_changes_and_denylist(self):
        repos = self.get("/changes").json()["repos"]
        self.assertEqual(len(repos), 1)
        r = repos[0]
        self.assertEqual(len(r["id"]), 12)
        self.assertFalse(r["clean"])
        f = {x["path"]: x for x in r["files"]}
        self.assertEqual(f["a.txt"]["status"], "M")
        self.assertEqual((f["a.txt"]["additions"], f["a.txt"]["deletions"]), (2, 0))
        self.assertEqual(f["new.txt"]["status"], "?")
        self.assertEqual(f["new.txt"]["additions"], 2)
        for hidden in ("private/x.txt", ".env", "sub/my_token.txt", "key.pem"):
            self.assertEqual(f[hidden]["status"], "hidden", hidden)
            self.assertEqual((f[hidden]["additions"], f[hidden]["deletions"]), (0, 0))
        self.assertEqual(f["sub/ok.txt"]["status"], "?")
        self.repo_id = r["id"]

    def _rid(self):
        return self.get("/changes").json()["repos"][0]["id"]

    def test_diff(self):
        rid = self._rid()
        d = self.get("/diff", params={"repo": rid, "path": "a.txt"}).json()
        self.assertIn("+three", d["diff"])
        self.assertNotIn(SECRET, d["diff"])
        self.assertIn("[REDACTED]", d["diff"])
        n = self.get("/diff", params={"repo": rid, "path": "new.txt"}).json()
        self.assertIn("+hello", n["diff"])
        self.assertIn("new file", n["diff"])
        self.assertFalse(n["truncated"])

    def test_diff_denied_and_traversal(self):
        rid = self._rid()
        for p in ("private/x.txt", ".env", "sub/my_token.txt", "key.pem"):
            d = self.get("/diff", params={"repo": rid, "path": p}).json()
            self.assertEqual(d["diff"], "", p)
        for p in ("../x", "..\\x", "sub/../../x", "/etc/passwd", "C:/Windows/win.ini", "C:\\x", "a\x00b"):
            self.assertEqual(self.get("/diff", params={"repo": rid, "path": p}).status_code, 400, p)
        self.assertEqual(self.get("/diff", params={"repo": "deadbeef0000", "path": "a.txt"}).status_code, 404)

    def test_diff_truncation(self):
        (self.repo / "big.txt").write_text("z" * 300000 + "\n")
        self.m._repo_cache["at"] = 0
        d = self.get("/diff", params={"repo": self._rid(), "path": "big.txt"}).json()
        self.assertTrue(d["truncated"])
        self.assertLessEqual(len(d["diff"].encode()), 200 * 1024 + 10)
        (self.repo / "big.txt").unlink()

    # --- units -------------------------------------------------------------
    def test_redact_patterns(self):
        r = self.m.redact
        for s in (FB, SECRET, "password = hunter2", "token: abc", "ghp_AbC123def", "Authorization: Bearer abcdefgh123456",
                  "access_token=xyz", "api_key: k", "app_secret=s"):
            self.assertIn("[REDACTED]", r(s), s)
        self.assertNotIn("hunter2", r("password = hunter2"))
        self.assertEqual(r("plain text"), "plain text")

    def test_is_denied(self):
        d = self.m.is_denied
        for p in ("private/a", "proj/private/x.json", "a.dpapi", ".env", ".env.local", "my_token.txt", "client_secret.json",
                  "x.pem", "k.key", "auth.json", "credentials.json", "policy.json", "audit.jsonl", "STOP_PUBLISHING"):
            self.assertTrue(d(p), p)
        for p in ("src/main.py", "README.md", "privateer.txt"):
            self.assertFalse(d(p), p)

    def test_missing_everything_no_500(self):
        old = os.environ["HERMES_HOME"]
        os.environ["HERMES_HOME"] = str(FIX / "empty")
        try:
            for u in ("/agents", "/conversations", "/works", "/tasks", "/changes"):
                self.assertEqual(self.get(u).status_code, 200, u)
        finally:
            os.environ["HERMES_HOME"] = old

    def test_readonly_connection(self):
        db = self.home / "state.db"
        before = db.stat().st_mtime
        self.m.query(db, "SELECT * FROM sessions")
        self.assertEqual(db.stat().st_mtime, before)
        # a write through the helper's connection mode must fail (swallowed -> [])
        self.assertEqual(self.m.query(db, "DELETE FROM sessions"), [])
        self.assertTrue(self.m.query(db, "SELECT 1 AS x FROM sessions LIMIT 1"))

    def test_manifest(self):
        mf = json.loads((API.parent / "manifest.json").read_text())
        self.assertEqual((mf["name"], mf["api"]), ("agents-hub", "plugin_api.py"))


class V2Test(unittest.TestCase):
    """SPEC v2: root_home, tool calls, titles, timeline, /chat."""

    @classmethod
    def setUpClass(cls):
        root = FIX / "home2"
        if root.exists():
            def _unlock(fn, path, _exc):
                os.chmod(path, 0o700)
                fn(path)
            shutil.rmtree(root, onexc=_unlock)
        (root / "profiles" / "marketing").mkdir(parents=True)
        (root / "profiles" / "sales").mkdir(parents=True)
        t = 1_800_000_000.0
        cls.t = t
        sess = ("INSERT INTO sessions (id, source, started_at, ended_at, end_reason, parent_session_id, "
                "message_count, title, last_activity_at) VALUES (?,?,?,?,?,?,?,?,?)")
        msg = ("INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, tool_name, timestamp, "
               "active, compacted) VALUES (?,?,?,?,?,?,?,?,?)")
        calls = json.dumps([
            {"id": "c1", "type": "function", "function": {"name": "terminal",
                                                            "arguments": json.dumps({"command": "ls -la", "api_key": "zzz"})}},
            {"id": "c2", "type": "function", "function": {"name": "read_file",
                                                            "arguments": json.dumps({"path": "a/b.py", "x": "y" * 900})}},
        ])
        make_db(root / "state.db", "state.db", [
            (sess, ("d1", "desktop", t + 10, None, None, None, 5, "Chat A", t + 60)),
            (sess, ("sub", "subagent", t + 15, t + 20, None, "d1", 1, "Subagent: Do the thing", t + 20)),
            (sess, ("d2", "desktop", t + 100, t + 150, "compression", None, 1, None, t + 150)),
            (sess, ("d3", "desktop", t + 151, None, None, "d2", 1, "", t + 200)),
            (sess, ("bc0", "desktop", t + 5, None, None, None, 1, "Bot Chat", t + 6)),
            (sess, ("bc1", "desktop", t + 300, None, None, None, 1, "Bot Chat", t + 301)),
            (msg, ("d1", "user", "hello", None, None, None, t + 11, 1, 0)),
            (msg, ("d1", "system", "SYSTEM PROMPT", None, None, None, t + 11.5, 1, 0)),
            (msg, ("d1", "assistant", "", calls, None, None, t + 12, 1, 0)),
            (msg, ("d1", "tool", json.dumps({"output": "file1"}), None, "c1", "terminal", t + 13, 1, 0)),
            (msg, ("d1", "assistant", "done **ok**", None, None, None, t + 14, 1, 0)),
            (msg, ("d1", "assistant", "HIDDEN ROW", None, None, None, t + 14.5, 0, 0)),
            (msg, ("sub", "user", "delegated goal for the sub", None, None, None, t + 16, 1, 0)),
            (msg, ("d2", "user", "before compression", None, None, None, t + 101, 1, 0)),
            (msg, ("d3", "assistant", "after compression", None, None, None, t + 152, 1, 0)),
            (msg, ("bc0", "user", "old bot chat", None, None, None, t + 6, 1, 0)),
            (msg, ("bc1", "user", "ping", None, None, None, t + 301, 1, 0)),
        ])
        make_db(root / "profiles" / "marketing" / "state.db", "state.db", [
            (sess, ("x1", "tool", t + 30, t + 40, "cli_close", None, 2, "tool", t + 40)),
            (sess, ("x2", "oneshot", t + 50, t + 60, "cli_close", None, 1, "Campaign brief", t + 60)),
            (sess, ("m1", "desktop", t + 70, None, None, None, 1, None, t + 71)),
            (msg, ("x1", "user", "Viết bài về POS\nngắn gọn", None, None, None, t + 31, 1, 0)),
            (msg, ("x2", "user", "brief body", None, None, None, t + 51, 1, 0)),
            (msg, ("m1", "user", "owner to marketing", None, None, None, t + 71, 1, 0)),
        ])
        cls.root = root
        cls.old_env = os.environ.get("HERMES_HOME")
        os.environ["HERMES_HOME"] = str(root)
        spec = importlib.util.spec_from_file_location("agents_hub_api_v2", API)
        assert spec is not None and spec.loader is not None
        cls.m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.m)
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        app = FastAPI()
        app.include_router(cls.m.router, prefix="/api/plugins/agents-hub")
        cls.c = TestClient(app)

    @classmethod
    def tearDownClass(cls):
        if cls.old_env is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = cls.old_env

    def setUp(self):
        os.environ["HERMES_HOME"] = str(self.root)

    def get(self, url, **kw):
        return self.c.get("/api/plugins/agents-hub" + url, **kw)

    # B1
    def test_root_home_from_profile_dir(self):
        prof = self.root / "profiles" / "marketing"
        os.environ["HERMES_HOME"] = str(prof)
        self.assertEqual(self.m.root_home(), self.root)
        self.assertEqual(self.m.list_agents(), ["default", "marketing", "sales"])
        self.assertEqual({a["id"] for a in self.get("/agents").json()["agents"]}, {"default", "marketing", "sales"})
        r = self.get("/conversations/marketing/x1")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.get("/conversations/default/sub").status_code, 200)
        a = self.get("/agents/default/timeline").json()
        os.environ["HERMES_HOME"] = str(self.root)
        b = self.get("/agents/default/timeline").json()
        self.assertEqual(a, b)
        self.assertEqual(self.m.root_home(), self.root)

    # B2
    def test_tool_calls_and_messages(self):
        d = self.get("/conversations/default/d1").json()
        msgs = d["messages"]
        self.assertEqual([m["role"] for m in msgs], ["user", "assistant", "tool", "assistant"])  # system + inactive hidden
        self.assertNotIn("HIDDEN ROW", json.dumps(d))
        a = msgs[1]
        self.assertEqual(a["content"], "")
        self.assertEqual([c["id"] for c in a["tool_calls"]], ["c1", "c2"])
        self.assertEqual(a["tool_calls"][0]["name"], "terminal")
        self.assertEqual(a["tool_calls"][0]["summary"], "ls -la")
        self.assertEqual(a["tool_calls"][0]["args"]["api_key"], "[REDACTED]")
        self.assertEqual(a["tool_calls"][1]["summary"], "a/b.py")
        self.assertLessEqual(len(a["tool_calls"][1]["args"]["x"]), 601)
        self.assertEqual(msgs[2]["tool_call_id"], "c1")
        self.assertEqual(msgs[2]["content"], "file1")
        self.assertEqual(msgs[0]["tool_calls"], [])
        for k in ("id", "role", "speaker", "content", "timestamp", "tool_name", "tool_call_id", "tool_calls"):
            self.assertIn(k, msgs[0])

    def test_tool_summary_rules(self):
        f = self.m.tool_summary
        self.assertEqual(f("terminal", {"command": "git status"}), "git status")
        self.assertEqual(f("search_files", {"pattern": "TODO", "path": "src"}), "TODO")
        self.assertEqual(f("patch", {"path": "x.py", "old_string": "a"}), "x.py")
        self.assertEqual(f("write_file", {"path": "w.txt", "content": "c"}), "w.txt")
        self.assertEqual(f("web_search", {"query": "hermes"}), "hermes")
        self.assertEqual(f("web_extract", {"urls": ["https://a.b", "https://c.d"]}), "https://a.b")
        self.assertEqual(len(f("delegate_task", {"goal": "g" * 500})), 161)
        self.assertEqual(f("delegate_task", {"tasks": [{"goal": "first"}, {"goal": "second"}]}), "first")
        self.assertEqual(f("skill_view", {"name": "pdf"}), "pdf")
        self.assertEqual(f("browser_click", {"ref": "e5"}), "browser_click e5")
        self.assertEqual(f("mcp_foo_bar", {"q": "zz"}), "mcp_foo_bar zz")
        self.assertEqual(f("custom", {"a": "val"}), "custom(val…)")
        self.assertEqual(f("custom", {}), "custom()")
        self.assertEqual(self.m.parse_tool_calls("not json"), [])
        self.assertEqual(self.m.parse_tool_calls(None), [])

    # B3
    def test_titles_cross_profile(self):
        cs = {c["id"]: c for c in self.get("/conversations").json()["conversations"]}
        self.assertEqual(cs["cross_profile:marketing:x1"]["title"], "Viết bài về POS ngắn gọn")  # generic 'tool'
        self.assertEqual(cs["cross_profile:marketing:x2"]["title"], "Campaign brief")
        self.assertEqual(cs["delegation:default:sub"]["title"], "Do the thing")  # 'Subagent: ' stripped
        self.assertEqual(self.m._clean_title("Subagent"), "")
        self.assertEqual(self.m._clean_title("oneshot"), "")

    # B4
    def test_timeline_merge(self):
        t = self.t
        d = self.get("/agents/default/timeline").json()
        self.assertEqual(d["agent"], "default")
        self.assertFalse(d["has_more"])
        items = d["items"]
        types = [i["type"] for i in items]
        self.assertEqual(set(types), {"session", "message", "handoff"})
        self.assertNotIn("SYSTEM PROMPT", json.dumps(items))
        self.assertNotIn("HIDDEN ROW", json.dumps(items))
        self.assertNotIn("delegated goal", json.dumps([i for i in items if i["type"] == "message"]))
        stamps = [i.get("timestamp") or i.get("started_at") or i.get("at") for i in items]
        self.assertEqual(stamps, sorted(stamps))
        sess = [i["session_id"] for i in items if i["type"] == "session"]
        self.assertEqual(sess, ["bc0", "d1", "d2", "bc1"])  # d3 continues d2: no divider; sub is a handoff
        self.assertEqual(next(i for i in items if i["type"] == "session")["title"], "Bot Chat")
        d2 = next(i for i in items if i["type"] == "session" and i["session_id"] == "d2")
        self.assertEqual(d2["title"], "before compression")
        self.assertEqual([i["content"] for i in items if i["type"] == "message" and i["session_id"] in ("d2", "d3")],
                         ["before compression", "after compression"])
        tc = next(i for i in items if i["type"] == "message" and i["tool_calls"])
        self.assertEqual(tc["tool_calls"][0]["summary"], "ls -la")
        hs = [i for i in items if i["type"] == "handoff"]
        by = {h["session_id"]: h for h in hs}
        self.assertEqual(set(by), {"sub", "x1", "x2"})
        self.assertEqual(by["x1"]["direction"], "out")
        self.assertEqual((by["x1"]["from_agent"], by["x1"]["to_agent"], by["x1"]["profile"]), ("default", "marketing", "marketing"))
        self.assertEqual(by["sub"]["direction"], "out")
        self.assertEqual(by["sub"]["to_agent"], "subagent")
        self.assertEqual(by["x1"]["summary"], "Viết bài về POS ngắn gọn")
        self.assertLessEqual(len(by["x1"]["summary"]), 201)
        for k in ("kind", "title", "status", "at", "message_count"):
            self.assertIn(k, by["x1"])
        self.assertEqual(by["x1"]["at"], t + 30)

    def test_timeline_handoff_in_and_direct(self):
        items = self.get("/agents/marketing/timeline").json()["items"]
        hs = {i["session_id"]: i for i in items if i["type"] == "handoff"}
        self.assertEqual(set(hs), {"x1", "x2"})
        self.assertTrue(all(h["direction"] == "in" for h in hs.values()))
        self.assertEqual([i["content"] for i in items if i["type"] == "message"], ["owner to marketing"])
        self.assertEqual([i["session_id"] for i in items if i["type"] == "session"], ["m1"])
        # no handoff sessions leak as direct messages
        self.assertNotIn("brief body", json.dumps([i for i in items if i["type"] == "message"]))

    def test_timeline_pagination(self):
        full = self.get("/agents/default/timeline?limit=500").json()
        n = len(full["items"])
        self.assertGreater(n, 6)
        seen, before, pages = [], None, 0
        while True:
            url = "/agents/default/timeline?limit=4" + (f"&before={before}" if before is not None else "")
            r = self.get(url).json()
            pages += 1
            self.assertLessEqual(len(r["items"]), 4)
            seen = r["items"] + seen
            if not r["has_more"]:
                break
            self.assertIsNotNone(r["next_before"])
            before = r["next_before"]
            self.assertLess(pages, 40)
        self.assertGreater(pages, 1)
        key = lambda i: json.dumps(i, sort_keys=True)
        # every item appears; boundary ties may duplicate a divider/handoff but never lose anything
        self.assertEqual({key(i) for i in seen}, {key(i) for i in full["items"]})
        self.assertEqual(self.get("/agents/nope/timeline").status_code, 404)

    def test_timeline_empty_agent(self):
        d = self.get("/agents/sales/timeline").json()
        self.assertEqual((d["items"], d["has_more"], d["next_before"]), ([], False, None))

    # B5
    def test_chat_lookup(self):
        d = self.get("/agents/default/chat").json()
        self.assertEqual(d, {"agent": "default", "profile": "default", "session_id": "bc1", "title": "Bot Chat"})
        d = self.get("/agents/marketing/chat").json()
        self.assertEqual((d["session_id"], d["title"], d["profile"]), (None, None, "marketing"))
        self.assertEqual(self.get("/agents/zzz/chat").status_code, 404)

    def test_direct_function_calls(self):
        """Handlers callable from scripts with every Query param explicit."""
        r = self.m.agent_timeline("default", before=None, limit=150)
        self.assertTrue(r["items"])
        self.assertEqual(self.m.agent_chat("default")["session_id"], "bc1")
        self.assertEqual(len(self.m.conversations(limit=500, agent=None)["conversations"]) > 0, True)



class AutoMessageTest(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("agents_hub_api_auto", API)
        self.m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.m)

    def test_auto_label(self):
        f = self.m.auto_label
        self.assertEqual(f("user", "process_complete", "x"), "Background process finished")
        self.assertEqual(f("user", "weird_new_kind", "x"), "Automatic message")
        self.assertIsNone(f("user", "steer", "[OUT-OF-BAND USER MESSAGE"))
        self.assertIsNone(f("user", "skill_invocation", "x"))
        self.assertIsNone(f("user", None, "Edit giúp mình [IMPORTANT: x]"))
        self.assertEqual(f("user", None, "[CONTEXT COMPACTION — REFERENCE ONLY] ..."), "Context compacted")
        self.assertEqual(f("user", None, "  [INTERNAL NOTIFICATION — generated"), "System notice")
        self.assertIsNone(f("assistant", "process_complete", "x"))

    def test_stale_open_session_not_running(self):
        now = time.time()
        old = {"ended_at": None, "last_activity_at": now - 8 * 3600, "started_at": now - 9 * 3600}
        self.assertEqual(self.m._session_status(old), "stopped")
        self.assertEqual(self.m._session_status({**old, "last_activity_at": now - 60}), "running")

    def test_shape_message_auto_summary_redacted(self):
        row = {"id": 1, "role": "user", "content": "[IMPORTANT: Background process done] token=abc123secret",
               "timestamp": 1.0, "tool_name": None, "tool_call_id": None, "tool_calls": None,
               "display_kind": "process_complete",
               "display_metadata": json.dumps({"display_text": "Background Process Finished: api_key=sk-" + "z" * 20})}
        out = self.m._shape_message(row, "default", "owner")
        self.assertEqual(out["auto"], "Background process finished")
        self.assertIn("Background Process Finished", out["auto_summary"])
        self.assertNotIn("sk-zzzz", out["auto_summary"])
        plain = self.m._shape_message({**row, "content": "chào", "display_kind": None, "display_metadata": None}, "default", "owner")
        self.assertNotIn("auto", plain)


class TeamSetupUsageTest(unittest.TestCase):
    """Team roster + first-run setup, usage cache (never blocks, keeps last good numbers), login guards."""

    def setUp(self):
        root = FIX / "team"
        if root.exists():
            shutil.rmtree(root, ignore_errors=True)
        home = root / "home"
        (home / "profiles" / "writer").mkdir(parents=True)
        (home / "profiles" / "writer" / "profile.yaml").write_text("display_name: Nhà văn\ndescription: Viết bài SEO and social\n", encoding="utf-8")
        (home / "config.yaml").write_text("model:\n  default: m\n  provider: anthropic\n", encoding="utf-8")
        os.environ["HERMES_HOME"] = str(home)
        self.home = home
        spec = importlib.util.spec_from_file_location("agents_hub_api_team", API)
        self.m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.m)

    def test_hidden_profile_dirs_are_not_agents(self):
        for junk in (".deleted", ".media.staging-4242"):
            (self.home / "profiles" / junk).mkdir(parents=True)
        self.m.ensure_setup()
        self.assertNotIn(".deleted", self.m.list_agents())
        # a roster written by an older version that listed .deleted is cleaned up
        team = self.m.load_team()
        team[".deleted"] = {"name": ".deleted", "avatar": "x"}
        self.m._save_team(team)
        self.m.ensure_setup()
        self.assertFalse(any(a.startswith(".") for a in self.m.load_team()))
        self.assertIn("writer", self.m.list_agents())

    def test_health_reports_version(self):
        h = self.m.health()
        self.assertTrue(h["ok"])
        self.assertRegex(h["version"], r"^\d+\.\d+\.\d+$")
        self.assertGreaterEqual(h["agents"], 1)

    def test_staged_image_only_from_agent_cache(self):
        imgs = self.home / "cache" / "images"
        imgs.mkdir(parents=True)
        png = b"\x89PNG\r\n\x1a\n" + b"0" * 32
        (imgs / "upload_abc.png").write_bytes(png)
        r = self.m.staged_image("default", str(imgs / "upload_abc.png"))
        self.assertTrue(r["data_url"].startswith("data:image/png;base64,"))
        outside = self.home / "secret.png"
        outside.write_bytes(png)
        for bad in (str(outside), str(imgs / ".." / ".." / "secret.png"), str(self.home / "config.yaml"), str(imgs / "missing.png")):
            with self.assertRaises(self.m.HTTPException):
                self.m.staged_image("default", bad)
        with self.assertRaises(self.m.HTTPException):
            self.m.staged_image("nobody", str(imgs / "upload_abc.png"))

    def test_first_run_setup_builds_roster(self):
        state = self.m.ensure_setup()
        self.assertEqual(state["version"], self.m.SETUP_VERSION)
        team = self.m.load_team()
        self.assertEqual(team["writer"]["name"], "Nhà văn")  # from profile.yaml
        self.assertEqual(team["writer"]["role"], "Viết bài SEO and social")
        self.assertEqual(team["writer"]["reports_to"], "default")
        self.assertEqual(team["default"]["reports_to"], "Owner")
        self.assertNotEqual(team["writer"]["avatar"], team["default"]["avatar"])
        md = (self.home / "agents-hub" / "TEAM.md").read_text(encoding="utf-8")
        self.assertIn("| `writer` | Nhà văn |", md)
        # edits survive a re-run; avatar re-roll gives a new seed
        old = team["writer"]["avatar"]
        self.m.team_update("writer", {"role": "Content lead", "avatar": "random"})
        self.m.ensure_setup(force=True)
        team = self.m.load_team()
        self.assertEqual(team["writer"]["role"], "Content lead")
        self.assertNotEqual(team["writer"]["avatar"], old)
        cards = {a["id"]: a for a in self.m.agents()["agents"]}
        self.assertEqual((cards["writer"]["name"], cards["writer"]["role"]), ("Nhà văn", "Content lead"))
        self.assertEqual(cards["writer"]["avatar"], team["writer"]["avatar"])

    def test_create_agent_validates(self):
        from fastapi import HTTPException
        for bad in ("", "Bad Name", "default", "x" * 60, "../up"):
            with self.assertRaises(HTTPException):
                self.m.team_create({"id": bad, "role": "r"})
        with self.assertRaises(HTTPException):
            self.m.team_create({"id": "writer", "role": "r"})  # exists

    def test_usage_cache_never_blocks_and_keeps_last_good(self):
        calls = []
        good = {"status": {"logged_in": True}, "usage": {"windows": [{"label": "Session", "used_percent": 10}]}}

        def fake(agent, provider):
            calls.append(provider)
            if len(calls) > 2:
                raise RuntimeError("network down")
            return good

        self.m._fetch_usage_sync = fake
        r = self.m.usage("default", wait=5)
        self.assertEqual([p["usage"]["windows"][0]["used_percent"] for p in r["providers"]], [10, 10])
        self.assertEqual(len(calls), 2)
        r = self.m.usage("default", wait=5)  # fresh: served from cache
        self.assertEqual(len(calls), 2)
        for k in list(self.m._usage_cache):  # make it stale -> refresh fails -> last numbers stay
            self.m._usage_cache[k]["at"] -= self.m.USAGE_TTL_S + 1
        r = self.m.usage("default", wait=5)
        self.assertEqual(len(calls), 4)
        self.assertTrue(all(p["usage"] and p["error"] for p in r["providers"]))
        self.m.usage("default", wait=5)  # cooling down after a failure: no new fetch
        self.assertEqual(len(calls), 4)

    def test_usage_refetches_once_a_window_has_reset(self):
        calls = []
        past = time.time() - 5

        def fake(agent, provider):
            calls.append(provider)
            reset = past if len(calls) <= 2 else time.time() + 3600
            return {"status": {"logged_in": True}, "usage": {"windows": [{"label": "Session", "used_percent": 50, "reset_at": reset}]}}

        self.m._fetch_usage_sync = fake
        self.m.usage("default", wait=5)
        self.assertEqual(len(calls), 2)
        r = self.m.usage("default", wait=5)  # cached < TTL, but the reset time is behind us -> refetch
        self.assertEqual(len(calls), 4)
        self.assertTrue(all(p["usage"]["windows"][0]["reset_at"] > time.time() for p in r["providers"]))
        self.m.usage("default", wait=5)  # fresh again: served from cache
        self.assertEqual(len(calls), 4)

    def test_usage_answers_immediately_while_loading(self):
        import threading
        gate = threading.Event()

        def slow(agent, provider):
            gate.wait(5)
            return {"status": {"logged_in": True}, "usage": None}

        self.m._fetch_usage_sync = slow
        t = time.time()
        r = self.m.usage("default", wait=0)
        self.assertLess(time.time() - t, 1.0)
        self.assertTrue(all(p["loading"] for p in r["providers"]))
        gate.set()

    def test_status_is_scrubbed(self):
        st = self.m._clean_status({"logged_in": True, "token_preview": "sk-a...", "access_token": "x" * 40,
                                   "expires_at": 1793269939568, "last_refresh": "2026-10-21T08:05:15Z"})
        self.assertNotIn("token_preview", st)
        self.assertNotIn("access_token", st)
        self.assertAlmostEqual(st["expires_at_s"], 1793269939.568, places=2)
        self.assertGreater(st["last_refresh_s"], 1.7e9)

    def test_login_code_guard(self):
        from fastapi import HTTPException
        with self.assertRaises(HTTPException):
            self.m.provider_login_code("nope", {"code": "abc"})
        self.m._logins["s1"] = {"kind": "cli", "proc": None}
        with self.assertRaises(HTTPException):
            self.m.provider_login_code("s1", {"code": "a\nb"})

    def test_plugin_skills_listed(self):
        names = [s["name"] for s in self.m._plugin_skills()]
        self.assertIn("agents-hub:hub-operating", names)
        self.assertIn("agents-hub:team-coordination", names)



class InstallerScriptTest(unittest.TestCase):
    """install.ps1 must survive `irm ... | iex`: no BOM (it hides the first token), ASCII only,
    no top-level param() block, and no `exit` (under iex it would close the user's PowerShell)."""

    PS1 = API.parent.parent / "install.ps1"

    @unittest.skipUnless((API.parent.parent / "install.ps1").exists(), "installer ships in the repo only")
    def test_install_ps1_is_iex_safe(self):
        import re
        raw = self.PS1.read_bytes()
        self.assertFalse(raw.startswith(b"\xef\xbb\xbf"), "UTF-8 BOM breaks irm | iex")
        raw.decode("ascii")  # raises on any non-ASCII byte
        code = [l for l in raw.decode("ascii").splitlines() if l.strip() and not l.lstrip().startswith("#")]
        self.assertFalse(code[0].lstrip().lower().startswith("param("), "top-level param() is not iex-safe")
        self.assertFalse(any(re.search(r"(^|[;{\s])exit(\s|$|;)", l) for l in code), "exit would close the user's shell")
        self.assertNotIn("<#", raw.decode("ascii"))


    @unittest.skipUnless((API.parent.parent / "desktop" / "plugin.js").exists(), "desktop half ships in the repo only")
    def test_page_version_matches_plugin_yaml(self):
        import re
        root = API.parent.parent
        page = re.search(r"const PLUGIN_VERSION = '([^']+)'", (root / "desktop" / "plugin.js").read_text(encoding="utf-8"))
        yaml_v = re.search(r"^version:\s*['\"]?([^'\"\s]+)", (root / "plugin.yaml").read_text(encoding="utf-8"), re.M)
        self.assertIsNotNone(page)
        self.assertEqual(page.group(1), yaml_v.group(1), "bump PLUGIN_VERSION in desktop/plugin.js with plugin.yaml")

if __name__ == "__main__":
    unittest.main(verbosity=2)


class WorkspaceTest(unittest.TestCase):
    """/agents/{a}/workspace + /agents/{a}/file: edited files, peers, context folders."""

    @classmethod
    def setUpClass(cls):
        root = FIX / "ws"
        if root.exists():
            shutil.rmtree(root, ignore_errors=True)
        home = root / "home"
        repo = root / "proj"
        loose = root / "loose"
        repo.mkdir(parents=True)
        loose.mkdir(parents=True)
        git(repo, "init", "-q")
        (repo / "a.txt").write_text("one\ntwo\n")
        git(repo, "add", "a.txt")
        git(repo, "commit", "-qm", "init")
        (repo / "a.txt").write_text("one\nTWO\napi_key = " + SECRET + "\n")
        (repo / "new.py").write_text("print('hi')\n")
        (repo / "private").mkdir()
        (repo / "private" / "k.txt").write_text("secret\n")
        (loose / "notes.md").write_text("ghi chú\n")
        now = time.time()
        a_txt, new_py, priv, notes = (p.as_posix() for p in (repo / "a.txt", repo / "new.py", repo / "private" / "k.txt", loose / "notes.md"))

        def call(cid, name, args):
            return {"id": cid, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}

        sess = ("INSERT INTO sessions (id, source, title, started_at, ended_at, end_reason, parent_session_id, cwd) "
                "VALUES (?,?,?,?,?,?,?,?)")
        msg = "INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, tool_name, timestamp) VALUES (?,?,?,?,?,?,?)"
        prof = home / "profiles" / "dev-frontend"
        prof.mkdir(parents=True)
        (prof / "config.yaml").write_text("model:\n  default: m1\n  provider: p1\nagent:\n  reasoning_effort: high\n"
                                          f"terminal:\n  cwd: {repo.as_posix()}\n")
        make_db(prof / "state.db", "state.db", [
            (sess, ("bot", "desktop", "Bot Chat", now - 500, now - 300, "compression", None, None)),
            (sess, ("bot2", "desktop", None, now - 290, None, None, "bot", loose.as_posix())),
            (sess, ("other", "desktop", "Other", now - 900, now - 800, "cli_close", None, None)),
            (msg, ("bot", "user", "sửa giúp", None, None, None, now - 499)),
            (msg, ("bot", "assistant", "", json.dumps([call("c1", "write_file", {"path": new_py, "content": "print('hi')\n"}),
                                                      call("c2", "patch", {"path": a_txt, "old_string": "two", "new_string": "TWO"})]),
                   None, None, now - 480)),
            (msg, ("bot", "tool", json.dumps({"bytes_written": 12, "resolved_path": new_py}), None, "c1", "write_file", now - 479)),
            (msg, ("bot", "tool", json.dumps({"success": True, "diff": "--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n"}),
                   None, "c2", "patch", now - 478)),
            (msg, ("bot2", "assistant", "", json.dumps([call("c3", "write_file", {"path": notes, "content": "ghi chú\n"}),
                                                       call("c4", "write_file", {"path": priv, "content": "x"}),
                                                       call("c5", "read_file", {"path": a_txt})]), None, None, now - 100)),
            (msg, ("bot2", "tool", json.dumps({"bytes_written": 8}), None, "c3", "write_file", now - 99)),
            (msg, ("bot2", "tool", json.dumps({"error": "denied"}), None, "c4", "write_file", now - 98)),
            (msg, ("other", "assistant", "", json.dumps([call("c9", "write_file", {"path": (loose / "elsewhere.md").as_posix(), "content": "x"})]),
                   None, None, now - 850)),
        ])
        make_db(home / "state.db", "state.db", [
            (sess, ("ceo1", "desktop", "CEO chat", now - 1000, None, None, None, None)),
        ])
        make_db(home / "profiles" / "dev-frontend" / "projects.db", "projects.db", [
            ("INSERT INTO project_folders (project_id, path, label, added_at) VALUES (?,?,?,?)", ("p1", repo.as_posix(), "Dự án X", int(now))),
        ])
        os.environ["HERMES_HOME"] = str(home)
        spec = importlib.util.spec_from_file_location("agents_hub_api_ws", API)
        cls.m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.m)
        cls.home, cls.repo, cls.loose = home, repo, loose
        cls.paths = {"a": a_txt, "new": new_py, "priv": priv, "notes": notes}

    def setUp(self):
        os.environ["HERMES_HOME"] = str(self.home)

    def test_workspace_files(self):
        w = self.m.agent_workspace("dev-frontend", session_id="")
        self.assertEqual(w["session_id"], "bot")
        by = {f["path"]: f for f in w["files"]}
        self.assertEqual(set(by), {self.paths["a"], self.paths["new"], self.paths["priv"], self.paths["notes"]})
        self.assertNotIn((self.loose / "elsewhere.md").as_posix(), by)  # other session not included
        self.assertEqual(by[self.paths["a"]]["status"], "M")
        self.assertEqual((by[self.paths["a"]]["additions"], by[self.paths["a"]]["deletions"]), (1, 1))
        self.assertEqual(by[self.paths["new"]]["status"], "A")
        self.assertEqual(by[self.paths["priv"]]["status"], "hidden")
        self.assertEqual(by[self.paths["priv"]]["failed"], 1)
        self.assertIn(w["files"][0]["path"], (self.paths["notes"], self.paths["priv"]))  # newest session first
        self.assertEqual(w["files_total"], 4)

    def test_workspace_context_and_card(self):
        w = self.m.agent_workspace("dev-frontend", session_id="")
        kinds = [(c["kind"], c["path"]) for c in w["context"]]
        self.assertIn(("cwd", self.loose.as_posix()), kinds)
        self.assertIn(("cwd", self.repo.as_posix()), kinds)
        self.assertEqual(kinds[-1][0], "home")
        self.assertEqual(len({p for _, p in kinds}), len(kinds))  # deduped
        card = next(a for a in self.m.agents()["agents"] if a["id"] == "dev-frontend")
        self.assertEqual((card["model"], card["provider"], card["reasoning_effort"]), ("m1", "p1", "high"))

    def test_file_git_diff_redacted(self):
        r = self.m.agent_file("dev-frontend", path=self.paths["a"], session_id="")
        self.assertEqual(r["diff_source"], "git")
        self.assertIn("+TWO", r["diff"])
        self.assertNotIn(SECRET, r["diff"])
        self.assertNotIn(SECRET, r["content"])
        self.assertTrue(r["exists"])

    def test_file_untracked_and_loose(self):
        r = self.m.agent_file("dev-frontend", path=self.paths["new"], session_id="")
        self.assertIn("+print('hi')", r["diff"])
        r2 = self.m.agent_file("dev-frontend", path=self.paths["notes"], session_id="")
        self.assertEqual(r2["diff_source"], "write")
        self.assertIn("ghi chú", r2["content"])

    def test_file_denied_and_not_touched(self):
        r = self.m.agent_file("dev-frontend", path=self.paths["priv"], session_id="")
        self.assertTrue(r["hidden"])
        self.assertEqual(r["content"], "")
        from fastapi import HTTPException
        with self.assertRaises(HTTPException) as e:
            self.m.agent_file("dev-frontend", path=(self.repo / "a.txt").as_posix() + "x", session_id="")
        self.assertEqual(e.exception.status_code, 404)
        with self.assertRaises(HTTPException):
            self.m.agent_file("dev-frontend", path=(self.home / "config.yaml").as_posix(), session_id="")
        with self.assertRaises(HTTPException):
            self.m.agent_workspace("nobody", session_id="")

    def test_workspace_no_chat(self):
        w = self.m.agent_workspace("default", session_id="")
        self.assertEqual((w["session_id"], w["files"]), (None, []))
        self.assertEqual(w["context"][-1]["kind"], "home")

    def test_peers(self):
        now = time.time()
        sess = ("INSERT INTO sessions (id, source, title, started_at, ended_at, parent_session_id) VALUES (?,?,?,?,?,?)")
        db = self.home / "profiles" / "dev-frontend" / "state.db"
        con = sqlite3.connect(db)
        con.execute(sess, ("x1", "tool", "Nhờ làm giao diện", now - 60, None, None))
        con.commit()
        con.close()
        peers = self.m.chat_peers("dev-frontend", now)
        self.assertEqual([p["agent"] for p in peers], ["default"])
        self.assertEqual(peers[0]["direction"], "in")
        self.assertEqual(peers[0]["doing"], "CEO chat")
        back = self.m.chat_peers("default", now)
        self.assertEqual(back[0]["agent"], "dev-frontend")
        self.assertEqual(back[0]["direction"], "out")


class RollbackActivityTest(unittest.TestCase):
    """/agents/{a}/rollback-files (restore files to a message time) + /agents/{a}/activity."""

    def setUp(self):
        root = FIX / "rb"
        if root.exists():
            shutil.rmtree(root, ignore_errors=True)
        home, d = root / "home", root / "work"
        d.mkdir(parents=True)
        now = time.time()
        self.t_msg = now - 400
        f1, f2, f3, f4 = (d / n for n in ("made.txt", "late.txt", "pre.txt", "drift.txt"))
        f1.write_text("B\n", newline="")          # written "A" before the message, patched A->B after
        f2.write_text("new\n", newline="")        # created after the message
        f3.write_text("keep y\n", newline="")     # pre-existing, patched x->y after
        f4.write_text("edited by hand\n", newline="")  # patched after, then changed outside the chat
        self.f = {k: p.as_posix() for k, p in zip(("made", "late", "pre", "drift"), (f1, f2, f3, f4))}

        def call(cid, name, args):
            return {"id": cid, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}

        sess = ("INSERT INTO sessions (id, source, title, started_at, ended_at, parent_session_id, last_activity_at) "
                "VALUES (?,?,?,?,?,?,?)")
        msg = "INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, tool_name, timestamp) VALUES (?,?,?,?,?,?,?)"
        ok = json.dumps({"success": True})
        prof = home / "profiles" / "dev-frontend"
        make_db(prof / "state.db", "state.db", [
            (sess, ("bot", "desktop", "Bot Chat", now - 900, None, None, now - 100)),
            (sess, ("work1", "tool", "Làm API cho tech-lead", now - 300, None, None, now - 20)),
            (sess, ("stale", "tool", "Việc cũ", now - 9 * 3600, None, None, now - 8 * 3600)),
            (msg, ("bot", "user", "tạo file", None, None, None, now - 800)),
            (msg, ("bot", "assistant", "", json.dumps([call("a1", "write_file", {"path": self.f["made"], "content": "A\n"})]), None, None, now - 790)),
            (msg, ("bot", "tool", ok, None, "a1", "write_file", now - 789)),
            (msg, ("bot", "user", "sửa tiếp", None, None, None, self.t_msg)),
            (msg, ("bot", "assistant", "", json.dumps([
                call("b1", "patch", {"path": self.f["made"], "old_string": "A", "new_string": "B"}),
                call("b2", "write_file", {"path": self.f["late"], "content": "new\n"}),
                call("b3", "patch", {"path": self.f["pre"], "old_string": "x", "new_string": "y"}),
                call("b4", "patch", {"path": self.f["drift"], "old_string": "foo", "new_string": "bar"})]), None, None, now - 390)),
            (msg, ("bot", "tool", ok, None, "b1", "patch", now - 389)),
            (msg, ("bot", "tool", ok, None, "b2", "write_file", now - 388)),
            (msg, ("bot", "tool", ok, None, "b3", "patch", now - 387)),
            (msg, ("bot", "tool", ok, None, "b4", "patch", now - 386)),
            (msg, ("work1", "user", "Làm API timeline", None, None, None, now - 300)),
            (msg, ("work1", "assistant", "Running test", json.dumps([call("w1", "terminal", {"command": "pytest -q"})]), None, None, now - 20)),
            (msg, ("stale", "assistant", "xong", None, None, None, now - 8 * 3600)),
        ])
        os.environ["HERMES_HOME"] = str(home)
        spec = importlib.util.spec_from_file_location("agents_hub_api_rb", API)
        self.m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.m)
        self.home = home

    def test_plan(self):
        r = self.m.rollback_files("dev-frontend", {"since": self.t_msg})
        by = {f["path"]: f["method"] for f in r["files"]}
        self.assertEqual(by, {self.f["made"]: "replay", self.f["late"]: "delete", self.f["pre"]: "reverse", self.f["drift"]: "unknown"})
        self.assertFalse(r["applied"])
        self.assertTrue(all("target" not in f for f in r["files"]))
        self.assertEqual(Path(self.f["made"]).read_text(), "B\n")  # dry run touches nothing

    def test_apply_selected(self):
        r = self.m.rollback_files("dev-frontend", {"since": self.t_msg, "apply": True, "paths": [self.f["made"], self.f["late"], self.f["pre"]]})
        self.assertTrue(all(x["ok"] for x in r["results"]))
        self.assertEqual(Path(self.f["made"]).read_text(), "A\n")
        self.assertFalse(Path(self.f["late"]).exists())
        self.assertEqual(Path(self.f["pre"]).read_text(), "keep x\n")
        self.assertEqual(Path(self.f["drift"]).read_text(), "edited by hand\n")  # not chosen / unknown: untouched
        backups = list(Path(r["backup"]).iterdir())
        self.assertEqual(len(backups), 3)

    def test_activity(self):
        a = self.m.agent_activity("dev-frontend")
        self.assertEqual([i["session_id"] for i in a["items"]], ["work1"])  # chat + stale sessions excluded
        it = a["items"][0]
        self.assertTrue(it["active"])
        self.assertEqual([s["kind"] for s in it["steps"]], ["ask", "tool", "say"])
        self.assertEqual(it["steps"][1]["name"], "terminal")


class GoalsApprovalsScheduleTest(unittest.TestCase):
    """Goals parsed from agent replies + owner edits, file approvals, schedule creation."""

    def setUp(self):
        root = FIX / "goals"
        if root.exists():
            shutil.rmtree(root, ignore_errors=True)
        home, d = root / "home", root / "work"
        d.mkdir(parents=True)
        now = time.time()
        self.f1 = (d / "a.txt").as_posix()
        (d / "a.txt").write_text("x\n")

        def call(cid, name, args):
            return {"id": cid, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}

        sess = "INSERT INTO sessions (id, source, title, started_at, ended_at, parent_session_id) VALUES (?,?,?,?,?,?)"
        msg = "INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, tool_name, timestamp) VALUES (?,?,?,?,?,?,?)"
        up1 = '<hub-goals-update>{"add":[{"title":"Dựng trang Goal","current":true},{"title":"Viết test"}]}</hub-goals-update>'
        up2 = 'Xong phần 1.\n<hub-goals-update>{"done":["g1"]}</hub-goals-update>'
        make_db(home / "profiles" / "dev-frontend" / "state.db", "state.db", [
            (sess, ("bot", "desktop", "Bot Chat", now - 900, None, None)),
            (msg, ("bot", "user", "Làm trang goal\n\n<hub-goals>\nGoals: (none)\n</hub-goals>", None, None, None, now - 800)),
            (msg, ("bot", "assistant", "Đã nhận. " + up1, None, None, None, now - 790)),
            (msg, ("bot", "assistant", "", json.dumps([call("w1", "write_file", {"path": self.f1, "content": "x\n"})]), None, None, now - 700)),
            (msg, ("bot", "tool", json.dumps({"success": True}), None, "w1", "write_file", now - 699)),
            (msg, ("bot", "assistant", up2, None, None, None, now - 600)),
        ])
        os.environ["HERMES_HOME"] = str(home)
        spec = importlib.util.spec_from_file_location("agents_hub_api_goals", API)
        self.m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.m)
        self.home = home

    def test_agent_tags_applied_once_and_hidden(self):
        g = self.m.agent_goals("dev-frontend")
        by = {x["id"]: x for x in g["goals"]}
        self.assertEqual((by["g1"]["status"], by["g2"]["status"]), ("done", "active"))
        self.assertEqual(g["current"], "g2")  # current moves on when it is done
        self.assertEqual([e["action"] for e in g["history"]], ["done", "add", "add"])
        again = self.m.agent_goals("dev-frontend")
        self.assertEqual(len(again["history"]), 3)  # idempotent
        msgs = self.m.conversation_detail("dev-frontend", "bot", limit=50)["messages"]
        joined = " ".join(m["content"] for m in msgs)
        self.assertNotIn("<hub-goals", joined)
        self.assertIn("Làm trang goal", joined)
        self.assertIn("Xong phần 1.", joined)

    def test_owner_actions_and_history(self):
        g = self.m.edit_goals("dev-frontend", {"action": "add", "title": "Tối ưu hiệu năng", "current": True})
        new = next(x for x in g["goals"] if x["title"] == "Tối ưu hiệu năng")
        self.assertEqual(g["current"], new["id"])
        g = self.m.edit_goals("dev-frontend", {"action": "edit", "id": new["id"], "title": "Tối ưu tải trang"})
        self.assertTrue(any(x["title"] == "Tối ưu tải trang" for x in g["goals"]))
        g = self.m.edit_goals("dev-frontend", {"action": "delete", "id": new["id"]})
        self.assertFalse(any(x["id"] == new["id"] for x in g["goals"]))
        self.assertEqual(g["current"], "g2")
        from fastapi import HTTPException
        with self.assertRaises(HTTPException):
            self.m.edit_goals("dev-frontend", {"action": "done", "id": "nope"})
        h = self.m.goals_history(limit=50)
        self.assertEqual(h["events"][0]["action"], "delete")
        self.assertEqual(h["current"][0]["agent"], "dev-frontend")

    def test_approve_hides_until_changed_again(self):
        w = self.m.agent_workspace("dev-frontend", session_id="")
        self.assertEqual([f["path"] for f in w["files"]], [self.f1])
        self.m.approve_files("dev-frontend", {"all": True})
        w = self.m.agent_workspace("dev-frontend", session_id="")
        self.assertEqual((w["files"], w["files_approved"]), ([], 1))
        # rollback planning still sees the file (rewind in chat keeps working)
        self.assertEqual(len(self.m.plan_file_rollback("dev-frontend", time.time() - 750)), 1)
        self.m.approve_files("dev-frontend", {"reset": True})
        self.assertEqual(len(self.m.agent_workspace("dev-frontend", session_id="")["files"]), 1)

    def test_create_schedule_uses_cron_backend(self):
        import asyncio
        seen = {}

        class Body:
            def __init__(self, **kw):
                seen["fields"] = kw

        def create(body, profile):
            seen["profile"] = profile
            return {"id": "j1"}

        async def run_io(fn, *a):
            return fn(*a)

        self.m._cron_backend = lambda: (Body, create, run_io)
        r = asyncio.run(self.m.create_schedule({"agent": "dev-frontend", "name": "Báo cáo", "prompt": "Tổng hợp", "schedule": "0 9 * * *", "deliver": "local", "skills": []}))
        self.assertEqual(r["job"]["id"], "j1")
        self.assertEqual(seen["profile"], "dev-frontend")
        self.assertEqual(seen["fields"], {"name": "Báo cáo", "prompt": "Tổng hợp", "schedule": "0 9 * * *", "deliver": "local"})
        from fastapi import HTTPException
        with self.assertRaises(HTTPException):
            asyncio.run(self.m.create_schedule({"agent": "dev-frontend", "prompt": "x", "schedule": ""}))


class RunningCommandsTest(unittest.TestCase):
    """/commands: pending tool calls (foreground) + live background processes (checkpoint fallback)."""

    def setUp(self):
        root = FIX / "cmds"
        if root.exists():
            shutil.rmtree(root, ignore_errors=True)
        home = root / "home"
        now = time.time()

        def call(cid, name, args):
            return {"id": cid, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}

        sess = ("INSERT INTO sessions (id, source, title, started_at, ended_at, parent_session_id, last_activity_at) "
                "VALUES (?,?,?,?,?,?,?)")
        msg = "INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, tool_name, timestamp) VALUES (?,?,?,?,?,?,?)"
        make_db(home / "profiles" / "dev-frontend" / "state.db", "state.db", [
            (sess, ("live", "desktop", "Bot Chat", now - 100, None, None, now - 5)),
            (sess, ("moved", "desktop", "Đã sang lượt mới", now - 100, None, None, now - 5)),
            (sess, ("old", "desktop", "Cũ", now - 9000, None, None, now - 8000)),
            (msg, ("live", "user", "chạy test", None, None, None, now - 60)),
            (msg, ("live", "assistant", "", json.dumps([call("c1", "terminal", {"command": "npm test"}), call("c2", "read_file", {"path": "a.txt"})]), None, None, now - 50)),
            (msg, ("live", "tool", "ok", None, "c2", "read_file", now - 49)),
            (msg, ("moved", "assistant", "", json.dumps([call("m1", "terminal", {"command": "sleep 99"})]), None, None, now - 50)),
            (msg, ("moved", "user", "bỏ qua, làm việc khác", None, None, None, now - 10)),
            (msg, ("old", "assistant", "", json.dumps([call("o1", "terminal", {"command": "ancient"})]), None, None, now - 8000)),
        ])
        (home / "processes.json").write_text(json.dumps([
            {"session_id": "proc_alive", "command": "python serve.py --token=" + SECRET, "pid": os.getpid(), "pid_scope": "host", "started_at": now - 30, "cwd": "C:/w"},
            {"session_id": "proc_dead", "command": "gone", "pid": 999999, "pid_scope": "host", "started_at": now - 30},
        ]))
        os.environ["HERMES_HOME"] = str(home)
        spec = importlib.util.spec_from_file_location("agents_hub_api_cmds", API)
        self.m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.m)

    def test_commands(self):
        r = self.m.running_commands("")
        by = {i["id"]: i for i in r["items"]}
        self.assertIn("fg:dev-frontend:c1", by)
        self.assertEqual((by["fg:dev-frontend:c1"]["command"], by["fg:dev-frontend:c1"]["visible"]), ("npm test", True))
        self.assertNotIn("fg:dev-frontend:c2", by)  # has a result
        self.assertNotIn("fg:dev-frontend:m1", by)  # a newer user turn abandoned it
        self.assertFalse(any("ancient" in i["command"] for i in r["items"]))  # stale session
        self.assertIn("proc_alive", by)
        self.assertNotIn("proc_dead", by)
        self.assertEqual((by["proc_alive"]["agent"], by["proc_alive"]["visible"]), ("default", False))
        self.assertNotIn(SECRET, by["proc_alive"]["command"])
        self.assertEqual(r["counts"], {"dev-frontend": 1, "default": 1})
        only = self.m.running_commands("dev-frontend")
        self.assertEqual([i["id"] for i in only["items"]], ["fg:dev-frontend:c1"])
        self.assertTrue(all(not k.startswith("_") for i in r["items"] for k in i))
