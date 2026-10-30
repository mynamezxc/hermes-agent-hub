"""Agents Hub backend — FastAPI router mounted at /api/plugins/agents-hub.

Reads Hermes profile state (sqlite opened ``mode=ro``), cron job files, the kanban board and git
working trees.  Writes are limited to: the Hub's own state under ``$HERMES_HOME/agents-hub/``
(goals, approved file changes), ``$HERMES_HOME/agents-hub.json``, new cron jobs through Hermes's
own cron backend, and — only on an explicit owner request — restoring files the agent edited in a
chat (current content is backed up first under ``$HERMES_HOME/backups/agents-hub-rollback/``).
The only subprocess is ``git`` with a list of args (no shell).  Sensitive paths are never
listed/diffed and all returned text is redacted.
"""
from __future__ import annotations

import fnmatch
import hashlib
import asyncio
import difflib
import json
import os
import re
import secrets
import sqlite3
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query, Request

router = APIRouter()

VERSION = "1"
ACTIVE_WINDOW_S = 600
DAY_S = 86400
GIT_TIMEOUT_S = 5
MAX_DIFF_BYTES = 200 * 1024
MAX_CONTENT_CHARS = 4000
DEFAULT_EXTRA_REPOS: list[str] = [p for p in os.environ.get("AGENTS_HUB_EXTRA_REPOS", "").split(os.pathsep) if p]



# ───────────────────────────── security helpers ──────────────────────────────

_REDACTIONS = [
    re.compile(r"EAA[A-Za-z0-9]{20,}"),
    re.compile(r"sk-[A-Za-z0-9_-]{16,}"),
    re.compile(r"(?i)(access_token|api_key|app_secret|password|token)\s*[=:]\s*\S+"),
    re.compile(r"ghp_\w+"),
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}"),
]


def redact(text: Any) -> str:
    """Replace secrets in ``text`` with ``[REDACTED]``."""
    s = "" if text is None else str(text)
    for rx in _REDACTIONS:
        s = rx.sub("[REDACTED]", s)
    return s


_DENY_GLOBS = ["*.dpapi", ".env*", "*token*", "*secret*", "*.pem", "*.key", "auth.json",
               "credentials*", "policy.json", "audit.jsonl", "stop_publishing"]
_DENY_DIRS = {"private"}


def is_denied(path: str) -> bool:
    """True when any component of ``path`` matches the deny-list."""
    parts = [p for p in re.split(r"[\\/]+", path) if p and p != "."]
    for part in parts:
        low = part.lower()
        if low in _DENY_DIRS or any(fnmatch.fnmatchcase(low, g) for g in _DENY_GLOBS):
            return True
    return False


def _safe_rel(path: str) -> str:
    """Validate a repo-relative path; raise 400 on traversal/absolute paths."""
    if not path or "\x00" in path:
        raise HTTPException(400, "invalid path")
    norm = path.replace("\\", "/")
    p = PurePosixPath(norm)
    if norm.startswith("/") or re.match(r"^[A-Za-z]:", norm) or p.is_absolute() or ".." in p.parts:
        raise HTTPException(400, "invalid path")
    return norm


# ───────────────────────────── generic helpers ───────────────────────────────

def hermes_home() -> Path:
    env = os.environ.get("HERMES_HOME")
    if env:
        return Path(env)
    try:
        from hermes_constants import get_hermes_home  # type: ignore
        return Path(get_hermes_home())
    except Exception:
        return Path.home() / "AppData" / "Local" / "hermes"


def _num(v: Any) -> Optional[float]:
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(v)
    except (TypeError, ValueError):
        pass
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def query(db: Path, sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    """Run a read-only query; any failure (missing file/table/column) yields []."""
    if not db.is_file():
        return []
    try:
        uri = "file:" + db.resolve().as_posix().replace("?", "%3f").replace("#", "%23") + "?mode=ro"
        con = sqlite3.connect(uri, uri=True, timeout=2)
        try:
            con.row_factory = sqlite3.Row
            return [dict(r) for r in con.execute(sql, params).fetchall()]
        finally:
            con.close()
    except Exception:
        return []


def _clip(text: Any, n: int = MAX_CONTENT_CHARS) -> str:
    s = redact(text)
    return s if len(s) <= n else s[:n] + "…"


_TEXT_KEYS = ("summary", "result", "text", "content", "output", "message", "error", "stdout")


def _flatten(value: Any, depth: int = 0) -> str:
    """Turn decoded JSON into readable text (prefers summary/result/text fields)."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    if depth < 4 and isinstance(value, list):
        parts = [_flatten(v, depth + 1) for v in value]
        return "\n\n".join(p for p in parts if p)
    if depth < 4 and isinstance(value, dict):
        for k in _TEXT_KEYS:
            if k in value and value[k] not in (None, "", [], {}):
                got = _flatten(value[k], depth + 1)
                if got:
                    return got
    try:
        return json.dumps(value, ensure_ascii=False, indent=2)
    except (TypeError, ValueError):
        return str(value)


def decode_content(raw: Any) -> str:
    """Readable text for a stored message body.

    JSON strings (tool results, ``[{type:'text',text:..}]`` part lists, dicts with
    summary/result/... fields) are decoded; literal ``\\n`` sequences are expanded only
    when the body really was JSON.  Callers redact + clip afterwards.
    """
    if raw is None:
        return ""
    if not isinstance(raw, str):
        return _flatten(raw)
    t = raw.strip()
    if t[:1] in ("{", "[", '"') and t[-1:] in ("}", "]", '"'):
        try:
            val = json.loads(t)
        except ValueError:
            return raw
        text = _flatten(val)
        return text.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\\t", "\t")
    return raw


def root_home() -> Path:
    """ROOT Hermes home, even when the request runs under ``<root>/profiles/<p>``."""
    h = hermes_home()
    try:
        if h.parent.name == "profiles":
            return h.parent.parent
    except (AttributeError, ValueError):
        pass
    return h


def agent_home(agent: str) -> Path:
    h = root_home()
    return h if agent == "default" else h / "profiles" / agent


def list_agents() -> list[str]:
    out = ["default"]
    try:
        for d in sorted((root_home() / "profiles").iterdir()):
            # Hidden dirs are Hermes bookkeeping (.deleted trash, .<name>.staging-<pid> during create), not agents.
            if d.is_dir() and not d.name.startswith(".") and re.fullmatch(r"[A-Za-z0-9_.-]+", d.name):
                out.append(d.name)
    except OSError:
        pass
    return out


def _model_info(home: Path) -> tuple[Optional[str], Optional[str]]:
    """Read model.default / model.provider from config.yaml without touching other keys."""
    try:
        text = (home / "config.yaml").read_text(encoding="utf-8")
    except OSError:
        return None, None
    try:
        import yaml  # type: ignore
        data = yaml.safe_load(text) or {}
        m = data.get("model")
        if isinstance(m, str):
            return m, None
        if isinstance(m, dict):
            return (m.get("default") or m.get("model")), m.get("provider")
        return None, None
    except ImportError:
        pass
    except Exception:
        return None, None
    model = provider = None
    in_block = False
    for line in text.splitlines():
        if re.match(r"^model:\s*(\S.*)?$", line):
            inline = line.split(":", 1)[1].strip().strip("\"'")
            if inline and not inline.startswith("#"):
                return inline, None
            in_block = True
            continue
        if in_block:
            if line and not line[0].isspace() and not line.startswith("#"):
                break
            m = re.match(r"^\s+(default|model|provider):\s*[\"']?([^\"'#\s]+)", line)
            if m:
                if m.group(1) == "provider":
                    provider = provider or m.group(2)
                else:
                    model = model or m.group(2)
    return model, provider


def _mini_yaml(text: str) -> dict[str, Any]:
    """Two-level ``key:`` / ``  sub: scalar`` reader, used only when no YAML library is importable."""
    out: dict[str, Any] = {}
    cur: Optional[dict[str, Any]] = None
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        m = re.match(r"^(\s*)([A-Za-z0-9_.-]+):\s*(.*?)\s*$", line)
        if not m:
            continue
        indent, key, val = len(m.group(1)), m.group(2), m.group(3)
        if val.startswith("#"):
            val = ""
        val = re.sub(r"\s+#.*$", "", val).strip().strip("\"'")
        if indent == 0:
            cur = None
            if val:
                out[key] = val
            else:
                cur = out[key] = {}
        elif cur is not None and val:
            cur.setdefault(key, val)
    return out


def _load_cfg(home: Path) -> dict[str, Any]:
    """config.yaml as a dict ({} when missing or unparsable). Hermes ships ruamel (via hermes_yaml), not PyYAML."""
    try:
        text = (home / "config.yaml").read_text(encoding="utf-8")
    except OSError:
        return {}
    data: Any = None
    for name in ("hermes_yaml", "yaml"):
        try:
            data = __import__(name).safe_load(text)
            break
        except ImportError:
            continue
        except Exception:
            return {}
    else:
        try:
            from ruamel.yaml import YAML  # type: ignore
            data = YAML(typ="safe", pure=True).load(text)
        except ImportError:
            data = _mini_yaml(text)
        except Exception:
            return {}
    return data if isinstance(data, dict) else {}


def _jobs(agent: str) -> list[dict[str, Any]]:
    try:
        data = json.loads((agent_home(agent) / "cron" / "jobs.json").read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return []
    jobs = data.get("jobs") if isinstance(data, dict) else data
    return [j for j in jobs if isinstance(j, dict)] if isinstance(jobs, list) else []


def _state_db(agent: str) -> Path:
    return agent_home(agent) / "state.db"


def _kanban_db() -> Path:
    return root_home() / "kanban.db"


# ───────────────────────────────── agents ────────────────────────────────────

def _agent_card(agent: str, now: float) -> dict[str, Any]:
    home = agent_home(agent)
    db = _state_db(agent)
    name, reports_to = _role(agent)
    role = _role_desc(agent)
    model, provider = _model_info(home)
    since = now - DAY_S
    stats = (query(db, "SELECT COUNT(*) AS n, MAX(started_at) AS last_started FROM sessions") or [{}])[0]
    s24 = (query(db, "SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)),0) AS t "
                     "FROM sessions WHERE started_at > ?", (since,)) or [{}])[0]
    m24 = (query(db, "SELECT COUNT(*) AS n FROM messages WHERE timestamp > ?", (since,)) or [{}])[0]
    last_msg = (query(db, "SELECT MAX(timestamp) AS t FROM messages") or [{}])[0].get("t")
    open_act = (query(db, "SELECT MAX(m.timestamp) AS t FROM messages m JOIN sessions s ON s.id = m.session_id "
                          "WHERE s.ended_at IS NULL") or [{}])[0].get("t")
    last_active = _num(last_msg) or _num(stats.get("last_started"))
    if not db.is_file():
        status = "offline"
    elif open_act is not None and now - float(open_act) < ACTIVE_WINDOW_S:
        status = "active"
    else:
        status = "idle"
    agent_cfg = _load_cfg(home).get("agent")
    effort = agent_cfg.get("reasoning_effort") if isinstance(agent_cfg, dict) else None
    return {
        "id": agent, "name": name, "role": role, "reports_to": reports_to, "avatar": _avatar_seed(agent),
        "model": model, "provider": provider, "reasoning_effort": effort if isinstance(effort, str) and effort else None,
        "status": status, "last_active_at": last_active,
        "sessions_total": int(stats.get("n") or 0), "sessions_24h": int(s24.get("n") or 0),
        "messages_24h": int(m24.get("n") or 0), "tokens_24h": int(s24.get("t") or 0),
        "cron_jobs": len(_jobs(agent)),
    }


@router.get("/health")
def health() -> dict[str, Any]:
    """Liveness + versions. ``version`` is the API version (kept for old callers); ``plugin_version``
    lets the page tell 'gateway still runs an older backend, restart it' from real errors."""
    return {"ok": True, "version": VERSION, "plugin_version": _plugin_version(), "agents": len(list_agents())}


@router.get("/agents")
def agents() -> dict[str, Any]:
    now = time.time()
    try:
        ensure_setup()  # first run on a fresh install: team roster, TEAM.md, avatars
    except Exception:
        pass
    return {"agents": [_agent_card(a, now) for a in list_agents()]}


# ────────────────────────────── conversations ────────────────────────────────

def _find_owner(session_id: str, hint: str) -> Optional[str]:
    """Profile whose state.db holds ``session_id`` (hint profile checked first)."""
    for a in [hint] + [x for x in list_agents() if x != hint]:
        if query(_state_db(a), "SELECT 1 AS x FROM sessions WHERE id = ? LIMIT 1", (session_id,)):
            return a
    return None


STALE_S = 3 * 3600  # an open session with no activity for this long is not running any more


def _session_status(row: dict[str, Any]) -> str:
    if row.get("ended_at") is None:
        last = _num(row.get("last_activity_at")) or _num(row.get("started_at"))
        return "stopped" if last is not None and time.time() - last > STALE_S else "running"
    reason = (row.get("end_reason") or "").lower()
    return "failed" if any(k in reason for k in ("error", "fail", "crash", "orphan", "timeout")) else "done"


def _one_line(text: Any, n: int) -> str:
    return _clip(" ".join(decode_content(text).split()), n)


# A session's first message never changes once it exists, yet every refresh (15 s) asked for it again,
# one query per session (N+1): seconds on a large state.db. Found texts are cached; empty results are
# not, since the first message may simply not be written yet.
_FIRST_CACHE: dict[tuple[str, str, str], str] = {}
_FIRST_CACHE_MAX = 20000


def _first_content(db: Path, session_id: str, roles: str) -> str:
    key = (str(db), session_id, roles)
    hit = _FIRST_CACHE.get(key)
    if hit is not None:
        return hit
    role_sql = "role = 'user'" if roles == "user" else "role IN ('user','assistant')"
    r = query(db, f"SELECT content FROM messages WHERE session_id = ? AND {role_sql} "
                  "AND content IS NOT NULL AND content != '' ORDER BY timestamp, id LIMIT 1", (session_id,))
    text = decode_content(r[0]["content"]) if r else ""
    if text:
        if len(_FIRST_CACHE) >= _FIRST_CACHE_MAX:
            _FIRST_CACHE.clear()
        _FIRST_CACHE[key] = text
    return text


def _first_user_text(db: Path, session_id: str, n: int = 90) -> str:
    text = _first_content(db, session_id, "user")
    return _one_line(text, n) if text else ""


_GENERIC_TITLES = {"tool", "subagent", "oneshot"}


def _clean_title(raw: Any) -> str:
    """``sessions.title`` cleaned for display; '' when empty or a generic word."""
    t = " ".join(str(raw or "").split())
    t = re.sub(r"(?i)^subagent:\s*", "", t).strip()
    if not t or t.lower() in _GENERIC_TITLES:
        return ""
    return _clip(t, 120)


def _conv_title(db: Path, row: dict[str, Any], delegation: bool = True) -> str:
    """Own title, else the first user message, else display name / source."""
    t = _clean_title(row.get("title"))
    if t:
        return t
    t = _first_user_text(db, row["id"])
    if t:
        return t
    return _clip(row.get("display_name") or row.get("source") or row["id"], 120)


def _preview(db: Path, session_id: str) -> str:
    text = _first_content(db, session_id, "chat")
    return _one_line(text, 160) if text else ""


def _session_conv(profile: str, row: dict[str, Any], owners: dict[str, Optional[str]]) -> Optional[dict[str, Any]]:
    """Describe a session as an agent↔agent conversation, or None if it is not one."""
    parent = row.get("parent_session_id")
    source = (row.get("source") or "").lower()
    if parent:
        if parent not in owners:
            owners[parent] = _find_owner(parent, profile)
        from_agent = owners[parent] or profile
        kind = "delegation"
    elif profile != "default" and source in ("tool", "oneshot"):
        from_agent, kind = "default", "cross_profile"
    else:
        return None
    db = _state_db(profile)
    return {
        "id": f"{kind}:{profile}:{row['id']}", "profile": profile, "session_id": row["id"],
        "from_agent": from_agent, "to_agent": profile, "kind": kind,
        "title": _conv_title(db, row, kind == "delegation"),
        "started_at": _num(row.get("started_at")), "ended_at": _num(row.get("ended_at")),
        "status": _session_status(row), "message_count": int(row.get("message_count") or 0),
        "preview": _preview(db, row["id"]),
    }


def _is_compression_child(profile: str, row: dict[str, Any], cache: dict[str, Optional[str]]) -> bool:
    """Compaction continuations reuse parent_session_id but are not delegations."""
    parent = row.get("parent_session_id")
    if not parent:
        return False
    if parent not in cache:
        r = query(_state_db(profile), "SELECT end_reason FROM sessions WHERE id = ?", (parent,))
        cache[parent] = (r[0].get("end_reason") if r else None)
    return (cache[parent] or "").lower() in ("compression", "compressed", "compaction")


def _async_convs(profile: str) -> list[dict[str, Any]]:
    out = []
    for r in query(_state_db(profile), "SELECT * FROM async_delegations ORDER BY dispatched_at DESC LIMIT 200"):
        goal = ""
        for col in ("task_json", "event_json"):
            try:
                goal = (json.loads(r.get(col) or "{}") or {}).get("goal") or ""
            except (ValueError, AttributeError):
                goal = ""
            if goal:
                break
        state = (r.get("state") or "").lower()
        status = "running" if state in ("running", "pending", "dispatched") else (
            "done" if state in ("completed", "done", "delivered") else "failed")
        out.append({
            "id": f"async:{profile}:{r['delegation_id']}", "profile": profile,
            "session_id": f"async:{r['delegation_id']}", "from_agent": profile, "to_agent": "subagent",
            "kind": "delegation", "title": _clip(goal or "Async delegation", 120),
            "started_at": _num(r.get("dispatched_at")), "ended_at": _num(r.get("completed_at")),
            "status": status, "message_count": 2 if r.get("result_json") else 1, "preview": _clip(goal, 160),
        })
    return out


def _kanban_convs() -> list[dict[str, Any]]:
    db = _kanban_db()
    rows = query(db, "SELECT t.id, t.title, t.assignee, t.created_by, t.status, t.created_at, t.completed_at, "
                     "COUNT(c.id) AS n, MIN(c.created_at) AS first_at, MAX(c.created_at) AS last_at, "
                     "COUNT(DISTINCT c.author) AS authors FROM tasks t JOIN task_comments c ON c.task_id = t.id "
                     "GROUP BY t.id ORDER BY last_at DESC LIMIT 200")
    out = []
    for r in rows:
        first = query(db, "SELECT author, body FROM task_comments WHERE task_id = ? ORDER BY created_at, id LIMIT 1",
                      (r["id"],))
        author = first[0]["author"] if first else r.get("created_by")
        assignee = r.get("assignee")
        if not (r["authors"] > 1 or (assignee and author and assignee != author)):
            continue
        status = {"done": "done", "archived": "done"}.get(r.get("status") or "", "running")
        out.append({
            "id": f"kanban:{r['id']}", "profile": "kanban", "session_id": r["id"],
            "from_agent": author or "unknown", "to_agent": assignee or "unassigned", "kind": "kanban",
            "title": _clip(r.get("title"), 120), "started_at": _num(r.get("first_at")),
            "ended_at": _num(r.get("completed_at")), "status": status, "message_count": int(r["n"]),
            "preview": _clip(first[0]["body"], 160) if first else "",
        })
    return out


@router.get("/conversations")
def conversations(limit: int = Query(100, ge=1, le=500), agent: str = Query("")) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    owners: dict[str, Optional[str]] = {}
    for profile in list_agents():
        cache: dict[str, Optional[str]] = {}
        rows = query(_state_db(profile),
                     "SELECT * FROM sessions WHERE parent_session_id IS NOT NULL OR source IN ('tool','oneshot') "
                     "ORDER BY started_at DESC LIMIT 300")
        for row in rows:
            if _is_compression_child(profile, row, cache):
                continue
            conv = _session_conv(profile, row, owners)
            if conv:
                items.append(conv)
        items.extend(_async_convs(profile))
    items.extend(_kanban_convs())
    if agent:
        items = [c for c in items if agent in (c["from_agent"], c["to_agent"], c["profile"])]
    items.sort(key=lambda c: c["started_at"] or 0, reverse=True)
    return {"conversations": items[:limit]}


_SECRET_KEY = re.compile(r"(?i)(token|secret|password|passwd|api[_-]?key|authorization|credential)")
_FILE_TOOLS = {"read_file", "write_file", "patch", "search_files"}


def _clean_args(value: Any, depth: int = 0, key: str = "") -> Any:
    """Redact + clip tool-call arguments (strings ≤600 chars, secret-looking keys masked)."""
    if key and _SECRET_KEY.search(key) and isinstance(value, (str, int, float)):
        return "[REDACTED]"
    if isinstance(value, str):
        return _clip(value, 600)
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    if depth >= 4:
        return _clip(str(value), 600)
    if isinstance(value, list):
        return [_clean_args(v, depth + 1) for v in value[:50]]
    if isinstance(value, dict):
        return {str(k): _clean_args(v, depth + 1, str(k)) for k, v in list(value.items())[:50]}
    return _clip(str(value), 600)


def _first_str(args: dict[str, Any]) -> str:
    for v in args.values():
        if isinstance(v, str) and v.strip():
            return v
    return ""


def tool_summary(name: str, args: dict[str, Any]) -> str:
    """One human line describing a tool call."""
    def s(*keys: str) -> str:
        for k in keys:
            v = args.get(k)
            if isinstance(v, str) and v.strip():
                return v
        return ""

    n = name or "tool"
    low = n.lower()
    text = ""
    if low == "terminal":
        text = s("command", "cmd")
    elif low == "search_files":
        text = s("pattern", "query", "path")
    elif low in _FILE_TOOLS:
        text = s("path", "file_path", "file", "pattern")
    elif low == "web_search":
        text = s("query", "q")
    elif low == "web_extract":
        urls = args.get("urls")
        text = urls[0] if isinstance(urls, list) and urls and isinstance(urls[0], str) else s("url")
    elif low == "delegate_task":
        text = s("goal")
        if not text and isinstance(args.get("tasks"), list) and args["tasks"] and isinstance(args["tasks"][0], dict):
            text = str(args["tasks"][0].get("goal") or "")
        text = _clip(" ".join(text.split()), 160)
    elif low == "skill_view":
        text = s("name")
    elif low.startswith("browser") or low.startswith("mcp"):
        text = f"{n} {_first_str(args)}".strip()
    if not text:
        first = _first_str(args)
        text = f"{n}({_clip(first, 60)}…)" if first else f"{n}()"
    return _clip(" ".join(str(text).split()), 200)


def parse_tool_calls(raw: Any) -> list[dict[str, Any]]:
    """Decode ``messages.tool_calls`` (OpenAI-style JSON) into [{id,name,args,summary}]."""
    if raw in (None, ""):
        return []
    val = raw
    if isinstance(raw, str):
        try:
            val = json.loads(raw)
        except ValueError:
            return []
    if isinstance(val, dict):
        val = val.get("tool_calls") if isinstance(val.get("tool_calls"), list) else [val]
    if not isinstance(val, list):
        return []
    out = []
    for tc in val:
        if not isinstance(tc, dict):
            continue
        fn = tc.get("function") if isinstance(tc.get("function"), dict) else tc
        name = str(fn.get("name") or tc.get("name") or "tool")
        a = fn.get("arguments", fn.get("args", tc.get("args")))
        if isinstance(a, str):
            try:
                a = json.loads(a) if a.strip() else {}
            except ValueError:
                a = {"value": a}
        if not isinstance(a, dict):
            a = {} if a is None else {"value": a}
        out.append({"id": tc.get("id") or tc.get("call_id"), "name": name,
                    "args": _clean_args(a), "summary": tool_summary(name, a)})
    return out


def _msg_columns(db: Path) -> set[str]:
    return {r["name"] for r in query(db, "PRAGMA table_info(messages)")}


def _msg_select(db: Path) -> tuple[str, str]:
    """(select list, visibility clause) tolerant of older schemas.

    Hermes shows rows with ``active = 1 OR compacted = 1`` (_DISPLAY_ACTIVE_CLAUSE in
    hermes_state_messages.py); anything else is hidden.
    """
    cols = _msg_columns(db)
    sel = ["id", "session_id", "role", "content", "tool_name", "timestamp"]
    sel += [c if c in cols else f"NULL AS {c}" for c in ("tool_call_id", "tool_calls", "display_kind", "display_metadata")]
    if "active" in cols and "compacted" in cols:
        clause = " AND (COALESCE(active,1) = 1 OR COALESCE(compacted,0) = 1)"
    elif "active" in cols:
        clause = " AND COALESCE(active,1) = 1"
    else:
        clause = ""
    return ", ".join(sel), clause


# User-role rows the owner did not type: gateway notifications, background results, system notes.
# ``steer`` (an out-of-band message the owner sent mid-turn) and ``skill_invocation`` are the owner's own.
AUTO_KINDS = {
    "process_complete": "Background process finished",
    "internal_notification": "System notice",
    "async_delegation_complete": "Background task result",
    "model_switch": "Model switch",
    "personality_switch": "Personality switch",
    "auto_continue": "Agent continued on its own",
    "hidden": "System note",
}
_AUTO_PREFIXES = (
    ("[CONTEXT COMPACTION", "Context compacted"),
    ("[IMPORTANT: Background process", "Background process finished"),
    ("[IMPORTANT:", "System notice"),
    ("[INTERNAL NOTIFICATION", "System notice"),
    ("[ASYNC DELEGATION", "Background task result"),
    ("[System", "System note"),
    ("[SYSTEM", "System note"),
)


def auto_label(role: str, kind: Any, content: str) -> Optional[str]:
    """Label for a message the owner did not send from the chat box, else None."""
    if role != "user":
        return None
    if isinstance(kind, str) and kind:
        if kind in ("steer", "skill_invocation"):
            return None
        return AUTO_KINDS.get(kind, "Automatic message")
    head = (content or "").lstrip()[:60]
    for prefix, label in _AUTO_PREFIXES:
        if head.startswith(prefix):
            return label
    return None


def _shape_message(r: dict[str, Any], profile: str, owner: str) -> dict[str, Any]:
    role = r.get("role") or ""
    speaker = owner if role == "user" else (r.get("tool_name") or profile) if role == "tool" else profile
    content = _clip(strip_goal_tags(role, decode_content(r.get("content")) or ""))
    kind = r.get("display_kind")
    out = {"id": r["id"], "role": role, "speaker": speaker, "content": content,
           "timestamp": _num(r.get("timestamp")), "tool_name": r.get("tool_name"),
           "tool_call_id": r.get("tool_call_id"),
           "tool_calls": parse_tool_calls(r.get("tool_calls")) if role == "assistant" else [],
           "display_kind": kind if isinstance(kind, str) else None}
    label = auto_label(role, kind, content)
    if label:
        meta: Any = r.get("display_metadata")
        try:
            meta = json.loads(meta) if isinstance(meta, str) else meta
        except ValueError:
            meta = None
        text = meta.get("display_text") if isinstance(meta, dict) else None
        out["auto"] = label
        out["auto_summary"] = redact(_clip(" ".join(str(text or content).split()), 200))
    return out


def _messages_session(profile: str, session_id: str, limit: int, owner: str,
                      before: Optional[float] = None, newest: bool = False) -> list[dict[str, Any]]:
    """Visible messages of one session (system rows skipped), oldest→newest.

    ``newest`` takes the *last* ``limit`` rows (timeline); ``before`` keeps rows older than it.
    """
    db = _state_db(profile)
    sel, clause = _msg_select(db)
    params: list[Any] = [session_id]
    if before is not None:
        clause += " AND timestamp < ?"
        params.append(before)
    order = "DESC" if newest else "ASC"
    rows = query(db, f"SELECT {sel} FROM messages WHERE session_id = ? AND role != 'system'{clause} "
                     f"ORDER BY timestamp {order}, id {order} LIMIT ?", (*params, limit))
    if newest:
        rows.reverse()
    return [_shape_message(r, profile, owner) for r in rows]


def _plugin_version() -> str:
    try:
        text = (Path(__file__).resolve().parent.parent / "plugin.yaml").read_text(encoding="utf-8")
    except OSError:
        return ""
    found = re.search(r"^version:\s*['\"]?([^'\"\s]+)", text, re.M)
    return found.group(1) if found else ""


_IMG_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}
_IMG_MAX_BYTES = 12 * 1024 * 1024


@router.get("/image")
def staged_image(agent: str, path: str) -> dict[str, Any]:
    """An image the owner attached from the Hub, for showing it again in the chat.

    Only files Hermes staged for that agent (``<agent home>/cache/images/``) are served; anything else is 404.
    """
    if agent not in list_agents():
        raise HTTPException(404, "unknown agent")
    try:
        root = (agent_home(agent) / "cache" / "images").resolve()
        target = Path(path).resolve()
        target.relative_to(root)
    except (OSError, ValueError):
        raise HTTPException(404, "not a staged image")
    mime = _IMG_MIME.get(target.suffix.lower())
    if not mime or not target.is_file():
        raise HTTPException(404, "not a staged image")
    data = target.read_bytes()
    if len(data) > _IMG_MAX_BYTES:
        raise HTTPException(413, "image too large")
    import base64
    return {"name": target.name, "data_url": f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"}


@router.get("/conversations/{owner}/{session_id}")
def conversation_detail(owner: str, session_id: str, limit: int = Query(200, ge=1, le=1000)) -> dict[str, Any]:
    # The path segment is deliberately NOT named ``profile``: Hermes binds a route's ``profile`` path
    # parameter as the request's profile scope (it wins over ``?profile=default``), so every detail read
    # for another agent ran in that profile, where Agents Hub is not enabled -> 404 "Plugin not found"
    # ("Conversation not found" on View all); ``kanban`` was answered "Profile 'kanban' does not exist".
    profile = owner
    if profile == "kanban":
        meta = next((c for c in _kanban_convs() if c["session_id"] == session_id), None)
        if not meta:
            raise HTTPException(404, "conversation not found")
        rows = query(_kanban_db(), "SELECT id, author, body, created_at FROM task_comments WHERE task_id = ? "
                                   "ORDER BY created_at, id LIMIT ?", (session_id, limit))
        msgs = [{"id": r["id"], "role": "comment", "speaker": r["author"], "content": _clip(decode_content(r["body"])),
                 "timestamp": _num(r["created_at"]), "tool_name": None, "tool_call_id": None,
                 "tool_calls": []} for r in rows]
        return {"meta": meta, "messages": msgs}
    if profile not in list_agents():
        raise HTTPException(404, "unknown profile")
    if session_id.startswith("async:"):
        meta = next((c for c in _async_convs(profile) if c["session_id"] == session_id), None)
        if not meta:
            raise HTTPException(404, "conversation not found")
        r = query(_state_db(profile), "SELECT event_json, result_json, dispatched_at, completed_at FROM "
                  "async_delegations WHERE delegation_id = ?", (session_id[6:],))[0]
        msgs = [{"id": 1, "role": "user", "speaker": profile, "content": _clip(meta["preview"]),
                 "timestamp": _num(r["dispatched_at"]), "tool_name": None, "tool_call_id": None, "tool_calls": []}]
        if r.get("result_json"):
            msgs.append({"id": 2, "role": "assistant", "speaker": "subagent",
                         "content": _clip(decode_content(r["result_json"])), "timestamp": _num(r["completed_at"]),
                         "tool_name": None, "tool_call_id": None, "tool_calls": []})
        return {"meta": meta, "messages": msgs}
    rows = query(_state_db(profile), "SELECT * FROM sessions WHERE id = ?", (session_id,))
    if not rows:
        raise HTTPException(404, "session not found")
    meta = _session_conv(profile, rows[0], {})
    if meta is None:  # a plain session: still describe it
        row = rows[0]
        meta = {"id": f"session:{profile}:{session_id}", "profile": profile, "session_id": session_id,
                "from_agent": profile, "to_agent": profile, "kind": "delegation",
                "title": _conv_title(_state_db(profile), {**row, "id": session_id}, bool(row.get("parent_session_id"))),
                "started_at": _num(row.get("started_at")), "ended_at": _num(row.get("ended_at")),
                "status": _session_status(row), "message_count": int(row.get("message_count") or 0),
                "preview": _preview(_state_db(profile), session_id)}
    return {"meta": meta, "messages": _messages_session(profile, session_id, limit, meta["from_agent"])}


# ───────────────────────────────── works ─────────────────────────────────────

def _cron_works() -> list[dict[str, Any]]:
    out = []
    for agent in list_agents():
        running = {r["job_id"] for r in query(agent_home(agent) / "cron" / "executions.db",
                                              "SELECT job_id FROM executions WHERE status IN ('claimed','running')")}
        for j in _jobs(agent):
            jid = str(j.get("id", ""))
            if jid in running:
                status = "running"
            elif j.get("enabled") is False or j.get("state") == "paused":
                status = "paused"
            else:
                status = j.get("state") or "scheduled"
            err = j.get("last_error") or ""
            sched = j.get("schedule_display") or (j.get("schedule") or {}).get("expr") or ""
            out.append({"id": f"cron:{agent}:{jid}", "kind": "cron", "title": _clip(j.get("name") or jid, 120),
                        "agent": agent, "status": status, "schedule": _clip(sched, 80),
                        "last_run_at": _num(j.get("last_run_at")), "next_run_at": _num(j.get("next_run_at")),
                        "last_result": _clip(f"{j.get('last_status') or ''} {err}".strip(), 300)})
    return out


def _run_works() -> list[dict[str, Any]]:
    rows = query(_kanban_db(), "SELECT r.id, r.task_id, r.profile, r.status, r.started_at, r.ended_at, r.summary, "
                               "r.error, t.title FROM task_runs r LEFT JOIN tasks t ON t.id = r.task_id "
                               "ORDER BY r.started_at DESC LIMIT 100")
    return [{"id": f"run:{r['id']}", "kind": "run", "title": _clip(r.get("title") or r["task_id"], 120),
             "agent": r.get("profile") or "unknown", "status": r.get("status") or "unknown", "schedule": "",
             "last_run_at": _num(r.get("started_at")), "next_run_at": None,
             "last_result": _clip(r.get("error") or r.get("summary") or "", 300)} for r in rows]


def _delegation_works() -> list[dict[str, Any]]:
    return [{"id": c["id"], "kind": "delegation", "title": c["title"], "agent": c["profile"], "status": "running",
             "schedule": "", "last_run_at": c["started_at"], "next_run_at": None, "last_result": ""}
            for a in list_agents() for c in _async_convs(a) if c["status"] == "running"]


@router.get("/works")
def works() -> dict[str, Any]:
    items = _cron_works() + _run_works() + _delegation_works()
    items.sort(key=lambda w: (w["status"] != "running", -(w["last_run_at"] or 0)))
    return {"works": items}


# ───────────────────────────────── tasks ─────────────────────────────────────

@router.get("/tasks")
def tasks(limit: int = Query(500, ge=1, le=2000)) -> dict[str, Any]:
    db = _kanban_db()
    ccount = {r["task_id"]: r["n"] for r in query(db, "SELECT task_id, COUNT(*) AS n FROM task_comments GROUP BY task_id")}
    rows = query(db, "SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?", (limit,))
    out, counts = [], {}
    for r in rows:
        wp = r.get("workspace_path")
        out.append({"id": r["id"], "title": _clip(r.get("title"), 200), "status": r.get("status"),
                    "priority": r.get("priority") or 0, "assignee": r.get("assignee"),
                    "created_by": r.get("created_by"), "created_at": _num(r.get("created_at")),
                    "started_at": _num(r.get("started_at")), "completed_at": _num(r.get("completed_at")),
                    "workspace_path": None if (wp and is_denied(wp)) else wp, "branch_name": r.get("branch_name"),
                    "comments": int(ccount.get(r["id"], 0))})
        counts[r.get("status")] = counts.get(r.get("status"), 0) + 1
    return {"tasks": out, "counts": counts}


# ───────────────────────────────── changes ───────────────────────────────────

def repo_id(path: str) -> str:
    return hashlib.sha1(path.encode("utf-8")).hexdigest()[:12]


def _norm(p: Path) -> str:
    return p.as_posix()


def _git_root(path: str) -> Optional[Path]:
    """Nearest ancestor (or self) containing ``.git``; never a directory enclosing HERMES_HOME."""
    try:
        p = Path(path).resolve()
    except (OSError, ValueError):
        return None
    home = root_home().resolve()
    for cand in [p, *list(p.parents)[:8]]:
        if (cand / ".git").exists():
            try:
                home.relative_to(cand)
                return None
            except ValueError:
                return cand
    return None


def _extra_repos() -> list[str]:
    cfg = root_home() / "agents-hub.json"
    if not cfg.exists():
        try:
            default = [p for p in DEFAULT_EXTRA_REPOS if (Path(p) / ".git").exists()]
            if default:
                cfg.write_text(json.dumps({"repos": default}, indent=2), encoding="utf-8")
        except OSError:
            pass
    try:
        data = json.loads(cfg.read_text(encoding="utf-8-sig"))
        repos = data.get("repos", []) if isinstance(data, dict) else []
        return [r for r in repos if isinstance(r, str)]
    except (OSError, ValueError):
        return []


_repo_cache: dict[str, Any] = {"at": 0.0, "home": "", "repos": []}


def compute_repos() -> list[dict[str, str]]:
    """Allow-list of git roots: [{id, path, label}] (cached 20 s)."""
    home = str(root_home())
    if _repo_cache["home"] == home and time.time() - _repo_cache["at"] < 20:
        return _repo_cache["repos"]
    cands: list[tuple[str, str]] = []
    for agent in list_agents():
        pdb = agent_home(agent) / "projects.db"
        for r in query(pdb, "SELECT path, label FROM project_folders"):
            cands.append((r["path"], r.get("label") or ""))
        for r in query(pdb, "SELECT root, label FROM discovered_repos"):
            cands.append((r["root"], r.get("label") or ""))
    for r in query(_kanban_db(), "SELECT DISTINCT workspace_path FROM tasks WHERE workspace_path IS NOT NULL"):
        cands.append((r["workspace_path"], ""))
    cands.extend((p, "") for p in _extra_repos())
    seen: dict[str, dict[str, str]] = {}
    for path, label in cands:
        if not path or is_denied(path):
            continue
        root = _git_root(path)
        if root is None:
            continue
        norm = _norm(root)
        if norm not in seen:
            seen[norm] = {"id": repo_id(norm), "path": norm, "label": label or root.name}
    repos = list(seen.values())
    _repo_cache.update(at=time.time(), home=home, repos=repos)
    return repos


def _git(repo: str, *args: str) -> Optional[str]:
    env = {**os.environ, "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0"}
    try:
        p = subprocess.run(["git", "-C", repo, "-c", "core.quotepath=false", "-c", "core.fsmonitor=false",
                            "--no-pager", *args], capture_output=True, timeout=GIT_TIMEOUT_S, env=env, shell=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return p.stdout.decode("utf-8", "replace") if p.returncode == 0 else None


def _read_text_file(path: Path) -> Optional[str]:
    try:
        if path.is_symlink() or not path.is_file():
            return None
        data = path.read_bytes()[: MAX_DIFF_BYTES + 1]
    except OSError:
        return None
    return None if b"\x00" in data[:8192] else data.decode("utf-8", "replace")


def _repo_status(repo: dict[str, str]) -> dict[str, Any]:
    path = repo["path"]
    res: dict[str, Any] = {"id": repo["id"], "path": path, "label": repo["label"], "branch": None,
                           "ahead": 0, "behind": 0, "clean": True, "files": []}
    out = _git(path, "status", "--porcelain=v1", "-b", "-uall")
    if out is None:
        return res
    nums: dict[str, tuple[int, int]] = {}
    numstat = _git(path, "diff", "--numstat", "--no-renames", "--no-ext-diff", "HEAD")
    for line in (numstat or "").splitlines():
        a, _, rest = line.partition("\t")
        d, _, f = rest.partition("\t")
        nums[f] = (int(a) if a.isdigit() else 0, int(d) if d.isdigit() else 0)
    files = []
    for line in out.splitlines():
        if line.startswith("## "):
            head = line[3:]
            m = re.search(r"\[(.*?)\]$", head)
            if m:
                a = re.search(r"ahead (\d+)", m.group(1))
                b = re.search(r"behind (\d+)", m.group(1))
                res["ahead"], res["behind"] = int(a.group(1)) if a else 0, int(b.group(1)) if b else 0
                head = head[: m.start()].strip()
            res["branch"] = head.split("...")[0].removeprefix("No commits yet on ")
            continue
        if len(line) < 4:
            continue
        xy, fpath = line[:2], line[3:]
        if " -> " in fpath:
            fpath = fpath.split(" -> ", 1)[1]
        fpath = fpath.strip('"')
        code = "?" if xy == "??" else "A" if "A" in xy else "D" if "D" in xy else "R" if "R" in xy else "M"
        entry: dict[str, Any] = {"path": fpath, "status": code, "additions": 0, "deletions": 0}
        if is_denied(fpath):
            entry["status"] = "hidden"
        elif code == "?":
            txt = _read_text_file(Path(path) / fpath)
            entry["additions"] = txt.count("\n") + (0 if not txt or txt.endswith("\n") else 1) if txt else 0
        else:
            entry["additions"], entry["deletions"] = nums.get(fpath, (0, 0))
        files.append(entry)
    res["files"], res["clean"] = files, not files
    return res


@router.get("/changes")
def changes() -> dict[str, Any]:
    repos = compute_repos()
    if not repos:
        return {"repos": []}
    with ThreadPoolExecutor(max_workers=4) as pool:
        return {"repos": list(pool.map(_repo_status, repos))}


@router.get("/diff")
def diff(repo: str = Query(...), path: str = Query(...)) -> dict[str, Any]:
    rel = _safe_rel(path)
    match = next((r for r in compute_repos() if r["id"] == repo), None)
    if match is None:
        raise HTTPException(404, "unknown repo")
    if is_denied(rel):
        return {"repo": repo, "path": rel, "diff": "", "truncated": False, "hidden": True}
    root = Path(match["path"])
    target = root / rel
    try:
        target.resolve().relative_to(root.resolve())
    except ValueError:
        raise HTTPException(400, "invalid path")
    if target.is_symlink():
        raise HTTPException(400, "invalid path")
    text = _git(match["path"], "diff", "HEAD", "--no-color", "--no-ext-diff", "--no-textconv", "--", rel) or ""
    if not text and target.is_file():
        untracked = _git(match["path"], "ls-files", "--others", "--exclude-standard", "--", rel)
        if untracked and untracked.strip():
            body = _read_text_file(target)
            if body is None:
                text = f"Binary file {rel} (not shown)\n"
            else:
                lines = body.splitlines()
                text = (f"diff --git a/{rel} b/{rel}\nnew file mode 100644\n--- /dev/null\n+++ b/{rel}\n"
                        f"@@ -0,0 +1,{len(lines)} @@\n" + "".join(f"+{ln}\n" for ln in lines))
    raw = text.encode("utf-8", "replace")
    truncated = len(raw) > MAX_DIFF_BYTES
    if truncated:
        text = raw[:MAX_DIFF_BYTES].decode("utf-8", "ignore")
    return {"repo": repo, "path": rel, "diff": redact(text), "truncated": truncated}


# ───────────────────────────── chat + timeline ───────────────────────────────

BOT_CHAT_TITLE = "Bot Chat"
MAX_TIMELINE_SESSIONS = 60


def _check_agent(agent: str) -> None:
    if agent not in list_agents():
        raise HTTPException(404, "unknown agent")


MAX_PICKER_SESSIONS = 20


def _conversation_groups(agent: str, scan: int = 300) -> list[dict[str, Any]]:
    """The agent's own conversations (one per compression lineage), newest activity first.

    Agent-to-agent sessions (handoffs) and scheduled-job runs are left out: they are not conversations
    the owner switches between. ``latest_id`` is the newest session of the lineage (where to resume).
    """
    db = _state_db(agent)
    rows = query(db, "SELECT * FROM sessions ORDER BY COALESCE(last_activity_at, started_at, 0) DESC, started_at DESC LIMIT ?",
                 (scan,))
    owners: dict[str, Optional[str]] = {}
    groups: dict[str, dict[str, Any]] = {}
    for row in rows:
        root = _lineage_root(agent, row)
        rid = root["id"]
        g = groups.get(rid)
        if g is None:
            if str(root.get("source") or "").lower() == "cron" or _session_conv(agent, root, owners) is not None:
                groups[rid] = {"skip": True}
                continue
            last = _num(row.get("last_activity_at")) or _num(row.get("started_at"))
            groups[rid] = g = {"id": rid, "latest_id": row["id"], "title": _conv_title(db, root),
                               "source": str(root.get("source") or ""), "bot_chat": root.get("title") == BOT_CHAT_TITLE,
                               "started_at": _num(root.get("started_at")), "last_at": last, "message_count": 0}
        if g.get("skip"):
            continue
        g["message_count"] += int(row.get("message_count") or 0)
    out = [g for g in groups.values() if not g.get("skip") and g["message_count"] > 0]
    out.sort(key=lambda g: g["last_at"] or 0, reverse=True)
    return out


@router.get("/agents/{agent}/sessions")
def agent_sessions(agent: str) -> dict[str, Any]:
    """Conversations the owner can switch between in the Hub chat (e.g. a Facebook-triggered one and
    the Desktop one)."""
    _check_agent(agent)
    return {"agent": agent, "sessions": _conversation_groups(agent)[:MAX_PICKER_SESSIONS]}


@router.get("/agents/{agent}/chat")
def agent_chat(agent: str) -> dict[str, Any]:
    """The profile's canonical one-chat session (title exactly ``Bot Chat``)."""
    _check_agent(agent)
    rows = query(_state_db(agent), "SELECT id, title FROM sessions WHERE title = ? "
                                   "ORDER BY COALESCE(last_activity_at, started_at, 0) DESC, started_at DESC LIMIT 1",
                 (BOT_CHAT_TITLE,))
    if not rows:
        return {"agent": agent, "profile": agent, "session_id": None, "title": None}
    return {"agent": agent, "profile": agent, "session_id": rows[0]["id"], "title": rows[0]["title"]}


def _lineage_root(profile: str, row: dict[str, Any]) -> dict[str, Any]:
    """Follow compression parents up to the first session that is not a compression child."""
    cur: dict[str, Any] = row
    cache: dict[str, Optional[str]] = {}
    for _ in range(12):
        if not _is_compression_child(profile, cur, cache):
            return cur
        parent = query(_state_db(profile), "SELECT * FROM sessions WHERE id = ?", (cur.get("parent_session_id"),))
        if not parent:
            return cur
        cur = parent[0]
    return cur


def _handoff_items(agent: str, before: Optional[float]) -> list[dict[str, Any]]:
    out = []
    for c in conversations(limit=500, agent=agent)["conversations"]:
        if c["kind"] == "kanban":
            continue
        at = c["started_at"]
        if before is not None and (at or 0) >= before:
            continue
        direction = "in" if (c["to_agent"] == agent and c["from_agent"] != agent) else "out"
        to_agent = c["to_agent"]
        if c["from_agent"] == agent and to_agent == agent:
            to_agent = "subagent"  # own delegation
        if c["session_id"].startswith("async:"):
            summary = c["preview"]
        else:
            summary = _first_user_text(_state_db(c["profile"]), c["session_id"], 200) or c["preview"]
        out.append({"type": "handoff", "direction": direction, "from_agent": c["from_agent"], "to_agent": to_agent,
                    "profile": c["profile"], "session_id": c["session_id"], "kind": c["kind"], "title": c["title"],
                    "summary": _clip(summary, 200), "status": c["status"], "at": at,
                    "message_count": c["message_count"]})
    return out


@router.get("/agents/{agent}/timeline")
def agent_timeline(agent: str, before: Optional[float] = Query(None),
                   limit: int = Query(150, ge=1, le=500), session: str = Query("")) -> dict[str, Any]:
    """Merged chronological chat timeline for one agent (oldest→newest within the page).

    ``session`` (a conversation's root id, from /sessions) narrows it to that one conversation and its
    compression continuations."""
    _check_agent(agent)
    db = _state_db(agent)
    if not isinstance(before, (int, float)):
        before = None
    if not isinstance(session, str):
        session = ""
    where = " WHERE started_at < ?" if before is not None else ""
    params: tuple = (before,) if before is not None else ()
    if session:
        lineage = _chat_lineage(agent, session)
        if not lineage or lineage[0]["id"] != session:
            raise HTTPException(404, "unknown session")
        sessions = sorted(lineage, key=lambda r: _num(r.get("started_at")) or 0, reverse=True)
        more_sessions = False
    else:
        # Order by last activity, not start time: a long-lived Bot Chat started weeks ago must stay on the first
        # page even after 60+ newer short sessions (cron/tool/subagent); ordering by started_at dropped it, so the
        # owner's chat history vanished from the Hub after every refresh.
        sessions = query(db, f"SELECT * FROM sessions{where} "
                             f"ORDER BY COALESCE(last_activity_at, ended_at, started_at, 0) DESC, started_at DESC LIMIT ?",
                         (*params, MAX_TIMELINE_SESSIONS + 1))
        more_sessions = len(sessions) > MAX_TIMELINE_SESSIONS
    sessions = sessions[:MAX_TIMELINE_SESSIONS]
    # Always merge the Hub's own chat (canonical Bot Chat) with the other sessions of this profile
    # (Messenger/tool triggers, desktop chats, cron): it must never fall out of the session window,
    # or the owner's reply vanishes from the Hub right after the turn ends.
    chat_id = None if session else agent_chat(agent).get("session_id")
    if chat_id and all(r["id"] != chat_id for r in sessions):
        sessions += query(db, "SELECT * FROM sessions WHERE id = ?" + (" AND started_at < ?" if before is not None else ""),
                          (chat_id, *params))
    owners: dict[str, Optional[str]] = {}
    items: list[dict[str, Any]] = []
    for row in sessions:
        sid = row["id"]
        root = _lineage_root(agent, row)
        continuation = root["id"] != sid
        if _session_conv(agent, root, owners) is not None:
            continue  # agent↔agent session (or its compression continuation): shown as a handoff
        msgs = _messages_session(agent, sid, limit, agent, before=before, newest=True)
        if not msgs and (before is None or not _messages_session(agent, sid, 1, agent)):
            continue  # nothing to show (a divider alone is kept when its messages sit in a newer page)
        if not continuation:
            started = _num(row.get("started_at"))
            items.append({"type": "session", "session_id": sid, "profile": agent, "title": _conv_title(db, row),
                          "source": row.get("source"), "started_at": started, "_t": started or 0.0, "_o": 0})
        scheduled = str(row.get("source") or "").lower() == "cron"
        for m in msgs:
            if scheduled and m["role"] == "user" and not m.get("auto"):
                m["auto"] = "Scheduled job"
                m["auto_summary"] = redact(_clip(" ".join(m["content"].split()), 200))
            items.append({"type": "message", "session_id": sid, **m, "_t": m["timestamp"] or 0.0, "_o": 1})
    if not session:  # a picked conversation shows only its own messages
        items.extend({**h, "_t": h["at"] or 0.0, "_o": 0} for h in _handoff_items(agent, before))
    items.sort(key=lambda i: (i["_t"], i["_o"]))
    has_more = more_sessions or len(items) > limit
    page = items[-limit:]
    for i in page:
        i.pop("_t", None)
        i.pop("_o", None)
    next_before: Optional[float] = None
    if has_more:
        if page:
            first = page[0]
            next_before = first.get("timestamp") if first["type"] == "message" else (
                first.get("started_at") if first["type"] == "session" else first.get("at"))
        elif sessions:
            next_before = _num(sessions[-1].get("started_at"))
    return {"agent": agent, "items": page, "has_more": bool(has_more and next_before is not None),
            "next_before": next_before}


# ─────────────────────── chat workspace: files, peers, context ───────────────────────

_EDIT_TOOLS = {"write_file", "patch", "edit_file", "create_file", "str_replace", "apply_patch", "multi_edit"}
_V4A_FILE = re.compile(r"^\*\*\*\s+(Add|Update|Delete)\s+File:\s*(.+?)\s*$", re.M)
MAX_WS_SESSIONS = 40
MAX_WS_FILES = 300
MAX_FILE_BYTES = 200 * 1024


def _norm_path(p: Any) -> str:
    return str(p or "").strip().strip("\"'").replace("\\", "/")


def _path_key(p: str) -> str:
    s = _norm_path(p).rstrip("/")
    return s.lower() if os.name == "nt" else s


def _chat_lineage(agent: str, session_id: Optional[str]) -> list[dict[str, Any]]:
    """The chat session (default: the agent's Bot Chat) plus its compression continuations."""
    db = _state_db(agent)
    if session_id:
        rows = query(db, "SELECT * FROM sessions WHERE id = ?", (session_id,))
    else:
        rows = query(db, "SELECT * FROM sessions WHERE title = ? "
                         "ORDER BY COALESCE(last_activity_at, started_at, 0) DESC LIMIT 1", (BOT_CHAT_TITLE,))
    if not rows:
        return []
    root = _lineage_root(agent, rows[0])
    out, ids, cache = [root], {root["id"]}, {}
    later = query(db, "SELECT * FROM sessions WHERE parent_session_id IS NOT NULL AND started_at >= ? "
                      "ORDER BY started_at ASC LIMIT 500", (root.get("started_at") or 0,))
    for r in later:
        if len(out) >= MAX_WS_SESSIONS:
            break
        if r.get("parent_session_id") in ids and _is_compression_child(agent, r, cache):
            ids.add(r["id"])
            out.append(r)
    return out


def _raw_calls(raw: Any) -> list[tuple[Optional[str], str, dict[str, Any]]]:
    """(id, name, raw args) from ``messages.tool_calls`` without clipping (paths/diffs need full text)."""
    try:
        val = json.loads(raw) if isinstance(raw, str) else raw
    except ValueError:
        return []
    if isinstance(val, dict):
        val = val.get("tool_calls") if isinstance(val.get("tool_calls"), list) else [val]
    out = []
    for tc in val if isinstance(val, list) else []:
        if not isinstance(tc, dict):
            continue
        fn = tc.get("function") if isinstance(tc.get("function"), dict) else tc
        a = fn.get("arguments", fn.get("args", tc.get("args")))
        if isinstance(a, str):
            try:
                a = json.loads(a) if a.strip() else {}
            except ValueError:
                a = {}
        out.append((tc.get("id") or tc.get("call_id"), str(fn.get("name") or tc.get("name") or ""),
                    a if isinstance(a, dict) else {}))
    return out


def _diff_counts(diff: str) -> tuple[int, int]:
    a = d = 0
    for ln in (diff or "").splitlines():
        if ln.startswith("+") and not ln.startswith("+++"):
            a += 1
        elif ln.startswith("-") and not ln.startswith("---"):
            d += 1
    return a, d


def session_file_ops(agent: str, sessions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """File edits (write_file / patch / …) in ``sessions``, oldest first, joined with their results."""
    ids = [s["id"] for s in sessions]
    if not ids:
        return []
    db = _state_db(agent)
    sel, clause = _msg_select(db)
    ph = ",".join("?" * len(ids))
    rows = query(db, f"SELECT {sel} FROM messages WHERE session_id IN ({ph}) AND role IN ('assistant','tool'){clause} "
                     f"ORDER BY timestamp ASC, id ASC", tuple(ids))
    ops: list[dict[str, Any]] = []
    by_call: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        if r.get("role") == "assistant":
            for cid, name, args in _raw_calls(r.get("tool_calls")):
                low = name.lower()
                if low not in _EDIT_TOOLS:
                    continue
                base = {"tool": low, "at": _num(r.get("timestamp")), "session_id": r.get("session_id"),
                        "ok": None, "diff": "", "lines": 0}
                paths = []
                p = args.get("path") or args.get("file_path") or args.get("file")
                if isinstance(p, str) and p.strip():
                    paths.append(p)
                elif isinstance(args.get("patch"), str):
                    paths.extend(m.group(2) for m in _V4A_FILE.finditer(args["patch"]))
                new = []
                for path in paths:
                    op = {**base, "path": _norm_path(path)}
                    if low in ("write_file", "create_file") and isinstance(args.get("content"), str):
                        op["lines"] = args["content"].count("\n") + (0 if args["content"].endswith("\n") else 1)
                    ops.append(op)
                    new.append(op)
                if cid and new:
                    by_call[str(cid)] = new
        else:
            mine = by_call.get(str(r.get("tool_call_id") or ""))
            if not mine:
                continue
            content = r.get("content")
            try:
                res = json.loads(content) if isinstance(content, str) else content
            except ValueError:
                res = None
            for op in mine:
                if isinstance(res, dict):
                    op["ok"] = not res.get("error") and res.get("success", True) is not False
                    if isinstance(res.get("diff"), str) and len(mine) == 1:
                        op["diff"] = res["diff"]
                    rp = res.get("resolved_path")
                    if isinstance(rp, str) and rp and len(mine) == 1:
                        op["path"] = _norm_path(rp)
                else:
                    op["ok"] = not str(content or "").strip().lower().startswith("error")
    return ops


def file_entries(ops: list[dict[str, Any]]) -> list[dict[str, Any]]:
    files: dict[str, dict[str, Any]] = {}
    for op in ops:
        f = files.get(_path_key(op["path"]))
        if f is None:
            f = files[_path_key(op["path"])] = {
                "path": op["path"], "name": PurePosixPath(op["path"]).name, "dir": str(PurePosixPath(op["path"]).parent),
                "ops": 0, "tools": [], "first_at": op["at"], "last_at": op["at"], "additions": 0, "deletions": 0,
                "failed": 0, "first_tool": op["tool"]}
        f["ops"] += 1
        f["path"] = op["path"]
        if op["tool"] not in f["tools"]:
            f["tools"].append(op["tool"])
        f["last_at"] = op["at"] or f["last_at"]
        if op["ok"] is False:
            f["failed"] += 1
        a, d = _diff_counts(op.get("diff") or "")
        f["additions"] += a or op.get("lines", 0)
        f["deletions"] += d
    out = []
    for f in files.values():
        p = Path(f["path"])
        if is_denied(f["path"]):
            status = "hidden"
        elif not p.exists():
            status = "D"
        elif f["first_tool"] in ("write_file", "create_file"):
            status = "A"
        else:
            status = "M"
        f["status"] = status
        f.pop("first_tool", None)
        out.append(f)
    out.sort(key=lambda f: f["last_at"] or 0, reverse=True)
    return out


def _activity(agent: str, now: float) -> dict[str, Any]:
    """What ``agent`` is doing right now: its most recent open session."""
    db = _state_db(agent)
    r = query(db, "SELECT *, last_activity_description AS d, COALESCE(last_activity_at, started_at) AS t "
                  "FROM sessions WHERE ended_at IS NULL ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT 1")
    if not r:
        r = query(db, "SELECT *, NULL AS d, started_at AS t FROM sessions WHERE ended_at IS NULL "
                      "ORDER BY started_at DESC LIMIT 1")
    if not r:
        return {"agent_status": "idle", "doing": "", "activity": "", "doing_at": None}
    t = _num(r[0].get("t"))
    active = t is not None and now - t < ACTIVE_WINDOW_S
    if t is None or now - t > STALE_S:
        return {"agent_status": "idle", "doing": "", "activity": "", "doing_at": t}  # stale open session: not working
    doing = _conv_title(db, r[0])
    return {"agent_status": "active" if active else "idle", "doing": redact(_clip(doing, 160)),
            "activity": redact(_clip(" ".join(str(r[0].get("d") or "").split()), 120)), "doing_at": t}


def chat_peers(agent: str, now: float, limit: int = 12) -> list[dict[str, Any]]:
    known = set(list_agents())
    out: dict[str, dict[str, Any]] = {}
    for c in conversations(limit=300, agent=agent)["conversations"]:
        other = c["to_agent"] if c["from_agent"] == agent else c["from_agent"]
        if not other or other == agent or other not in known:
            continue
        if other in out:
            out[other]["count"] += 1
            if c["status"] == "running":
                out[other]["running"] += 1
            continue
        out[other] = {"agent": other, "name": _role(other)[0], "direction": "out" if c["from_agent"] == agent else "in",
                      "title": c["title"], "status": c["status"], "at": c["started_at"], "kind": c["kind"],
                      "profile": c["profile"], "session_id": c["session_id"], "count": 1,
                      "running": 1 if c["status"] == "running" else 0}
    peers = sorted(out.values(), key=lambda p: (p["running"] > 0, p["at"] or 0), reverse=True)[:limit]
    for p in peers:
        p.update(_activity(p["agent"], now))
    return peers


def chat_context(agent: str, sessions: list[dict[str, Any]], files: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Folders the agent works in: session cwd, terminal.cwd, project folders, touched dirs, its home."""
    home = agent_home(agent)
    out: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(path: Any, kind: str, label: str) -> None:
        if not isinstance(path, str) or not path.strip():
            return
        p = _norm_path(os.path.expandvars(os.path.expanduser(path.strip())))
        k = _path_key(p)
        if not k or k in seen:
            return
        seen.add(k)
        try:
            exists = Path(p).is_dir()
        except OSError:
            exists = False
        out.append({"path": p, "kind": kind, "label": label, "exists": exists, "denied": is_denied(p)})

    for s in reversed(sessions):
        add(s.get("cwd"), "cwd", "Session working folder")
        add(s.get("git_repo_root"), "repo", "Session git repo")
    term = _load_cfg(home).get("terminal")
    if isinstance(term, dict):
        add(term.get("cwd"), "cwd", "Default folder (terminal.cwd)")
    for r in query(home / "projects.db", "SELECT path, label FROM project_folders"):
        add(r.get("path"), "project", r.get("label") or "Project folder")
    counts: dict[str, int] = {}
    for f in files:
        counts[f["dir"]] = counts.get(f["dir"], 0) + 1
    for d, _n in sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[:6]:
        add(d, "touched", "Files edited in this session")
    add(str(home), "home", "Agent profile (HERMES_HOME)")
    return out


@router.get("/agents/{agent}/workspace")
def agent_workspace(agent: str, session_id: str = Query("")) -> dict[str, Any]:
    """Side panel data for one agent's chat: changed files, peer agents, accessible folders."""
    _check_agent(agent)
    now = time.time()
    sessions = _chat_lineage(agent, session_id or None)
    all_files = file_entries(session_file_ops(agent, sessions))
    files, approved = approved_filter(agent, all_files)
    return {"agent": agent, "session_id": sessions[0]["id"] if sessions else None,
            "files": files[:MAX_WS_FILES], "files_total": len(files), "files_approved": approved,
            "peers": chat_peers(agent, now), "context": chat_context(agent, sessions, all_files)}


def _new_file_diff(rel: str, body: str) -> str:
    lines = body.splitlines()
    return (f"diff --git a/{rel} b/{rel}\nnew file mode 100644\n--- /dev/null\n+++ b/{rel}\n"
            f"@@ -0,0 +1,{len(lines)} @@\n" + "".join(f"+{ln}\n" for ln in lines))


def _clip_bytes(text: str) -> tuple[str, bool]:
    raw = text.encode("utf-8", "replace")
    if len(raw) <= MAX_FILE_BYTES:
        return text, False
    return raw[:MAX_FILE_BYTES].decode("utf-8", "ignore"), True


@router.get("/agents/{agent}/file")
def agent_file(agent: str, path: str = Query(...), session_id: str = Query("")) -> dict[str, Any]:
    """Preview + diff of a file this agent edited in the chat (only such files are readable)."""
    _check_agent(agent)
    sessions = _chat_lineage(agent, session_id or None)
    key = _path_key(path)
    mine = [o for o in session_file_ops(agent, sessions) if _path_key(o["path"]) == key]
    if not mine:
        raise HTTPException(404, "file was not edited in this chat")
    norm = mine[-1]["path"]
    ops = [{"tool": o["tool"], "at": o["at"], "ok": o["ok"]} for o in mine]
    base = {"path": norm, "name": PurePosixPath(norm).name, "ops": ops}
    if is_denied(norm) or ".." in PurePosixPath(norm).parts:
        return {**base, "hidden": True, "exists": False, "binary": False, "content": "", "diff": "",
                "content_truncated": False, "diff_truncated": False, "diff_source": "none"}
    p = Path(norm)
    if p.is_symlink():
        raise HTTPException(400, "invalid path")
    exists = p.is_file()
    content = _read_text_file(p) if exists else None
    binary = exists and content is None
    diff, source = "", "none"
    root = _git_root(str(p.parent)) if p.parent.exists() else None
    if root is not None:
        try:
            rel = p.resolve().relative_to(root.resolve()).as_posix()
        except (OSError, ValueError):
            rel = ""
        if rel and not is_denied(rel):
            diff = _git(str(root), "diff", "HEAD", "--no-color", "--no-ext-diff", "--no-textconv", "--", rel) or ""
            if not diff and exists and content is not None:
                untracked = _git(str(root), "ls-files", "--others", "--exclude-standard", "--", rel)
                if untracked and untracked.strip():
                    diff = _new_file_diff(rel, content)
            source = "git" if diff else source
    if not diff:
        diff = "\n".join(o["diff"].rstrip("\n") for o in mine if o.get("diff"))
        source = "session" if diff else source
    if not diff and content is not None and all(o["tool"] in ("write_file", "create_file") for o in mine):
        diff, source = _new_file_diff(PurePosixPath(norm).name, content), "write"
    body, ctrunc = _clip_bytes(content or "")
    diff, dtrunc = _clip_bytes(diff)
    return {**base, "hidden": False, "exists": exists, "binary": binary, "content": redact(body),
            "content_truncated": ctrunc, "diff": redact(diff), "diff_truncated": dtrunc, "diff_source": source}


# ─────────────────────── current work (non-chat sessions) ───────────────────────

MAX_ACTIVITY_STEPS = 12


def _steps(profile: str, session_id: str, n: int = MAX_ACTIVITY_STEPS) -> list[dict[str, Any]]:
    """Last ``n`` meaningful steps of a session: tool calls (one line each) and assistant/user text."""
    out: list[dict[str, Any]] = []
    for m in _messages_session(profile, session_id, 60, profile, newest=True):
        if m["role"] == "assistant":
            for c in m.get("tool_calls") or []:
                out.append({"kind": "tool", "name": c["name"], "text": c["summary"], "at": m["timestamp"]})
            if m["content"].strip():
                out.append({"kind": "say", "text": _clip(" ".join(m["content"].split()), 280), "at": m["timestamp"]})
        elif m["role"] == "user" and not m.get("auto"):
            out.append({"kind": "ask", "text": _clip(" ".join(m["content"].split()), 200), "at": m["timestamp"]})
    return out[-n:]


@router.get("/agents/{agent}/activity")
def agent_activity(agent: str) -> dict[str, Any]:
    """Open sessions of ``agent`` outside its Bot Chat (delegations, cross-profile asks, cron runs) that
    moved in the last few hours, with their latest steps, so the chat view can show what it is doing."""
    _check_agent(agent)
    now = time.time()
    db = _state_db(agent)
    chat_ids = {s["id"] for s in _chat_lineage(agent, None)}
    rows = query(db, "SELECT * FROM sessions WHERE ended_at IS NULL "
                     "ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT 20")
    owners: dict[str, Optional[str]] = {}
    items = []
    for r in rows:
        last = _num(r.get("last_activity_at")) or _num(r.get("started_at"))
        if r["id"] in chat_ids or last is None or now - last > STALE_S:
            continue
        conv = _session_conv(agent, r, owners)
        steps = _steps(agent, r["id"])
        if not steps:
            continue
        items.append({
            "session_id": r["id"], "profile": agent, "title": _conv_title(db, r),
            "source": r.get("source"), "kind": conv["kind"] if conv else "session",
            "from_agent": conv["from_agent"] if conv else None,
            "started_at": _num(r.get("started_at")), "last_at": last,
            "active": now - last < ACTIVE_WINDOW_S,
            "activity": redact(_clip(" ".join(str(r.get("last_activity_description") or "").split()), 120)),
            "steps": steps,
        })
    return {"agent": agent, "items": items[:5]}


# ─────────────────────── file rollback to a chat message ───────────────────────

def _file_raw_ops(agent: str, sessions: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Per-file edit ops (oldest first) with the full raw arguments needed to replay or undo them."""
    ids = [s["id"] for s in sessions]
    if not ids:
        return {}
    db = _state_db(agent)
    sel, clause = _msg_select(db)
    ph = ",".join("?" * len(ids))
    rows = query(db, f"SELECT {sel} FROM messages WHERE session_id IN ({ph}) AND role IN ('assistant','tool'){clause} "
                     f"ORDER BY timestamp ASC, id ASC", tuple(ids))
    by_call: dict[str, dict[str, Any]] = {}
    files: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        if r.get("role") == "assistant":
            for cid, name, args in _raw_calls(r.get("tool_calls")):
                low = name.lower()
                path = args.get("path") or args.get("file_path") or args.get("file")
                if low not in _EDIT_TOOLS or not isinstance(path, str) or not path.strip():
                    continue  # V4A multi-file patches carry no per-file undo data: reported as unknown
                op = {"tool": low, "at": _num(r.get("timestamp")) or 0.0, "ok": None, "path": _norm_path(path),
                      "content": args.get("content") if isinstance(args.get("content"), str) else None,
                      "old": args.get("old_string") if isinstance(args.get("old_string"), str) else None,
                      "new": args.get("new_string") if isinstance(args.get("new_string"), str) else None,
                      "all": bool(args.get("replace_all"))}
                files.setdefault(_path_key(op["path"]), []).append(op)
                if cid:
                    by_call[str(cid)] = op
        else:
            op = by_call.get(str(r.get("tool_call_id") or ""))
            if op is None:
                continue
            content = r.get("content")
            try:
                res = json.loads(content) if isinstance(content, str) else content
            except ValueError:
                res = None
            if isinstance(res, dict):
                op["ok"] = not res.get("error") and res.get("success", True) is not False
                rp = res.get("resolved_path")
                if isinstance(rp, str) and rp:
                    op["path"] = _norm_path(rp)
            else:
                op["ok"] = not str(content or "").strip().lower().startswith("error")
    return {k: [o for o in v if o["ok"] is not False] for k, v in files.items()}


def _apply_patch(text: str, old: Optional[str], new: Optional[str], all_: bool) -> Optional[str]:
    if old is None or new is None or old not in text:
        return None
    return text.replace(old, new) if all_ else text.replace(old, new, 1)


def plan_file_rollback(agent: str, since: float, session_id: Optional[str] = None) -> list[dict[str, Any]]:
    """For each file edited at/after ``since`` in the chat: the content it had just before ``since``.

    method: ``replay`` (rebuilt from an earlier full write + patches), ``reverse`` (later patches undone
    on the current file), ``delete`` (first created after ``since``, untracked), or ``unknown``.
    """
    plans = []
    for ops in _file_raw_ops(agent, _chat_lineage(agent, session_id)).values():
        after = [o for o in ops if o["at"] >= since]
        if not after:
            continue
        before = [o for o in ops if o["at"] < since]
        path = after[-1]["path"]
        p = Path(path)
        plan: dict[str, Any] = {"path": path, "name": PurePosixPath(path).name, "ops_after": len(after),
                                "method": "unknown", "reason": "", "target": None}
        if is_denied(path):
            plan["reason"] = "file is on the security deny list"
            plans.append(plan)
            continue
        if p.is_symlink():
            plan["reason"] = "is a symlink"
            plans.append(plan)
            continue
        current = _read_text_file(p) if p.is_file() else None
        writes = [i for i, o in enumerate(before) if o["tool"] in ("write_file", "create_file") and o["content"] is not None]
        if writes:
            text = before[writes[-1]]["content"]
            for o in before[writes[-1] + 1:]:
                nxt = _apply_patch(text, o["old"], o["new"], o["all"]) if o["tool"] != "write_file" else o["content"]
                if nxt is None:
                    text = None
                    break
                text = nxt
            if text is not None:
                plan.update(method="replay", target=text)
        if plan["method"] == "unknown" and current is not None:
            text = current
            for o in reversed(after):
                if o["tool"] in ("write_file", "create_file"):
                    text = None
                    break
                text = _apply_patch(text, o["new"], o["old"], o["all"])
                if text is None:
                    break
            if text is not None:
                plan.update(method="reverse", target=text)
        if plan["method"] == "unknown" and not before and after[0]["tool"] in ("write_file", "create_file"):
            root = _git_root(str(p.parent)) if p.parent.exists() else None
            tracked = False
            if root is not None:
                try:
                    rel = p.resolve().relative_to(root.resolve()).as_posix()
                    tracked = bool((_git(str(root), "ls-files", "--", rel) or "").strip())
                except (OSError, ValueError):
                    tracked = True
            if not tracked:
                plan.update(method="delete")
        if plan["method"] == "unknown":
            plan["reason"] = "not enough session data to rebuild the earlier content (the file may have been edited outside the chat)"
        elif plan["method"] != "delete" and current == plan["target"]:
            plan.update(method="unchanged")
        plans.append(plan)
    return plans


def _backup_dir() -> Path:
    d = root_home() / "backups" / "agents-hub-rollback" / datetime.now().strftime("%Y%m%d-%H%M%S")
    d.mkdir(parents=True, exist_ok=True)
    return d


@router.post("/agents/{agent}/rollback-files")
def rollback_files(agent: str, body: dict[str, Any]) -> dict[str, Any]:
    """Dry run (default) or apply: restore files the agent edited in this chat to their state at ``since``.

    Only files edited by the agent in this chat are touched; current content is backed up first."""
    _check_agent(agent)
    try:
        since = float(body.get("since"))
    except (TypeError, ValueError):
        raise HTTPException(400, "since required")
    session_id = body.get("session_id") if isinstance(body.get("session_id"), str) else None
    plans = plan_file_rollback(agent, since, session_id)
    public = [{k: v for k, v in pl.items() if k != "target"} for pl in plans]
    if not body.get("apply"):
        return {"agent": agent, "since": since, "files": public, "applied": False}
    only = body.get("paths")
    chosen = {_path_key(x) for x in only} if isinstance(only, list) else None
    backup = None
    results = []
    for pl in plans:
        if chosen is not None and _path_key(pl["path"]) not in chosen:
            continue
        res = {"path": pl["path"], "method": pl["method"], "ok": False, "error": ""}
        if pl["method"] in ("unknown", "unchanged"):
            res.update(ok=pl["method"] == "unchanged", error=pl["reason"])
            results.append(res)
            continue
        p = Path(pl["path"])
        try:
            if p.is_file():
                backup = backup or _backup_dir()
                dst = backup / re.sub(r"[:\\/]+", "_", pl["path"]).strip("_")
                dst.write_bytes(p.read_bytes())
            if pl["method"] == "delete":
                if p.is_file():
                    p.unlink()
            else:
                p.parent.mkdir(parents=True, exist_ok=True)
                with open(p, "w", encoding="utf-8", newline="") as fh:
                    fh.write(pl["target"])
            res["ok"] = True
        except OSError as e:
            res["error"] = str(e)
        results.append(res)
    return {"agent": agent, "since": since, "applied": True, "results": results,
            "backup": backup.as_posix() if backup else None}


# ─────────────────────── plugin-owned state (goals, file approvals) ───────────────────────

def _hub_dir(kind: str) -> Path:
    d = root_home() / "agents-hub" / kind
    d.mkdir(parents=True, exist_ok=True)
    return d


def _read_json(path: Path, default: Any) -> Any:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, type(default)) else default
    except (OSError, ValueError):
        return default


_WRITE_LOCKS: dict[str, threading.Lock] = {}
_WRITE_LOCKS_GUARD = threading.Lock()


def _write_json(path: Path, data: Any) -> None:
    """Atomic JSON write that is safe under concurrent requests.

    Each writer gets its own temp file (a shared ``.tmp`` name let one request replace or remove
    another's mid-write), writers of the same file are serialized, and the final replace is retried
    briefly because Windows refuses to replace a file another process (indexer, antivirus) has open.
    """
    with _WRITE_LOCKS_GUARD:
        lock = _WRITE_LOCKS.setdefault(str(path), threading.Lock())
    with lock:
        tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        for attempt in range(8):
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                if attempt == 7:
                    try:
                        tmp.unlink()
                    except OSError:
                        pass
                    raise
                time.sleep(0.05 * (attempt + 1))


# ─────────────────────── goals ───────────────────────
# The agent keeps its goals current by ending a reply with one tag the Hub parses:
#   <hub-goals-update>{"add":[{"title":"…","current":true}],"done":["g1"],"current":"g2",
#                      "edit":[{"id":"g1","title":"…"}],"drop":["g3"]}</hub-goals-update>
# The Hub sends the current list in a <hub-goals>…</hub-goals> block with each message; both
# tags are stripped from what the chat shows.

GOAL_UPDATE_RE = re.compile(r"<hub-goals-update>\s*(.*?)\s*</hub-goals-update>", re.S)
TOOLS_UPDATE_RE = re.compile(r"<hub-tools-update>\s*(.*?)\s*</hub-tools-update>", re.S)
HUB_REPLY_TAGS_RE = re.compile(r"<hub-(goals|tools)-update>.*?</hub-\1-update>", re.S)
GOAL_CTX_RE = re.compile(r"\s*<hub-goals>.*?</hub-goals>\s*", re.S)
MAX_GOALS = 100
MAX_GOAL_HISTORY = 400
GOAL_TITLE_CHARS = 240
# Guards against goal clutter (an agent filing every chat as a goal and leaving it open):
MAX_AGENT_ACTIVE_GOALS = 6   # an agent may not add past this many open goals; the owner may
GOAL_STALE_DAYS = 7          # an open goal untouched this long is flagged (Hub + agent block) to close
GOAL_SIMILAR = 0.85          # a new title this close to an open one is the same goal


def strip_goal_tags(role: str, content: str) -> str:
    if not content or "<hub-" not in content:
        return content
    if role == "user":
        return GOAL_CTX_RE.sub("\n", content).strip()
    return HUB_REPLY_TAGS_RE.sub("", content).strip()


def _goal_state(agent: str) -> dict[str, Any]:
    st = _read_json(_hub_dir("goals") / f"{agent}.json", {})
    st.setdefault("goals", [])
    st.setdefault("current", None)
    st.setdefault("history", [])
    st.setdefault("seq", 0)
    st.setdefault("applied_id", 0)
    return st


def _goal_title(text: Any) -> str:
    return redact(_clip(" ".join(str(text or "").split()), GOAL_TITLE_CHARS))


def _goal_find(st: dict[str, Any], gid: Any) -> Optional[dict[str, Any]]:
    return next((g for g in st["goals"] if g["id"] == str(gid)), None)


def _goal_log(st: dict[str, Any], action: str, g: dict[str, Any], by: str, at: float) -> None:
    st["history"].append({"at": at, "action": action, "goal_id": g["id"], "title": g["title"], "by": by})
    st["history"] = st["history"][-MAX_GOAL_HISTORY:]


def _goal_pick_current(st: dict[str, Any]) -> None:
    cur = _goal_find(st, st.get("current"))
    if cur is None or cur["status"] != "active":
        nxt = next((g for g in st["goals"] if g["status"] == "active"), None)
        st["current"] = nxt["id"] if nxt else None


def apply_goal_update(st: dict[str, Any], upd: dict[str, Any], by: str, at: Optional[float] = None) -> int:
    """Apply one update (agent tag or owner action). Returns the number of changes."""
    at = at or time.time()
    n = 0
    adds = upd.get("add") or []
    adds = adds if isinstance(adds, list) else [adds]
    if by == "agent":
        adds = adds[:1]  # one new goal per reply at most
    for item in adds:
        title = _goal_title(item.get("title") if isinstance(item, dict) else item)
        if not title or len([g for g in st["goals"] if g["status"] == "active"]) >= MAX_GOALS:
            continue
        open_goals = [g for g in st["goals"] if g["status"] == "active"]
        if any(g["title"].lower() == title.lower() for g in open_goals):
            continue  # the agent re-announcing an existing goal
        if by == "agent":
            if len(title.strip(" .…")) < 4 or len(open_goals) >= MAX_AGENT_ACTIVE_GOALS:
                continue  # placeholder title copied from the template, or too many open goals already
            if isinstance(item, dict) and str(item.get("status") or "") in ("done", "dropped"):
                continue  # finished within the same reply: that was a task, not a goal
            if any(difflib.SequenceMatcher(None, g["title"].lower(), title.lower()).ratio() >= GOAL_SIMILAR
                   for g in open_goals):
                continue  # a rewording of an open goal
        st["seq"] += 1
        g = {"id": f"g{st['seq']}", "title": title, "status": "active", "by": by, "created_at": at,
             "updated_at": at, "done_at": None}
        st["goals"].append(g)
        _goal_log(st, "add", g, by, at)
        if isinstance(item, dict) and item.get("current"):
            st["current"] = g["id"]
        n += 1
    for item in upd.get("edit") or []:
        g = _goal_find(st, item.get("id")) if isinstance(item, dict) else None
        title = _goal_title(item.get("title")) if g else ""
        if g and title and title != g["title"]:
            g["title"], g["updated_at"] = title, at
            _goal_log(st, "edit", g, by, at)
            n += 1
    for key, status, action in (("done", "done", "done"), ("drop", "dropped", "drop"), ("reopen", "active", "reopen")):
        ids = upd.get(key) or []
        for gid in ids if isinstance(ids, list) else [ids]:
            g = _goal_find(st, gid)
            if g and g["status"] != status:
                g["status"], g["updated_at"] = status, at
                g["done_at"] = at if status == "done" else None
                _goal_log(st, action, g, by, at)
                n += 1
    for gid in upd.get("delete") or []:
        g = _goal_find(st, gid)
        if g:
            st["goals"].remove(g)
            _goal_log(st, "delete", g, by, at)
            n += 1
    cur = upd.get("current")
    if cur is not None:
        g = _goal_find(st, cur)
        if g and g["status"] == "active" and st.get("current") != g["id"]:
            st["current"] = g["id"]
            _goal_log(st, "current", g, by, at)
            n += 1
    _goal_pick_current(st)
    return n


def _tag_rows(agent: str, tag: str, after_id: int) -> list[dict[str, Any]]:
    """Assistant replies newer than ``after_id`` that carry ``<tag>``, in any of the agent's sessions
    (Bot Chat or a conversation picked in the Hub). Rewound replies are skipped."""
    db = _state_db(agent)
    _sel, clause = _msg_select(db)
    return query(db, f"SELECT id, content, timestamp FROM messages WHERE role = 'assistant' "
                     f"AND id > ? AND content LIKE ?{clause} ORDER BY id", (int(after_id or 0), f"%<{tag}>%"))


def sync_goals(agent: str) -> dict[str, Any]:
    """Apply goal tags from the agent's chat replies not applied yet (rewound replies are inactive)."""
    st = _goal_state(agent)
    rows = _tag_rows(agent, "hub-goals-update", st["applied_id"])
    if not rows:
        return st
    for r in rows:
        for raw in GOAL_UPDATE_RE.findall(decode_content(r.get("content")) or ""):
            try:
                upd = json.loads(raw)
            except ValueError:
                continue
            if isinstance(upd, dict):
                apply_goal_update(st, upd, "agent", _num(r.get("timestamp")))
        st["applied_id"] = max(st["applied_id"], int(r["id"]))
    _write_json(_hub_dir("goals") / f"{agent}.json", st)
    return st


def _goal_idle_days(g: dict[str, Any], now: Optional[float] = None) -> int:
    if g.get("status") != "active":
        return 0
    last = _num(g.get("updated_at")) or _num(g.get("created_at")) or 0
    return int(max(0.0, (now or time.time()) - last) // 86400) if last else 0


def _goals_public(agent: str, st: dict[str, Any]) -> dict[str, Any]:
    order = {"active": 0, "done": 1, "dropped": 2}
    now = time.time()
    goals = [{**g, "idle_days": _goal_idle_days(g, now), "stale": _goal_idle_days(g, now) >= GOAL_STALE_DAYS}
             for g in st["goals"]]
    goals = sorted(goals, key=lambda g: (g["id"] != st.get("current"), order.get(g["status"], 3), -(g["updated_at"] or 0)))
    return {"agent": agent, "current": st.get("current"), "goals": goals, "history": st["history"][-60:][::-1]}


@router.get("/agents/{agent}/goals")
def agent_goals(agent: str) -> dict[str, Any]:
    _check_agent(agent)
    return _goals_public(agent, sync_goals(agent))


@router.post("/agents/{agent}/goals")
def edit_goals(agent: str, body: dict[str, Any]) -> dict[str, Any]:
    """Owner actions: {"action": "add"|"edit"|"done"|"reopen"|"drop"|"delete"|"current", "id"?, "title"?}."""
    _check_agent(agent)
    st = sync_goals(agent)
    action = str(body.get("action") or "")
    gid = body.get("id")
    upd: dict[str, Any] = {
        "add": {"add": [{"title": body.get("title"), "current": bool(body.get("current"))}]},
        "edit": {"edit": [{"id": gid, "title": body.get("title")}]},
        "done": {"done": [gid]}, "reopen": {"reopen": [gid]}, "drop": {"drop": [gid]},
        "delete": {"delete": [gid]}, "current": {"current": gid},
    }.get(action) or {}
    if not upd:
        raise HTTPException(400, "unknown action")
    if action != "add" and _goal_find(st, gid) is None:
        raise HTTPException(404, "goal not found")
    if action in ("add", "edit") and not _goal_title(body.get("title")):
        raise HTTPException(400, "title required")
    apply_goal_update(st, upd, "owner")
    _write_json(_hub_dir("goals") / f"{agent}.json", st)
    return _goals_public(agent, st)


# ─────────────────────── saved tools ───────────────────────
# Tools and apps an agent built that the owner wants to reopen by name ("open the invoice dashboard").
# The agent adds one with a reply tag, the owner can remove it in the side panel:
#   <hub-tools-update>{"add":[{"name":"…","open":"<url or absolute path or command>","note":"…"}],
#                      "remove":["t1"]}</hub-tools-update>

MAX_TOOLS = 30
MAX_AGENT_TOOL_ADDS = 2
TOOL_NAME_CHARS = 80
TOOL_TARGET_CHARS = 600
TOOL_NOTE_CHARS = 200
_WIN_PATH = re.compile(r"^(?:[A-Za-z]:[\\/]|\\\\)")


def _tools_state(agent: str) -> dict[str, Any]:
    st = _read_json(_hub_dir("tools") / f"{agent}.json", {})
    st.setdefault("tools", [])
    st.setdefault("seq", 0)
    st.setdefault("applied_id", 0)
    return st


def _tool_kind(target: str) -> str:
    if re.match(r"^https?://", target, re.I):
        return "url"
    if _WIN_PATH.match(target) or target.startswith(("/", "~/")) or re.match(r"^file://", target, re.I):
        return "path"
    return "command"


def _tool_text(v: Any, n: int) -> str:
    return redact(_clip(" ".join(str(v or "").split()), n))


def apply_tools_update(st: dict[str, Any], upd: dict[str, Any], by: str, at: Optional[float] = None) -> int:
    at = at or time.time()
    n = 0
    adds = upd.get("add") or []
    adds = adds if isinstance(adds, list) else [adds]
    added = 0
    for item in adds:
        if not isinstance(item, dict) or (by == "agent" and added >= MAX_AGENT_TOOL_ADDS):
            continue
        name = _tool_text(item.get("name"), TOOL_NAME_CHARS)
        target = str(item.get("open") or item.get("target") or "").strip()
        if "\n" in target or len(target) > TOOL_TARGET_CHARS:
            continue
        target = redact(target)
        if len(name.strip(" .…")) < 2 or len(target.strip(" .…<>")) < 3:
            continue  # placeholder copied from the template
        note = _tool_text(item.get("note"), TOOL_NOTE_CHARS)
        same = next((t for t in st["tools"] if t["name"].lower() == name.lower() or t["target"] == target), None)
        if same:  # re-adding updates the entry instead of duplicating it
            if (same["name"], same["target"], same["note"]) != (name, target, note or same["note"]):
                same.update(name=name, target=target, kind=_tool_kind(target), note=note or same["note"], updated_at=at)
                n += 1
            continue
        if len(st["tools"]) >= MAX_TOOLS:
            continue
        st["seq"] += 1
        st["tools"].append({"id": f"t{st['seq']}", "name": name, "target": target, "kind": _tool_kind(target),
                            "note": note, "by": by, "added_at": at, "updated_at": at})
        n += 1
        added += 1
    removes = upd.get("remove") or []
    for key in removes if isinstance(removes, list) else [removes]:
        k = str(key or "").lower()
        t = next((t for t in st["tools"] if t["id"] == str(key) or t["name"].lower() == k), None)
        if t:
            st["tools"].remove(t)
            n += 1
    return n


def sync_tools(agent: str) -> dict[str, Any]:
    st = _tools_state(agent)
    rows = _tag_rows(agent, "hub-tools-update", st["applied_id"])
    if not rows:
        return st
    for r in rows:
        for raw in TOOLS_UPDATE_RE.findall(decode_content(r.get("content")) or ""):
            try:
                upd = json.loads(raw)
            except ValueError:
                continue
            if isinstance(upd, dict):
                apply_tools_update(st, upd, "agent", _num(r.get("timestamp")))
        st["applied_id"] = max(st["applied_id"], int(r["id"]))
    _write_json(_hub_dir("tools") / f"{agent}.json", st)
    return st


@router.get("/agents/{agent}/tools")
def agent_tools(agent: str) -> dict[str, Any]:
    _check_agent(agent)
    st = sync_tools(agent)
    return {"agent": agent, "tools": sorted(st["tools"], key=lambda t: -(t.get("updated_at") or 0))}


@router.post("/agents/{agent}/tools")
def edit_tools(agent: str, body: dict[str, Any]) -> dict[str, Any]:
    """Owner actions: {"action": "remove", "id"} or {"action": "add", "name", "open", "note"?}."""
    _check_agent(agent)
    st = sync_tools(agent)
    action = str(body.get("action") or "")
    if action == "remove":
        if not any(t["id"] == str(body.get("id")) for t in st["tools"]):
            raise HTTPException(404, "tool not found")
        apply_tools_update(st, {"remove": [str(body.get("id"))]}, "owner")
    elif action == "add":
        if not apply_tools_update(st, {"add": [{"name": body.get("name"), "open": body.get("open"),
                                                 "note": body.get("note")}]}, "owner"):
            raise HTTPException(400, "name and a URL, path or command are required")
    else:
        raise HTTPException(400, "unknown action")
    _write_json(_hub_dir("tools") / f"{agent}.json", st)
    return agent_tools(agent)


@router.get("/goals/history")
def goals_history(limit: int = Query(100, ge=1, le=MAX_GOAL_HISTORY)) -> dict[str, Any]:
    """Goal events across agents, newest first, plus each agent's current goal (Overview)."""
    events, current = [], []
    for agent in list_agents():
        try:
            st = sync_goals(agent)
        except Exception:  # one broken profile must not hide the others
            continue
        events += [{**e, "agent": agent} for e in st["history"]]
        g = _goal_find(st, st.get("current"))
        if g:
            current.append({"agent": agent, **g, "open": sum(1 for x in st["goals"] if x["status"] == "active")})
    events.sort(key=lambda e: e["at"] or 0, reverse=True)
    return {"events": events[:limit], "current": current}


# ─────────────────────── approved file changes ───────────────────────

def _approvals(agent: str) -> dict[str, float]:
    return _read_json(_hub_dir("approvals") / f"{agent}.json", {})


def approved_filter(agent: str, files: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    """Hide files approved after their last change; a later edit brings a file back."""
    ap = _approvals(agent)
    keep = [f for f in files if (ap.get(_path_key(f["path"])) or 0) < (f.get("last_at") or 0)]
    return keep, len(files) - len(keep)


@router.post("/agents/{agent}/files/approve")
def approve_files(agent: str, body: dict[str, Any]) -> dict[str, Any]:
    """{"paths": [...]} or {"all": true} approves; {"reset": true} shows every change again."""
    _check_agent(agent)
    path = _hub_dir("approvals") / f"{agent}.json"
    if body.get("reset"):
        _write_json(path, {})
        return {"agent": agent, "approved": 0}
    files = file_entries(session_file_ops(agent, _chat_lineage(agent, None)))
    want = None if body.get("all") else {_path_key(p) for p in body.get("paths") or [] if isinstance(p, str)}
    ap = _approvals(agent)
    now = time.time()
    n = 0
    for f in files:
        k = _path_key(f["path"])
        if want is None or k in want:
            ap[k] = max(now, f.get("last_at") or 0)
            n += 1
    _write_json(path, ap)
    return {"agent": agent, "approved": n}


# ─────────────────────── new schedule (same backend as Bots > Scheduled > New) ───────────────────────

SCHEDULE_FIELDS = ("name", "prompt", "schedule", "deliver", "repeat", "skills", "model", "provider", "paused", "workdir")


def _cron_backend():
    from hermes_cli.web_models import CronJobCreate
    from hermes_cli.web_server_cron import _create_cron_job_sync, _run_cron_dashboard_io
    return CronJobCreate, _create_cron_job_sync, _run_cron_dashboard_io


@router.get("/schedules/targets")
async def schedule_targets(agent: str = Query("default")) -> dict[str, Any]:
    targets = [{"id": "local", "name": "Local (save only)", "home_target_set": True}]
    try:
        from hermes_cli.web_routers.cron import get_cron_delivery_targets
        targets = (await get_cron_delivery_targets(agent)).get("targets") or targets
    except Exception:
        pass
    return {"targets": targets}


@router.post("/schedules")
async def create_schedule(body: dict[str, Any]) -> dict[str, Any]:
    agent = str(body.get("agent") or "")
    _check_agent(agent)
    fields = {k: body[k] for k in SCHEDULE_FIELDS if body.get(k) not in (None, "", [])}
    if not str(fields.get("schedule") or "").strip():
        raise HTTPException(400, "schedule required")
    if not str(fields.get("prompt") or "").strip():
        raise HTTPException(400, "prompt required")
    model_cls, create, run_io = _cron_backend()
    job = await run_io(create, model_cls(**fields), agent)
    return {"ok": True, "job": job}


# ─────────────────────── running commands (all agents) ───────────────────────
# Two sources, merged:
#  * foreground: tool calls of a live session that have no result row yet (the agent is waiting on
#    them — "visible" in its chat);
#  * background: processes started with terminal(background=true) — the in-memory process registry
#    when it lives in this process, else each profile's ``processes.json`` checkpoint (pid checked).

RUNNING_TOOL_WINDOW_S = 30 * 60
MAX_CMD_OUTPUT = 6000


def _pid_alive(pid: Any) -> bool:
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        h = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        code = ctypes.c_ulong()
        ok = ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(code))
        ctypes.windll.kernel32.CloseHandle(h)
        return bool(ok) and code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _cmd_text(tool: str, args: dict[str, Any], summary: str) -> str:
    for k in ("command", "cmd", "code", "url", "query", "path", "goal"):
        v = args.get(k)
        if isinstance(v, str) and v.strip():
            return redact(_clip(v.strip(), 600))
    return redact(_clip(summary or tool, 600))


def foreground_commands(agent: str, now: float) -> list[dict[str, Any]]:
    """Tool calls in this agent's open sessions still waiting for their result."""
    db = _state_db(agent)
    sessions = query(db, "SELECT id, title, started_at, last_activity_at FROM sessions WHERE ended_at IS NULL "
                         "AND COALESCE(last_activity_at, started_at) > ? ORDER BY COALESCE(last_activity_at, started_at) DESC "
                         "LIMIT 12", (now - RUNNING_TOOL_WINDOW_S,))
    sel, clause = _msg_select(db)
    out = []
    for s in sessions:
        rows = query(db, f"SELECT {sel} FROM messages WHERE session_id = ? AND role != 'system'{clause} "
                         f"ORDER BY timestamp DESC, id DESC LIMIT 40", (s["id"],))
        done = {r.get("tool_call_id") for r in rows if r.get("role") == "tool"}
        last_asst = next((r for r in rows if r.get("role") == "assistant"), None)
        if not last_asst or rows[0].get("role") == "user":
            continue  # nothing pending, or a newer turn started (older pending calls were abandoned)
        for cid, name, args in _raw_calls(last_asst.get("tool_calls")):
            if not cid or cid in done:
                continue
            calls = parse_tool_calls(json.dumps([{"id": cid, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]))
            out.append({
                "id": f"fg:{agent}:{cid}", "agent": agent, "kind": "foreground", "visible": True,
                "tool": name, "command": _cmd_text(name, args, calls[0]["summary"] if calls else ""),
                "cwd": args.get("workdir") if isinstance(args.get("workdir"), str) else None,
                "started_at": _num(last_asst.get("timestamp")), "session_id": s["id"],
                "session_title": _conv_title(db, s), "pid": None, "background": bool(args.get("background")),
            })
    return out


def _registry_sessions() -> list[Any]:
    mod = sys.modules.get("tools.process_registry")
    reg = getattr(mod, "process_registry", None) if mod else None
    running = getattr(reg, "_running", None)
    if not isinstance(running, dict):
        return []
    try:
        return list(running.values())
    except RuntimeError:  # mutated while copying
        return []


def _session_owner(session_ids: list[str], agents: list[str]) -> Optional[str]:
    ids = [i for i in session_ids if i]
    if not ids:
        return None
    for agent in agents:
        try:
            ph = ",".join("?" * len(ids))
            if query(_state_db(agent), f"SELECT id FROM sessions WHERE id IN ({ph}) LIMIT 1", tuple(ids)):
                return agent
        except Exception:
            continue
    return None


def background_commands(agents: list[str]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out = []
    for p in _registry_sessions():
        if getattr(p, "exited", False):
            continue
        owner = _session_owner([getattr(p, "parent_session_id", ""), getattr(p, "session_key", "")], agents)
        if owner is None:
            continue
        seen.add(p.id)
        out.append({"id": p.id, "agent": owner, "kind": "background", "visible": False, "tool": "terminal",
                    "command": redact(_clip(getattr(p, "command", ""), 600)), "cwd": getattr(p, "cwd", None),
                    "started_at": getattr(p, "started_at", None), "pid": getattr(p, "pid", None),
                    "session_id": getattr(p, "parent_session_id", "") or None, "background": True,
                    "_output": getattr(p, "output_buffer", "") or ""})
    for agent in agents:
        home = agent_home(agent)
        data = _read_json(home / "processes.json", [])
        for e in data if isinstance(data, list) else []:
            pid_ok = e.get("pid_scope", "host") == "host" and _pid_alive(e.get("pid"))
            sid = str(e.get("session_id") or e.get("id") or "")
            if not sid or sid in seen or not pid_ok:
                continue
            seen.add(sid)
            out.append({"id": sid, "agent": agent, "kind": "background", "visible": False, "tool": "terminal",
                        "command": redact(_clip(str(e.get("command") or ""), 600)), "cwd": e.get("cwd"),
                        "started_at": _num(e.get("started_at")), "pid": e.get("pid"),
                        "session_id": e.get("parent_session_id") or None, "background": True,
                        "_log": e.get("output_log") or ""})
    return out


def _tail_file(path: str, n: int) -> str:
    try:
        p = Path(path)
        if not p.is_file() or is_denied(path):
            return ""
        with open(p, "rb") as fh:
            fh.seek(max(0, p.stat().st_size - n))
            return fh.read().decode("utf-8", "replace")
    except OSError:
        return ""


@router.get("/commands")
def running_commands(agent: str = Query("")) -> dict[str, Any]:
    """Commands running now. ``agent`` filters the list; ``counts`` always covers every agent."""
    agents = list_agents()
    if agent and agent not in agents:
        raise HTTPException(404, "unknown agent")
    now = time.time()
    items: list[dict[str, Any]] = []
    for a in agents:
        try:
            items += foreground_commands(a, now)
        except Exception:
            continue
    try:
        items += background_commands(agents)
    except Exception:
        pass
    counts: dict[str, int] = {}
    for it in items:
        counts[it["agent"]] = counts.get(it["agent"], 0) + 1
    shown = [{k: v for k, v in it.items() if not k.startswith("_")} for it in items if not agent or it["agent"] == agent]
    shown.sort(key=lambda x: x.get("started_at") or 0, reverse=True)
    return {"items": shown, "counts": counts}


@router.get("/commands/output")
def command_output(id: str = Query(...)) -> dict[str, Any]:
    """Output tail of one background command (foreground calls have no output until they finish)."""
    for it in background_commands(list_agents()):
        if it["id"] == id:
            text = it.get("_output") or _tail_file(it.get("_log") or "", MAX_CMD_OUTPUT)
            return {"id": id, "output": redact(text[-MAX_CMD_OUTPUT:]), "running": True}
    return {"id": id, "output": "", "running": False}


# ─────────────────────── team (names, roles, avatars) + first-run setup ───────────────────────
# ``<root>/agents-hub/team.json`` is the Hub's team roster: one entry per profile with a display
# name, role, who it reports to, what it is good at and an avatar seed. It is created on first use
# from each profile's ``profile.yaml`` (display_name / description) and never overwritten after
# that, so owners can edit it. ``TEAM.md`` next to it is the same roster for agents to read when
# they coordinate work (regenerated whenever the roster changes).

SETUP_VERSION = 2
OWNER_LABEL = "Owner"


def _team_path() -> Path:
    return _hub_dir("") / "team.json"


def _profile_meta(agent: str) -> dict[str, Any]:
    try:
        from hermes_cli.profiles import read_profile_meta
        meta = read_profile_meta(agent_home(agent))
        return meta if isinstance(meta, dict) else {}
    except Exception:
        data = _mini_yaml((agent_home(agent) / "profile.yaml").read_text(encoding="utf-8")) \
            if (agent_home(agent) / "profile.yaml").is_file() else {}
        return data if isinstance(data, dict) else {}


def _pretty_id(agent: str) -> str:
    return " ".join(w.capitalize() for w in re.split(r"[-_]+", agent) if w) or agent


def _new_team_entry(agent: str) -> dict[str, Any]:
    meta = _profile_meta(agent)
    desc = str(meta.get("description") or "").strip()
    return {
        "name": str(meta.get("display_name") or "").strip() or ("Hermes" if agent == "default" else _pretty_id(agent)),
        "role": _clip(desc.split("\n")[0], 120) if desc else ("Coordinator" if agent == "default" else "Agent"),
        "reports_to": OWNER_LABEL if agent == "default" else "default",
        "capabilities": desc,
        "avatar": secrets.token_hex(4),
    }


def load_team() -> dict[str, dict[str, Any]]:
    data = _read_json(_team_path(), {})
    agents = data.get("agents") if isinstance(data, dict) else None
    return agents if isinstance(agents, dict) else {}


def _save_team(team: dict[str, dict[str, Any]]) -> None:
    _write_json(_team_path(), {"version": 1, "agents": team})
    _write_team_md(team)


def _write_team_md(team: dict[str, dict[str, Any]]) -> None:
    lines = [
        "# Team roster (Agents Hub)",
        "",
        "Generated by Agents Hub from `team.json` — edit the team in the Hub (Settings tab) rather than here.",
        "Hand work to the member whose role/capabilities fit; see the `agents-hub:team-coordination` skill.",
        "",
        "| id | name | role | reports to | model | good at |",
        "|---|---|---|---|---|---|",
    ]
    for agent in list_agents():
        e = team.get(agent) or {}
        model, provider = _model_info(agent_home(agent))
        cap = " ".join(str(e.get("capabilities") or "").split())
        lines.append(f"| `{agent}` | {e.get('name') or agent} | {e.get('role') or ''} | {e.get('reports_to') or ''} | "
                     f"{model or ''}{' (' + provider + ')' if provider else ''} | {_clip(cap, 240)} |")
    lines += ["", "Hand work to a member with the `kanban_create` tool (`assignee` = the id above); Hermes's dispatcher runs it",
              "as that profile, with its own approvals. Never start another agent with a non-interactive `--oneshot` command.", ""]
    p = _hub_dir("") / "TEAM.md"
    text = "\n".join(lines)
    if not p.is_file() or p.read_text(encoding="utf-8") != text:
        p.write_text(text, encoding="utf-8")


def ensure_team() -> dict[str, dict[str, Any]]:
    """Add roster entries for new profiles (random avatar); existing entries are left as edited."""
    team = load_team()
    agents = list_agents()
    missing = [a for a in agents if a not in team]
    # Older versions listed Hermes's hidden profile dirs (.deleted, .<id>.staging-*) as agents: drop them.
    stale = [a for a in team if str(a).startswith(".")]
    for a in stale:
        team.pop(a, None)
    if missing or stale or not (_hub_dir("") / "TEAM.md").is_file():
        for a in missing:
            team[a] = _new_team_entry(a)
        _save_team(team)
    return team


def ensure_setup(force: bool = False) -> dict[str, Any]:
    """First-run (or forced) setup: team roster + TEAM.md + setup marker. Idempotent and cheap."""
    marker = _hub_dir("") / "setup.json"
    state = _read_json(marker, {})
    team = ensure_team()
    if force or state.get("version") != SETUP_VERSION:
        _write_team_md(team)
        state = {"version": SETUP_VERSION, "at": time.time(), "agents": len(team)}
        _write_json(marker, state)
    return state


def _role(agent: str) -> tuple[str, str]:
    """(display name, reports_to) from the team roster."""
    e = load_team().get(agent) or {}
    if not e:
        e = _new_team_entry(agent)
    return str(e.get("name") or agent), str(e.get("reports_to") or ("" if agent == "default" else "default"))


def _role_desc(agent: str) -> str:
    e = load_team().get(agent) or {}
    return str(e.get("role") or "Agent")


def _avatar_seed(agent: str) -> str:
    e = load_team().get(agent) or {}
    return str(e.get("avatar") or agent)


TEAM_FIELDS = ("name", "role", "reports_to", "capabilities")
AGENT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,47}$")


@router.get("/team")
def team_get() -> dict[str, Any]:
    state = ensure_setup()
    team = load_team()
    return {"agents": [{"id": a, **team.get(a, {})} for a in list_agents()], "setup": state,
            "team_md": (_hub_dir("") / "TEAM.md").as_posix(), "skills": _plugin_skills()}


@router.put("/team/{agent}")
def team_update(agent: str, body: dict[str, Any]) -> dict[str, Any]:
    _check_agent(agent)
    team = ensure_team()
    e = dict(team.get(agent) or _new_team_entry(agent))
    for k in TEAM_FIELDS:
        if isinstance(body.get(k), str):
            e[k] = _clip(body[k].strip(), 2000 if k == "capabilities" else 120)
    if body.get("avatar") == "random":
        e["avatar"] = secrets.token_hex(4)
    team[agent] = e
    _save_team(team)
    return {"id": agent, **e}


SOUL_TEMPLATE = """# {name}

You are **{name}** (`{id}`), {role}. You report to: {reports_to}.

## Duties and strengths
{capabilities}

## Working in Agents Hub
- When a message comes through Agents Hub, load the skill `agents-hub:hub-operating` (once per session): how to set and
  update goals, how to edit files so the Hub can track the changes, and how to ask before commands that need approval.
- Need someone else on the team: see the roster at `{team_md}` and the skill `agents-hub:team-coordination`.
- Reply briefly, in the language the owner writes in; say clearly what is verified, what is assumed and what is pending.
"""


@router.post("/team")
def team_create(body: dict[str, Any]) -> dict[str, Any]:
    """Create a new agent (Hermes profile) with a role SOUL.md, roster entry and random avatar.

    The new profile copies config/skills from ``clone_from`` (default: the root profile) so it can use
    the same model login; its SOUL.md is then replaced by one written for the new role."""
    agent = str(body.get("id") or "").strip().lower()
    if not AGENT_ID_RE.match(agent) or agent == "default":
        raise HTTPException(400, "id: lowercase letters, digits, '-' or '_' (max 48 characters)")
    if agent in list_agents():
        raise HTTPException(409, "agent already exists")
    name = _clip(str(body.get("name") or "").strip(), 120) or _pretty_id(agent)
    role = _clip(str(body.get("role") or "").strip(), 120) or "Agent"
    caps = _clip(str(body.get("capabilities") or "").strip(), 2000)
    boss = str(body.get("reports_to") or "default").strip() or "default"
    source = str(body.get("clone_from") or "default").strip()
    if source not in list_agents():
        raise HTTPException(400, "invalid clone_from")
    try:
        from hermes_cli.profiles import create_profile, write_profile_meta
    except Exception as e:  # running outside Hermes
        raise HTTPException(500, f"could not call Hermes profiles: {e}")
    try:
        home = create_profile(agent, clone_from=source, clone_config=True, description=caps or role)
        write_profile_meta(Path(home), display_name=name, description=caps or role)
    except Exception as e:
        raise HTTPException(400, f"creating the profile failed: {redact(str(e))}")
    soul = SOUL_TEMPLATE.format(name=name, id=agent, role=role, reports_to=boss,
                                capabilities=caps or "(not described yet: ask whoever assigns work if the scope is unclear)",
                                team_md=(_hub_dir("") / "TEAM.md").as_posix())
    (Path(home) / "SOUL.md").write_text(soul, encoding="utf-8")
    team = ensure_team()
    team[agent] = {"name": name, "role": role, "reports_to": boss, "capabilities": caps, "avatar": secrets.token_hex(4)}
    _save_team(team)
    return {"id": agent, **team[agent], "home": Path(home).as_posix()}


def _plugin_skills() -> list[dict[str, Any]]:
    root = Path(__file__).resolve().parent.parent / "skills"
    out = []
    for d in sorted(root.glob("*/SKILL.md")) if root.is_dir() else []:
        head = d.read_text(encoding="utf-8")[:600]
        m = re.search(r"^description:\s*(.+)$", head, re.M)
        out.append({"name": f"agents-hub:{d.parent.name}", "description": (m.group(1).strip().strip('"') if m else "")})
    return out


@router.post("/setup")
def setup_run() -> dict[str, Any]:
    state = ensure_setup(force=True)
    return {"setup": state, "team_md": (_hub_dir("") / "TEAM.md").as_posix(), "skills": _plugin_skills()}


# ─────────────────────── provider accounts (login + status) and usage ───────────────────────
# Status and the Codex device-code login go through Hermes's own dashboard OAuth routes (the same
# ones Settings → Accounts uses). Claude (Anthropic) login runs Hermes's own CLI command
# ``hermes [-p <agent>] auth add anthropic`` and feeds it the code the owner pastes. Tokens never
# leave Hermes: only status fields (logged in, expiry, refresh, source) and usage percentages are
# returned; ``token_preview`` is dropped.

HUB_PROVIDERS = ("openai-codex", "anthropic")
PROVIDER_LABEL = {"openai-codex": "Codex", "anthropic": "Claude", "claude-code": "Claude Code", "nous": "Nous Portal"}
USAGE_TTL_S = 2 * 60           # a fresh snapshot is reused this long (the owner watches it during heavy runs)
USAGE_RETRY_S = 60             # after a failed fetch, wait this long before trying again
LOGIN_TTL_S = 15 * 60

_usage_cache: dict[tuple[str, str], dict[str, Any]] = {}
# Bumped on every login for a provider: a fetch that started before the login must not land the old
# account's numbers. Profiles share one login, so a login clears the provider for EVERY agent.
_usage_gen: dict[str, int] = {}
_usage_lock = __import__("threading").Lock()
_logins: dict[str, dict[str, Any]] = {}


def _profile_arg(agent: str) -> Optional[str]:
    return None if agent == "default" else agent


def _oauth_routes():
    from hermes_cli.web_routers import oauth as r
    return r


def _epoch_s(v: Any) -> Optional[float]:
    """Expiry/refresh stamps come as epoch s, epoch ms or ISO strings: normalize to epoch seconds."""
    if isinstance(v, (int, float)) and v > 0:
        return float(v) / 1000.0 if v > 1e11 else float(v)
    if isinstance(v, str) and v.strip():
        try:
            return datetime.fromisoformat(v.strip().replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return None


def _clean_status(st: Any) -> dict[str, Any]:
    st = st if isinstance(st, dict) else {}
    keep = ("logged_in", "source", "source_label", "expires_at", "has_refresh_token", "last_refresh", "error")
    out = {k: st.get(k) for k in keep if k in st}
    if isinstance(out.get("source_label"), str):
        out["source_label"] = redact(out["source_label"])
    out["expires_at_s"] = _epoch_s(st.get("expires_at"))
    out["last_refresh_s"] = _epoch_s(st.get("last_refresh"))
    return out


@router.get("/providers")
async def providers(agent: str = Query("default")) -> dict[str, Any]:
    _check_agent(agent)
    try:
        data = await _oauth_routes().list_oauth_providers(profile=_profile_arg(agent))
    except Exception as e:
        raise HTTPException(502, f"could not read login status: {redact(str(e))}")
    rows = []
    for p in data.get("providers") or []:
        rows.append({"id": p.get("id"), "name": p.get("name"), "flow": p.get("flow"),
                     "cli_command": p.get("cli_command"), "hub": p.get("id") in HUB_PROVIDERS,
                     "label": PROVIDER_LABEL.get(p.get("id"), p.get("name")), "status": _clean_status(p.get("status"))})
    rows.sort(key=lambda r: (not r["hub"], HUB_PROVIDERS.index(r["id"]) if r["hub"] else 0))
    return {"agent": agent, "providers": rows}


def _hermes_argv() -> list[str]:
    exe = Path(sys.executable)
    for cand in (exe.parent / "hermes.exe", exe.parent / "hermes"):
        if cand.is_file():
            return [str(cand)]
    return [sys.executable, "-c", "from hermes_cli.main import main; main()"]


_URL_RE = re.compile(r"https://\S+")


def _gc_logins() -> None:
    now = time.time()
    for sid in [k for k, v in _logins.items() if now - v["started"] > LOGIN_TTL_S]:
        proc = _logins[sid].get("proc")
        if proc and proc.poll() is None:
            proc.kill()
        _logins.pop(sid, None)


def _start_cli_login(agent: str, provider: str) -> dict[str, Any]:
    import threading
    argv = _hermes_argv() + ([] if agent == "default" else ["-p", agent]) + ["auth", "add", provider]
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1", "NO_COLOR": "1"}
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            env=env, creationflags=flags, text=True, encoding="utf-8", errors="replace", bufsize=1)
    sid = secrets.token_urlsafe(12)
    sess = {"id": sid, "agent": agent, "provider": provider, "kind": "cli", "proc": proc, "started": time.time(),
            "lines": [], "url": None, "status": "pending", "needs_code": provider == "anthropic"}

    def pump():
        for line in proc.stdout:
            text = line.rstrip()
            if not sess["url"]:
                m = _URL_RE.search(text)
                if m and ("authorize" in m.group(0) or "oauth" in m.group(0) or "device" in m.group(0)):
                    sess["url"] = m.group(0)
            if text.strip():
                sess["lines"].append(redact(text)[:400])
                sess["lines"] = sess["lines"][-40:]
        code = proc.wait()
        sess["status"] = "approved" if code == 0 else "error"
        sess["exit_code"] = code
        if code == 0:
            _usage_forget(provider)

    threading.Thread(target=pump, daemon=True).start()
    _logins[sid] = sess
    return sess


def _login_public(sess: dict[str, Any]) -> dict[str, Any]:
    keep = ("id", "agent", "provider", "kind", "status", "url", "user_code", "verification_url", "needs_code",
            "exit_code", "error", "expires_in")
    out = {k: sess.get(k) for k in keep if sess.get(k) is not None}
    out["log"] = sess.get("lines", [])[-12:]
    return out


@router.post("/providers/{provider}/login")
async def provider_login(provider: str, request: Request, agent: str = Query("default")) -> dict[str, Any]:
    """Start a login. Codex: Hermes's device-code flow (user code + verification link).
    Claude: Hermes's ``auth add anthropic`` (authorize link, then the pasted code)."""
    _check_agent(agent)
    _gc_logins()
    if provider == "anthropic":
        sess = _start_cli_login(agent, provider)
        for _ in range(40):  # the CLI prints the authorize link within a second or two
            if sess["url"] or sess["status"] != "pending":
                break
            await asyncio.sleep(0.25)
        return _login_public(sess)
    try:
        body = await _oauth_routes().start_oauth_login(provider, request, profile=_profile_arg(agent))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"could not start the login: {redact(str(e))}")
    sid = str(body.get("session_id") or "")
    sess = {"id": sid, "agent": agent, "provider": provider, "kind": "device", "started": time.time(),
            "status": "pending", "user_code": body.get("user_code"),
            "verification_url": body.get("verification_url") or body.get("verification_uri"),
            "expires_in": body.get("expires_in")}
    _logins[sid] = sess
    return _login_public(sess)


@router.get("/providers/login/{sid}")
async def provider_login_poll(sid: str) -> dict[str, Any]:
    sess = _logins.get(sid)
    if not sess:
        raise HTTPException(404, "login session expired")
    if sess["kind"] == "device" and sess["status"] == "pending":
        try:
            r = await _oauth_routes().poll_oauth_session(sess["provider"], sid, profile=_profile_arg(sess["agent"]), wait=0)
            st = str((r or {}).get("status") or "pending")
            sess["status"] = st if st in ("pending", "approved", "error", "expired", "denied", "cancelled") else st
            if (r or {}).get("error_message") or (r or {}).get("error"):
                sess["error"] = redact(str((r or {}).get("error_message") or (r or {}).get("error")))
        except HTTPException as e:
            sess["status"], sess["error"] = "error", str(e.detail)
    if sess["status"] == "approved":
        _usage_forget(sess["provider"])
    return _login_public(sess)


@router.post("/providers/login/{sid}/code")
def provider_login_code(sid: str, body: dict[str, Any]) -> dict[str, Any]:
    """Give the pasted authorization code to the waiting ``hermes auth add`` (never logged or stored)."""
    sess = _logins.get(sid)
    code = str(body.get("code") or "").strip()
    if not sess or sess["kind"] != "cli":
        raise HTTPException(404, "login session expired")
    if not code or "\n" in code or len(code) > 2000:
        raise HTTPException(400, "invalid code")
    proc = sess["proc"]
    if proc.poll() is not None:
        raise HTTPException(409, "the login command already finished")
    proc.stdin.write(code + "\n")
    proc.stdin.flush()
    sess["needs_code"] = False
    return _login_public(sess)


@router.delete("/providers/login/{sid}")
def provider_login_cancel(sid: str) -> dict[str, Any]:
    sess = _logins.pop(sid, None)
    if sess and sess.get("proc") and sess["proc"].poll() is None:
        sess["proc"].kill()
    return {"ok": True}


def _usage_forget(provider: str) -> None:
    """A new login replaces the account for every agent (profiles share the credential pool)."""
    with _usage_lock:
        _usage_gen[provider] = _usage_gen.get(provider, 0) + 1
        for key in [k for k in _usage_cache if k[1] == provider]:
            _usage_cache.pop(key, None)


def _account_sig(provider: str) -> str:
    """Which login the numbers belong to: the pool entry ids in use order (ids only, never a secret).
    It changes when the owner re-authorizes anywhere (Hub, Settings, CLI), so old numbers are dropped."""
    try:
        from agent.credential_pool import load_pool
        entries, _pending = load_pool(provider)._available_entries(clear_expired=False, refresh=False)
        return ",".join(str(getattr(e, "id", "")) for e in entries)
    except Exception:
        return ""


def _snapshot_dict(snap: Any) -> Optional[dict[str, Any]]:
    if snap is None:
        return None

    def iso(d: Any) -> Optional[float]:
        try:
            return d.timestamp() if d else None
        except Exception:
            return None

    return {
        "plan": getattr(snap, "plan", None), "title": getattr(snap, "title", None),
        "windows": [{"label": w.label, "used_percent": w.used_percent, "reset_at": iso(w.reset_at),
                     "detail": w.detail, "scope": getattr(w, "scope", "account")} for w in (snap.windows or ())],
        "details": [redact(d) for d in (snap.details or ())],
        "unavailable": getattr(snap, "unavailable_reason", None),
        "fetched_at": iso(getattr(snap, "fetched_at", None)),
    }


def _fetch_usage_sync(agent: str, provider: str) -> dict[str, Any]:
    """One scoped read of login status + account usage (read-only: never refreshes a token)."""
    from hermes_cli.web_routers._common import _profile_scope
    with _profile_scope(_profile_arg(agent)):
        r = _oauth_routes()
        catalog = {p["id"]: p for p in r._build_oauth_catalog()}

        def status_of(pid: str) -> dict[str, Any]:
            entry = catalog.get(pid)
            return _clean_status(r._resolve_provider_status(pid, entry.get("status_fn") if entry else None))

        status = status_of(provider)
        if provider == "anthropic" and not status.get("logged_in"):
            # Hermes also uses an existing Claude Code login (~/.claude): report that one.
            cc = status_of("claude-code")
            if cc.get("logged_in"):
                status = {**cc, "via": "claude-code"}
        snap = None
        sig = _account_sig(provider)
        if status.get("logged_in"):
            from agent.account_usage import fetch_account_usage
            snap = fetch_account_usage(provider, read_only=True)
    return {"status": status, "usage": _snapshot_dict(snap), "sig": sig}


def _refresh_usage(agent: str, provider: str) -> None:
    key = (agent, provider)
    gen = _usage_gen.get(provider, 0)
    try:
        fresh = _fetch_usage_sync(agent, provider)
        ok = fresh["usage"] is not None or not fresh["status"].get("logged_in")
        with _usage_lock:
            if _usage_gen.get(provider, 0) != gen:  # a login landed meanwhile: these numbers may be the old account's
                _usage_cache.pop(key, None)
                return
            prev = _usage_cache.get(key) or {}
            if prev and prev.get("sig") != fresh.get("sig"):  # another account now: never keep its numbers
                prev = {}
            if ok:
                _usage_cache[key] = {**fresh, "at": time.time(), "error": None, "busy": False}
            else:  # keep the last good numbers; remember the failure
                _usage_cache[key] = {**prev, "status": fresh["status"], "sig": fresh.get("sig"), "at": prev.get("at"),
                                     "failed_at": time.time(),
                                     "error": "Could not fetch usage right now (keeping the last numbers).", "busy": False}
    except Exception as e:
        with _usage_lock:
            prev = _usage_cache.get(key) or {}
            _usage_cache[key] = {**prev, "failed_at": time.time(), "error": redact(str(e))[:200], "busy": False}


def _window_passed(entry: dict[str, Any], now: float) -> bool:
    """A cached window whose reset time is behind us carries stale numbers and a stale reset time."""
    wins = ((entry.get("usage") or {}).get("windows")) or []
    return any(isinstance(w.get("reset_at"), (int, float)) and w["reset_at"] <= now for w in wins)


@router.get("/usage")
def usage(agent: str = Query("default"), wait: float = Query(0.0, ge=0, le=20)) -> dict[str, Any]:
    """Claude + Codex usage for an agent's login. Answers from cache at once; a stale entry is
    refreshed in the background (single flight per agent/provider), so the UI never blocks."""
    import threading
    _check_agent(agent)
    now = time.time()
    threads = []
    for provider in HUB_PROVIDERS:
        key = (agent, provider)
        with _usage_lock:
            c = _usage_cache.get(key) or {}
            stale = not c.get("at") or now - c["at"] > USAGE_TTL_S or _window_passed(c, now)
            cooling = c.get("failed_at") and now - c["failed_at"] < USAGE_RETRY_S
            start = stale and not cooling and not c.get("busy")
            if start:
                _usage_cache[key] = {**c, "busy": True}
        if start:
            t = threading.Thread(target=_refresh_usage, args=(agent, provider), daemon=True)
            t.start()
            threads.append(t)
    for t in threads:
        t.join(timeout=wait)
    out = []
    with _usage_lock:
        for provider in HUB_PROVIDERS:
            c = _usage_cache.get((agent, provider)) or {}
            out.append({"id": provider, "label": PROVIDER_LABEL[provider], "status": c.get("status"),
                        "usage": c.get("usage"), "updated_at": c.get("at"), "error": c.get("error"),
                        "loading": bool(c.get("busy")) and not c.get("at")})
    return {"agent": agent, "providers": out, "ttl": USAGE_TTL_S}
