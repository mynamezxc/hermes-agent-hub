/**
 * Agents Hub — Hermes desktop plugin (disk, plain ESM, no JSX).
 *
 * One full page at /hub: agents rail + tabs (Chat for a selected agent, or
 * Overview; Conversations, Schedules, Tasks, Changes) with a diff viewer and a
 * merged per-agent chat timeline with a composer. Read-only; data comes from the backend
 * plugin at /api/plugins/agents-hub through ctx.rest. Styling is Material 3,
 * scoped under .ah-root and derived from host CSS variables with color-mix()
 * so it follows any theme, light or dark. Also registers the "Hermes Material"
 * theme, sidebar nav, palette command, keybind and a settings page.
 * It never navigates by itself: host.navigate runs only from a user action.
 */

import {
  Codicon,
  host,
  KEYBINDS_AREA,
  PALETTE_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  THEMES_AREA
} from '@hermes/plugin-sdk'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const PLUGIN_ID = 'agents-hub'
const HUB_PATH = '/hub'
const POLL_MS = 15000
const STYLE_ID = 'agents-hub-style'
const PLUGIN_VERSION = '1.6.17'

// What a failed request most likely means, in words the owner can act on.
function backendProblem(err) {
  const t = String(err || '')

  if (/\b404\b|not found/i.test(t)) {
    return { kind: 'missing', title: 'The Agents Hub backend is not loaded', hint: 'Restart the gateway once after installing or updating (Ctrl+K, "Restart gateway"), and check that agents-hub is enabled for the default profile (hermes -p default plugins list).' }
  }

  if (/gateway inaccessible|runtime_exited|failed to fetch|econnrefused|econnreset|network ?error|socket hang up|timed out|503|502|504/i.test(t)) {
    return { kind: 'gateway', title: 'Cannot reach the Hermes gateway', hint: 'It may be starting or restarting. The Hub keeps retrying on its own; if this stays, restart the gateway (Ctrl+K, "Restart gateway").' }
  }

  return { kind: 'error', title: 'The Agents Hub backend returned an error', hint: 'Retry; if it repeats, restart the gateway and send the details below.' }
}


/* ───────────────────────── tiny element helper ───────────────────────── */

function h(type, props, ...kids) {
  const children = kids.flat(Infinity).filter(k => k !== null && k !== undefined && k !== false)
  const { key, ...p } = props || {}
  const hasKey = key !== undefined && key !== null

  const make = (t, pr) => (hasKey ? (children.length > 1 ? jsxs(t, pr, key) : jsx(t, pr, key)) : children.length > 1 ? jsxs(t, pr) : jsx(t, pr))

  if (children.length === 0) {
    return make(type, p)
  }

  if (children.length === 1) {
    return make(type, { ...p, children: children[0] })
  }

  return make(type, { ...p, children })
}

const cx = (...parts) => parts.filter(Boolean).join(' ')

function Icon({ name, size, spinning, className }) {
  return jsx(Codicon, { name, size, spinning, className: cx('ah-icon', className) })
}

/* ───────────────────────── labels & formatters ───────────────────────── */

const TABS = [
  { id: 'chat', label: 'Chat', icon: 'comment' },
  { id: 'overview', label: 'Overview', icon: 'dashboard' },
  { id: 'conversations', label: 'Conversations', icon: 'comment-discussion' },
  { id: 'works', label: 'Scheduled', icon: 'history' },
  { id: 'tasks', label: 'Tasks', icon: 'checklist' },
  { id: 'changes', label: 'Changes', icon: 'git-compare' },
  { id: 'config', label: 'Settings', icon: 'settings-gear' }
]

// With an agent selected the hub is a chat with that agent; without one it is the overview.
const tabsFor = agent => TABS.filter(t => (agent ? t.id !== 'overview' : t.id !== 'chat'))

function effectiveTab(ui) {
  const tabs = tabsFor(ui.agent)

  return tabs.some(t => t.id === ui.tab) ? ui.tab : tabs[0].id
}

// Stable per-agent colors (M3-like mid tones; text always mixes toward the host foreground).
const AGENT_PALETTE = ['#5B6CE0', '#0E9F8E', '#D9822B', '#C2477F', '#3B8FD9', '#7E57C2', '#4CA64C', '#E0584A', '#9AA11F', '#29A3C4', '#8D6E63']
const AGENT_ORDER = ['default', 'manager', 'tech-lead', 'dev-frontend', 'dev-backend', 'dev-fullstack', 'dev-platform', 'marketing', 'sales', 'customer-success', 'process']

function agentColor(id) {
  const i = AGENT_ORDER.indexOf(id)

  return AGENT_PALETTE[i >= 0 ? i : hueOf(id) % AGENT_PALETTE.length]
}

const TASK_COLUMNS = [
  { id: 'triage', label: 'Triage' },
  { id: 'todo', label: 'To do' },
  { id: 'ready', label: 'Ready' },
  { id: 'running', label: 'Running' },
  { id: 'review', label: 'Review' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'done', label: 'Done' }
]

const AGENT_STATUS = {
  active: { label: 'Active', tone: 'ok' },
  idle: { label: 'Idle', tone: 'neutral' },
  offline: { label: 'Offline', tone: 'off' }
}

const KIND_LABEL = {
  delegation: 'Delegation',
  kanban: 'Kanban',
  cross_profile: 'Cross-profile',
  cron: 'Recurring',
  run: 'Run'
}

const STATUS_LABEL = {
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  scheduled: 'Scheduled',
  pending: 'Pending',
  paused: 'Paused',
  idle: 'Idle',
  ok: 'Succeeded',
  success: 'Succeeded',
  completed: 'Done',
  error: 'Error',
  blocked: 'Blocked',
  queued: 'Queued',
  review: 'In review',
  stopped: 'Stopped'
}

const STATUS_TONE = {
  running: 'info',
  done: 'ok',
  ok: 'ok',
  success: 'ok',
  completed: 'ok',
  failed: 'err',
  error: 'err',
  blocked: 'warn',
  paused: 'warn',
  scheduled: 'neutral',
  pending: 'neutral',
  queued: 'neutral',
  review: 'info',
  idle: 'neutral',
  stopped: 'neutral'
}

const FILE_STATUS = {
  M: { label: 'Modified', tone: 'info' },
  A: { label: 'Added', tone: 'ok' },
  D: { label: 'Deleted', tone: 'err' },
  R: { label: 'Renamed', tone: 'warn' },
  '?': { label: 'Untracked', tone: 'neutral' }
}

const KIND_ICON = { cron: 'history', run: 'play', delegation: 'send' }

function relTime(ts, now) {
  if (ts === null || ts === undefined || Number.isNaN(Number(ts))) {
    return 'Never'
  }

  const diff = Math.round((now || Date.now()) / 1000 - Number(ts))
  const abs = Math.abs(diff)
  const future = diff < 0

  let text

  if (abs < 10) {
    return future ? 'right now' : 'just now'
  } else if (abs < 60) {
    text = `${abs} sec`
  } else if (abs < 3600) {
    text = `${Math.floor(abs / 60)} min`
  } else if (abs < 86400) {
    text = `${Math.floor(abs / 3600)} hr`
  } else if (abs < 86400 * 30) {
    text = `${Math.floor(abs / 86400)} days`
  } else {
    text = `${Math.floor(abs / (86400 * 30))} months`
  }

  return future ? `in ${text}` : `${text} ago`
}

function absTime(ts) {
  if (ts === null || ts === undefined) {
    return ''
  }

  try {
    return new Date(Number(ts) * 1000).toLocaleString()
  } catch {
    return ''
  }
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function compact(n) {
  const v = num(n)

  if (v >= 1e6) {
    return `${(v / 1e6).toFixed(1).replace(/\.0$/, '')}M`
  }

  if (v >= 1e3) {
    return `${(v / 1e3).toFixed(1).replace(/\.0$/, '')}k`
  }

  return String(v)
}

function hueOf(str) {
  let x = 7

  for (const ch of String(str || '')) {
    x = (x * 31 + ch.charCodeAt(0)) % 360
  }

  return x
}

function initialsOf(name, id) {
  const source = String(name || id || '?')
  const words = source.split(/[\s\-_]+/).filter(w => /[\p{L}\p{N}]/u.test(w))

  if (words.length === 0) {
    return '?'
  }

  const letters = words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]

  return letters.toUpperCase()
}

const matches = (q, ...fields) => {
  const needle = String(q || '')
    .trim()
    .toLowerCase()

  return !needle || fields.some(f => String(f ?? '').toLowerCase().includes(needle))
}

const errText = err => (err && err.message ? String(err.message) : String(err || 'Unknown error'))

const dirOf = p => (String(p).includes('/') ? String(p).slice(0, String(p).lastIndexOf('/')) : '')
const baseOf = p => String(p).slice(String(p).lastIndexOf('/') + 1)

/* ───────────────────────── store (module level, set up in register) ───────────────────────── */

let C = null

const HUB_PROFILE = 'default'

function withHubProfile(path) {
  const p = String(path || '')

  if (/[?&]profile=/.test(p)) {
    return p
  }

  return `${p}${p.includes('?') ? '&' : '?'}profile=${HUB_PROFILE}`
}

let S = null
let inflight = null
const listeners = new Set()

const res = (status = 'idle', data = null, error = null) => ({ status, data, error })

function initialState(saved) {
  const ui = { tab: 'overview', agent: null, conv: null, repo: null, file: null, wrap: false, q: '', handoff: null, side: true, sideFile: null, sideView: 'diff', sideClosed: {}, chatSession: {} }

  if (saved && typeof saved === 'object') {
    for (const k of ['tab', 'agent', 'conv', 'repo', 'file', 'wrap', 'side', 'sideView', 'sideClosed', 'chatSession']) {
      if (saved[k] !== undefined) {
        ui[k] = saved[k]
      }
    }

    ui.tab = effectiveTab(ui)
  }

  return {
    agents: res(),
    conversations: res(),
    works: res(),
    tasks: res(),
    changes: res(),
    shared: res(),
    detail: {},
    diff: {},
    timeline: {},
    sessions: {},
    tools: {},
    chat: {},
    send: {},
    ws: {},
    activity: {},
    goals: {},
    goalsHistory: null,
    approvals: {},
    commands: null,
    cmdOut: {},
    usage: {},
    providers: {},
    queue: {},
    team: null,
    preview: {},
    live: {},
    models: {},
    cmdlog: {},
    refreshing: false,
    fetchedAt: null,
    now: Date.now(),
    ui
  }
}

function emit() {
  S = { ...S }
  listeners.forEach(fn => fn())
}

const subscribe = fn => {
  listeners.add(fn)

  return () => listeners.delete(fn)
}

const getState = () => S

function useHub() {
  return useSyncExternalStore(subscribe, getState, getState)
}

const convKey = c => (c ? `${c.profile}/${c.session_id}` : '')
const diffKey = (repo, path) => `${repo}::${path}`

function persistUi() {
  const { tab, agent, conv, repo, file, wrap, side, sideView, sideClosed, chatSession } = S.ui

  try {
    C.storage.set('ui', { tab, agent, conv, repo, file, wrap, side, sideView, sideClosed, chatSession })
  } catch {
    /* storage is best effort */
  }
}

async function fetchDetail(conv) {
  if (!C || !conv) {
    return
  }

  const key = convKey(conv)
  const prev = S.detail[key]

  S.detail = { ...S.detail, [key]: res(prev && prev.data ? 'ready' : 'loading', prev ? prev.data : null) }
  emit()

  try {
    const data = await C.rest(
      `/conversations/${encodeURIComponent(conv.profile)}/${encodeURIComponent(conv.session_id)}?limit=200`
    )

    S.detail = { ...S.detail, [key]: res('ready', data) }
  } catch (err) {
    S.detail = { ...S.detail, [key]: res('error', prev ? prev.data : null, errText(err)) }
  }

  emit()
}

async function fetchDiff(repo, path) {
  if (!C || !repo || !path) {
    return
  }

  const key = diffKey(repo, path)
  const prev = S.diff[key]

  S.diff = { ...S.diff, [key]: res(prev && prev.data ? 'ready' : 'loading', prev ? prev.data : null) }
  emit()

  try {
    const data = await C.rest(`/diff?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`)

    S.diff = { ...S.diff, [key]: res('ready', data) }
  } catch (err) {
    S.diff = { ...S.diff, [key]: res('error', prev ? prev.data : null, errText(err)) }
  }

  emit()
}

const ENDPOINTS = {
  agents: '/agents',
  conversations: '/conversations?limit=100',
  works: '/works',
  tasks: '/tasks',
  changes: '/changes',
  shared: '/shared'
}

const REST_TIMEOUT_MS = 20000

function withTimeout(promise, ms) {
  let timer

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Request timed out after ${Math.round(ms / 1000)}s`)), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

let retryDelay = 0
let retryTimer = null

function scheduleRetry() {
  if (retryTimer || !C) {
    return
  }

  retryDelay = Math.min(retryDelay ? retryDelay * 2 : 3000, 30000)
  const run = () => {
    retryTimer = null
    void load()
  }
  retryTimer = typeof C.setTimeout === 'function' ? C.setTimeout(run, retryDelay) || true : setTimeout(run, retryDelay)
}

// Backend version vs this page: after an update the page reloads at once, the backend only when the
// gateway restarts. A mismatch (or a backend without /health) means "restart the gateway".
async function checkHealth() {
  try {
    const h = await withTimeout(C.rest('/health'), 8000)
    // plugin_version arrived with 1.6.8; an older backend only reports its API version.
    S.health = { at: Date.now(), version: (h && h.plugin_version) || '', ok: true, old: !(h && h.plugin_version) }
  } catch (err) {
    S.health = { at: Date.now(), version: '', ok: false, old: /\b404\b|not found/i.test(errText(err)) }
  }

  emit()
}

function backendStale(s) {
  const hl = s.health

  if (!hl) {
    return null
  }

  if (hl.ok && hl.version && hl.version !== PLUGIN_VERSION) {
    return `The page is Agents Hub ${PLUGIN_VERSION} but the gateway still runs backend ${hl.version}.`
  }

  if (hl.old) {
    return `The page is Agents Hub ${PLUGIN_VERSION} but the gateway still runs an older backend.`
  }

  return null
}

function load() {
  if (!C) {
    return Promise.resolve()
  }

  if (inflight) {
    return inflight
  }

  for (const k of Object.keys(ENDPOINTS)) {
    if (!S[k].data) {
      S[k] = res('loading')
    }
  }

  S.refreshing = true
  emit()

  inflight = Promise.all(
    Object.entries(ENDPOINTS).map(async ([key, path]) => {
      // Await into a local first: emit() replaces S, so `S[key] = f(await …)` would write to a stale store.
      // Each section renders as soon as its own data lands; a hung request times out instead of
      // keeping the whole hub (and every later refresh) on skeletons.
      try {
        const data = await withTimeout(C.rest(path), REST_TIMEOUT_MS)

        // Hermes keeps hidden bookkeeping dirs under profiles/ (.deleted trash, .<id>.staging-*): never agents,
        // even when an older gateway still lists them.
        S[key] = res('ready', key === 'agents' && data && Array.isArray(data.agents) ? { ...data, agents: data.agents.filter(a => a && !String(a.id || '').startsWith('.')) } : data)
      } catch (err) {
        S[key] = res('error', S[key].data, errText(err))
      }

      emit()
    })
  )
    .then(() => {
      // One failed refresh is usually a gateway hiccup: keep the data, retry soon, and only call the
      // backend disconnected after two misses in a row.
      if (S.agents.status === 'error') {
        S.agentFails = (S.agentFails || 0) + 1
        scheduleRetry()
      } else {
        S.agentFails = 0
        retryDelay = 0
      }

      if (S.agents.status !== 'error' && (!S.health || S.health.at < Date.now() - 300000)) {
        void checkHealth()
      }
    })
    .then(async () => {
      if (!S.team) {
        void fetchTeam() // roster path for the goals block; also runs first-run setup server-side
      }

      S.refreshing = false
      S.fetchedAt = Date.now()
      S.now = Date.now()
      emit()

      const { conv, repo, file } = S.ui
      const jobs = []

      if (S.ui.tab === 'chat' && S.ui.agent && !(S.send[S.ui.agent] && S.send[S.ui.agent].busy)) {
        jobs.push(fetchTimeline(S.ui.agent), fetchSessions(S.ui.agent))

        if (S.ui.side) {
          jobs.push(fetchTools(S.ui.agent))
        }
      }

      if (conv && S.ui.tab === 'conversations') {
        jobs.push(fetchDetail(conv))
      }

      if (repo && file && S.ui.tab === 'changes') {
        jobs.push(fetchDiff(repo, file))
      }

      // follow-ups must not hold the refresh lock: cap the wait
      await withTimeout(Promise.all(jobs), REST_TIMEOUT_MS).catch(() => {})
    })
    .finally(() => {
      inflight = null
    })

  return inflight
}

// OS notification click -> the Hub, not the core chat view. Core's own listener opens the session in the
// Sessions view first; when that session is one of the Hub's agent chats we bring the owner back to the Hub
// with that agent's chat open (a few hops so it lands after core's navigation settles).
function agentForSession(id) {
  if (!S || !id) {
    return null
  }

  for (const [agent, lv] of Object.entries(S.live || {})) {
    if (lv && (lv.runtime === id || lv.stored === id)) {
      return agent
    }
  }

  for (const [agent, c] of Object.entries(S.chat || {})) {
    if (c && c.data && c.data.session_id === id) {
      return agent
    }
  }

  return null
}

const onHubPath = () => {
  try {
    return String(window.location.hash || window.location.pathname || '').replace(/^#/, '').split('?')[0] === HUB_PATH
  } catch {
    return false
  }
}

function focusHubChat(sessionId, navigate) {
  const agent = agentForSession(sessionId)

  if (!agent) {
    return false
  }

  const go = () => {
    if (!onHubPath()) {
      navigate(HUB_PATH)
    }

    setUi({ agent, tab: 'chat', side: true, sideFile: null, handoff: null })
  }

  for (const ms of [0, 150, 450]) {
    setTimeout(go, ms)
  }

  return true
}

function setUi(patch) {
  const next = { ...patch }

  if ('agent' in next && next.agent !== S.ui.agent) {
    next.handoff = null
    next.sideFile = null

    if (next.tab === undefined) {
      next.tab = next.agent ? 'chat' : S.ui.tab === 'chat' ? 'overview' : S.ui.tab
    }
  }

  S.ui = { ...S.ui, ...next }
  persistUi()
  emit()
}

const list = (key, field) => {
  const d = S[key].data

  return d && Array.isArray(d[field]) ? d[field] : []
}

/* ───────────────────────── chat store: timeline, chat session, send flow ───────────────────────── */

const drafts = {}
const tlInflight = new Set()
const FG = { spawnPriority: 'foreground' }
const MAX_TURN_MS = 15 * 60 * 1000
const QUIET_MS = 6000
const enc = encodeURIComponent

const itemKey = it => (it.type === 'session' ? `s:${it.session_id}:${it.started_at}` : it.type === 'handoff' ? `h:${it.session_id}` : `m:${it.session_id}:${it.id}`)
const entryKey = e => (e.kind === 'msg' ? `m:${e.m.session_id || ''}:${e.m.id}` : e.key)

function emptyTimeline() {
  return { status: 'loading', error: null, latest: [], older: [], has_more: false, next_before: null, loadingMore: false, moreError: null }
}

function fetchTimelineRetry(agent) {
  const cur = S.timeline[agent]

  if (cur && cur.moreError) {
    S.timeline = { ...S.timeline, [agent]: { ...cur, moreError: null } }
    emit()
  }
}

async function fetchTimeline(agent, { more = false } = {}) {
  if (!C || !agent) {
    return
  }

  const pick = pickedSession(agent)
  const scope = pick ? `&session=${enc(pick)}` : ''
  const prev = S.timeline[agent]
  const set = patch => {
    if (pickedSession(agent) !== pick) {
      return // the owner switched conversations while this was loading
    }

    S.timeline = { ...S.timeline, [agent]: { ...(S.timeline[agent] || emptyTimeline()), ...patch } }
    emit()
  }

  if (more) {
    if (!prev || prev.loadingMore || !prev.has_more || prev.next_before === null || prev.next_before === undefined) {
      return
    }

    set({ loadingMore: true, moreError: null })

    try {
      const d = await C.rest(`/agents/${enc(agent)}/timeline?limit=150&before=${enc(prev.next_before)}${scope}`)
      const cur = S.timeline[agent] || prev

      set({ older: [...(Array.isArray(d.items) ? d.items : []), ...cur.older], has_more: !!d.has_more, next_before: d.next_before ?? null, loadingMore: false })
    } catch (err) {
      set({ loadingMore: false, moreError: errText(err) })
    }

    return
  }

  const flight = `${agent}|${pick || ''}`

  if (tlInflight.has(flight)) {
    return
  }

  tlInflight.add(flight)

  if (!prev) {
    set({})
  }

  try {
    const d = await C.rest(`/agents/${enc(agent)}/timeline?limit=150${scope}`)
    const cur = S.timeline[agent] || emptyTimeline()
    const patch = { status: 'ready', error: null, latest: Array.isArray(d.items) ? d.items : [] }

    if (cur.older.length === 0) {
      patch.has_more = !!d.has_more
      patch.next_before = d.next_before ?? null
    }

    set(patch)
    settleUnsaved(agent)
  } catch (err) {
    const cur = S.timeline[agent] || emptyTimeline()

    if (pick && /unknown session/i.test(errText(err))) {
      pickSession(agent, null) // the remembered conversation is gone: back to all conversations
      return
    }

    set({ status: cur.latest.length > 0 ? 'ready' : 'error', error: errText(err) })
  } finally {
    tlInflight.delete(flight)
  }
}

/* Conversations of one agent. An agent can run several sessions (say one fed by a Facebook trigger and
   one in Hermes); the owner picks one in the chat header and the choice is remembered per agent.
   No pick shows every conversation merged and sends to the Bot Chat, as before. */
const pickedSession = agent => (S && S.ui.chatSession && S.ui.chatSession[agent]) || null

async function fetchSessions(agent) {
  if (!C || !agent) {
    return
  }

  try {
    const d = await C.rest(`/agents/${enc(agent)}/sessions`)

    S.sessions = { ...S.sessions, [agent]: res('ready', Array.isArray(d && d.sessions) ? d.sessions : []) }
  } catch (err) {
    const prev = S.sessions[agent]

    S.sessions = { ...S.sessions, [agent]: res('error', prev ? prev.data : null, errText(err)) }
  }

  emit()
}

function pickSession(agent, id) {
  if (pickedSession(agent) === (id || null)) {
    return
  }

  const lv = liveOf(agent)

  if ((lv && lv.turn && lv.turn.active) || (S.send[agent] && S.send[agent].busy)) {
    return // never move a running turn to another conversation
  }

  const next = { ...(S.ui.chatSession || {}) }

  if (id) {
    next[agent] = id
  } else {
    delete next[agent]
  }

  S.timeline = { ...S.timeline, [agent]: emptyTimeline() }
  delete runtimeInflight[agent]
  setLive(agent, { runtime: null, stored: null, info: null, seq: 0, epoch: null, primed: false, turn: null, errors: 0 })
  setUi({ chatSession: next })
  void fetchTimeline(agent)
  ensureRuntime(agent)
    .then(rt => (rt ? pollEvents(agent) : null))
    .catch(() => {})
}

async function fetchChatMeta(agent) {
  if (!C || !agent) {
    return
  }

  try {
    const data = await C.rest(`/agents/${enc(agent)}/chat`)

    S.chat = { ...S.chat, [agent]: res('ready', data) }
  } catch (err) {
    S.chat = { ...S.chat, [agent]: res('error', S.chat[agent] ? S.chat[agent].data : null, errText(err)) }
  }

  emit()
}

// User click only: open the agent's Bot Chat session in the built-in chat pane.
async function openChatSession(agent) {
  if (typeof host.openSession !== 'function') {
    return
  }

  const pick = pickedSession(agent)
  const g = pick ? ((S.sessions[agent] && S.sessions[agent].data) || []).find(x => x.id === pick) : null

  if (g) {
    await host.openSession(g.latest_id, { profile: agent })

    return
  }

  let data = S.chat[agent] && S.chat[agent].data

  if (!data || !data.session_id) {
    await fetchChatMeta(agent)
    data = S.chat[agent] && S.chat[agent].data
  }

  if (data && data.session_id) {
    await host.openSession(data.session_id, { profile: data.profile || agent })
  }
}

function openHandoff(item) {
  const current = { profile: item.profile, session_id: item.session_id }

  setUi({
    handoff: { ...current, title: item.title, from_agent: item.from_agent, to_agent: item.to_agent, kind: item.kind, status: item.status, at: item.at }
  })
  void fetchDetail(current)
}

function setSend(agent, patch) {
  S.send = { ...S.send, [agent]: { ...(S.send[agent] || {}), ...patch } }
  emit()
}

const allTimelineItems = agent => {
  const tl = S.timeline[agent]

  return tl ? [...tl.older, ...tl.latest] : []
}

async function rp(agent, method, params, fg = true) {
  if (typeof host.requestProfile !== 'function') {
    throw new Error('This Hermes Desktop version cannot call agents from Agents Hub.')
  }

  return host.requestProfile(agent, method, params || {}, undefined, fg ? FG : undefined)
}

/* live session: runtime id, session.info (model, reasoning), streamed turn state */

const runtimeInflight = {}
const LIVE_FAST_MS = 600
const LIVE_SLOW_MS = 5000
const ACTIVITY_POLL_MS = 5000
const LOAD_MORE_PX = 160
const COMMANDS_POLL_MS = 4000
const MAX_REASON_CHARS = 8000
const MAX_LIVE_TEXT = 60000
const MAX_LIVE_TOOLS = 60

const liveOf = agent => (S && S.live[agent]) || null

function setLive(agent, patch) {
  if (!S) {
    return
  }

  const cur = S.live[agent] || { runtime: null, stored: null, info: null, seq: 0, epoch: null, primed: false, turn: null, errors: 0 }

  S.live = { ...S.live, [agent]: { ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) } }
  emit()
}

function liveAgentFor(sessionId) {
  if (!S || !sessionId) {
    return null
  }

  for (const [agent, lv] of Object.entries(S.live)) {
    if (lv && lv.runtime === sessionId) {
      return agent
    }
  }

  return null
}

// Resume (or, when `create`, create) the agent's canonical Bot Chat and remember its runtime id.
async function ensureRuntime(agent, { create = false, fg = false } = {}) {
  const lv = liveOf(agent)

  if (lv && lv.runtime) {
    return lv.runtime
  }

  if (!C || typeof host.requestProfile !== 'function') {
    return null
  }

  if (runtimeInflight[agent]) {
    const r = await runtimeInflight[agent]

    if (r || !create) {
      return r
    }
  }

  const pick = pickedSession(agent)
  const job = (async () => {
    let chat = null

    if (pick) {
      if (!(S.sessions[agent] && S.sessions[agent].data)) {
        await fetchSessions(agent)
      }

      const g = ((S.sessions[agent] && S.sessions[agent].data) || []).find(x => x.id === pick)

      chat = { session_id: g ? g.latest_id : pick }
    } else {
      chat = await C.rest(`/agents/${enc(agent)}/chat`)
    }

    let r = null

    if (chat && chat.session_id) {
      r = await rp(agent, 'session.resume', { session_id: chat.session_id }, fg)
    } else if (create && !pick) {
      r = await rp(agent, 'session.create', { profile: agent, title: 'Bot Chat', hidden: true, follow_profile_config: true })

      if (r && r.session_id) {
        try {
          // Materializes the row now so the canonical title is taken before the first turn.
          await rp(agent, 'session.title', { session_id: r.session_id, title: 'Bot Chat' })
        } catch {
          /* older gateways: prompt.submit persists the lazy row */
        }
      }
    } else {
      return null
    }

    const runtime = r && r.session_id

    if (!runtime) {
      throw new Error('The gateway returned no runtime session id.')
    }

    if (pickedSession(agent) !== pick) {
      return null // switched to another conversation meanwhile
    }

    setLive(agent, { runtime, stored: (chat && chat.session_id) || r.stored_session_id || null, info: r.info || null, seq: 0, epoch: null, primed: false, errors: 0 })

    if (r.running) {
      setLive(agent, cur => ({ turn: cur.turn && cur.turn.active ? cur.turn : newTurn(r.turn_started_at ? Number(r.turn_started_at) * 1000 : Date.now()) }))
    }

    return runtime
  })()

  runtimeInflight[agent] = job

  try {
    return await job
  } finally {
    if (runtimeInflight[agent] === job) {
      delete runtimeInflight[agent]
    }
  }
}

function newTurn(startedMs = Date.now()) {
  return { active: true, phase: 'thinking', startedMs, text: '', reasoning: '', tools: [], steps: [], status: '', statusKind: '', error: null, usage: null, gen: '' }
}

const MAX_LIVE_STEPS = 80

// Steps of a live turn: a new step starts when the agent thinks or writes again after running tools.
function stepUpdate(cur, kind, fn) {
  const steps = Array.isArray(cur.steps) ? cur.steps.slice() : []
  let last = steps[steps.length - 1]

  if (!last || ((kind === 'think' || kind === 'text') && last.tools.length > 0)) {
    last = { label: '', text: '', reasoning: '', tools: [] }
    steps.push(last)
  } else {
    last = { ...last }
    steps[steps.length - 1] = last
  }

  fn(last)

  return steps.slice(-MAX_LIVE_STEPS)
}

function reduceTurn(turn, ev, now) {
  const p = ev.payload && typeof ev.payload === 'object' ? ev.payload : {}
  const t = turn && turn.active ? turn : null
  const base = () => t || newTurn(now)

  switch (ev.type) {
    case 'message.start':
      return newTurn(now)
    case 'reasoning.delta': {
      const cur = base()

      const steps = stepUpdate(cur, 'think', st => {
        st.reasoning = (st.reasoning + String(p.text || '')).slice(-MAX_REASON_CHARS)

        st.label = thoughtLabel(st.reasoning) || st.label
      })

      return { ...cur, phase: 'reasoning', steps, reasoning: (cur.reasoning + String(p.text || '')).slice(-MAX_REASON_CHARS) }
    }
    case 'thinking.delta': {
      // Spinner text ("(°ロ°) mulling..."), not reasoning content: show it as the current status.
      const cur = base()
      const txt = String(p.text || '').trim()

      return txt ? { ...cur, phase: cur.phase === 'writing' || cur.phase === 'tool' ? cur.phase : 'thinking', spin: txt } : cur
    }
    case 'agent.step': {
      const cur = base()

      return { ...cur, step: typeof p.iteration === 'number' ? p.iteration : cur.step }
    }
    case 'reasoning.available': {
      const cur = base()

      return { ...cur, reasoning: String(p.text || cur.reasoning).slice(-MAX_REASON_CHARS) }
    }
    case 'message.delta': {
      const cur = base()

      if (p.text === null || p.text === undefined) {
        return cur.text && !cur.text.endsWith('\n\n') ? { ...cur, text: `${cur.text}\n\n` } : cur
      }

      const steps = stepUpdate(cur, 'text', st => {
        st.text = (st.text + String(p.text)).slice(-MAX_LIVE_TEXT)
        st.label = stepLabel(st.text) || st.label
      })

      return { ...cur, phase: 'writing', gen: '', steps, text: (cur.text + String(p.text)).slice(-MAX_LIVE_TEXT) }
    }
    case 'tool.generating': {
      const cur = base()

      return { ...cur, phase: 'tool-gen', gen: String(p.name || '') }
    }
    case 'tool.start': {
      const cur = base()
      const tool = { id: String(p.tool_id || `${now}`), name: String(p.name || 'tool'), context: String(p.context || p.preview || ''), state: 'run', startMs: now, percent: null, message: '' }

      const steps = stepUpdate(cur, 'tool', st => {
        st.tools = st.tools.includes(tool.id) ? st.tools : [...st.tools, tool.id]
      })

      return { ...cur, phase: 'tool', gen: '', steps, tools: [...cur.tools.filter(x => x.id !== tool.id), tool].slice(-MAX_LIVE_TOOLS) }
    }
    case 'tool.progress': {
      if (!t) {
        return turn
      }

      return { ...t, tools: t.tools.map(x => (x.id === String(p.tool_id) ? { ...x, percent: typeof p.percent === 'number' ? p.percent : x.percent, message: String(p.message || x.message || '') } : x)) }
    }
    case 'tool.complete': {
      const cur = base()
      const id = String(p.tool_id || '')
      const known = cur.tools.some(x => x.id === id)
      const done = {
        state: p.error || (p.result && typeof p.result === 'object' && p.result.success === false) ? 'err' : 'done',
        duration: typeof p.duration_s === 'number' ? p.duration_s : null,
        summary: String(p.summary || ''),
        diff: !!p.inline_diff
      }
      const tools = known
        ? cur.tools.map(x => (x.id === id ? { ...x, ...done, duration: done.duration ?? (now - x.startMs) / 1000 } : x))
        : [...cur.tools, { id, name: String(p.name || 'tool'), context: '', startMs: now, percent: null, message: '', ...done }].slice(-MAX_LIVE_TOOLS)

      return { ...cur, tools, phase: tools.some(x => x.state === 'run') ? 'tool' : 'thinking' }
    }
    case 'status.update':
      return t ? { ...t, status: String(p.text || ''), statusKind: String(p.kind || '') } : turn
    case 'session.usage':
      return t ? { ...t, usage: p.usage || p } : turn
    case 'error':
      return t ? { ...t, error: String(p.message || p.error || 'Unknown error') } : turn
    case 'message.complete':
      // `saving`: the reply is final but not in the loaded timeline yet. The card stays up (and keeps hiding the
      // turn's persisted rows) until finishTurn has re-read the timeline, so the answer never blinks out.
      return t ? { ...t, active: false, saving: true, phase: 'done', endedMs: now, error: p.error ? String(p.error) : t.error, status: '' } : turn
    default:
      return turn
  }
}

function applyEvents(agent, events, { force = false } = {}) {
  const lv = liveOf(agent)

  if (!lv || !Array.isArray(events) || events.length === 0) {
    return
  }

  let { seq, turn, info } = lv
  let ended = false
  let touched = false
  const now = Date.now()

  for (const ev of events) {
    if (!ev || typeof ev.type !== 'string') {
      continue
    }

    if (typeof window !== 'undefined' && Array.isArray(window.__AH_DEBUG)) {
      window.__AH_DEBUG.push([ev.seq, ev.type, JSON.stringify(ev.payload || {}).slice(0, 120)])
    }

    if (typeof ev.seq === 'number') {
      if (!force && ev.seq <= seq) {
        continue
      }

      seq = Math.max(seq, ev.seq)
    }

    if (ev.type === 'session.info' && ev.payload && typeof ev.payload === 'object') {
      info = { ...(info || {}), ...ev.payload }
      continue
    }

    if (ev.type === 'approval.request' && ev.payload && typeof ev.payload === 'object') {
      onApprovalRequest(agent, ev.payload)
      continue
    }

    if (ev.type === 'approval.settled' || ev.type === 'approval.resolved') {
      dropApproval(agent, ev.payload && ev.payload.request_id)
      continue
    }

    const before = turn

    turn = reduceTurn(turn, ev, now)

    if (ev.type === 'message.complete' && before && before.active) {
      ended = true
    }

    if (ev.type === 'tool.complete' && /write|patch|edit|file/i.test(String((ev.payload && ev.payload.name) || ''))) {
      touched = true
    }
  }

  setLive(agent, { seq, turn, info })

  if (touched) {
    void fetchWorkspace(agent)
  }

  if (ended) {
    void finishTurn(agent)
  }
}

// A finished turn's reply must be in the loaded timeline before its live card and the optimistic row go
// away: a slow/failed timeline read (or a Bot Chat outside the session window) otherwise made the whole
// exchange vanish from the Hub until a later refresh happened to include it.
const SAVE_RETRIES = 4
const SAVE_RETRY_MS = 1500

function timelineHasReply(agent, sinceSec) {
  return allTimelineItems(agent).some(it => it.type === 'message' && it.role === 'assistant' && Number(it.timestamp) >= sinceSec - 2)
}

// Called after every timeline refresh: drop a kept ("unsaved") live card once its reply has been loaded.
function settleUnsaved(agent) {
  const lv = liveOf(agent)

  if (!lv || !lv.turn || lv.turn.active || !lv.turn.unsaved || !timelineHasReply(agent, lv.turn.startedMs / 1000)) {
    return
  }

  setLive(agent, { turn: null })

  const st = S && S.send[agent]

  if (st && !st.busy && st.optimistic && st.optimistic.length) {
    setSend(agent, { optimistic: [] })
  }
}

async function finishTurn(agent, { drain = true } = {}) {
  const lv0 = liveOf(agent)
  const st0 = S && S.send[agent]
  const since = lv0 && lv0.turn ? lv0.turn.startedMs / 1000 : st0 && st0.sentAt ? num(st0.sentAt) : 0

  await fetchTimeline(agent)

  const saved = !since || timelineHasReply(agent, since)
  const lv = liveOf(agent)

  if (lv && lv.turn && !lv.turn.active) {
    // Not loaded yet: keep the card (marked unsaved) instead of showing an empty chat; settleUnsaved clears it.
    setLive(agent, { turn: lv.turn.error ? { ...lv.turn, saving: false, stale: true } : saved ? null : { ...lv.turn, saving: false, stale: true, unsaved: true } })
  }

  const st = S && S.send[agent]

  if (st && st.busy) {
    setSend(agent, saved ? { busy: false, optimistic: [], phase: null } : { busy: false, phase: null })
  }

  void fetchWorkspace(agent)
  void fetchChatMeta(agent)

  if (!saved) {
    // Re-read in the background: the composer is free at once (waiting here locked it for up to 6 s), and
    // settleUnsaved drops the kept card as soon as a refresh brings the reply in.
    void (async () => {
      for (let i = 0; i < SAVE_RETRIES && !timelineHasReply(agent, since); i += 1) {
        await new Promise(resolve => setTimeout(resolve, SAVE_RETRY_MS))
        await fetchTimeline(agent)
      }
    })()
  }

  if (drain) {
    drainQueue(agent)
  }
}

const pollingAgents = new Set()

async function pollEvents(agent) {
  const lv = liveOf(agent)

  if (!lv || !lv.runtime || pollingAgents.has(agent)) {
    return
  }

  pollingAgents.add(agent)

  try {
    const r = await rp(agent, 'session.events.since', { session_id: lv.runtime, last_seen: lv.primed ? lv.seq : 0 }, false)
    const cur = liveOf(agent)

    if (!cur || cur.runtime !== lv.runtime) {
      return
    }

    const events = Array.isArray(r && r.events) ? r.events : []
    const latest = typeof (r && r.latest_seq) === 'number' ? r.latest_seq : events.reduce((m, e) => Math.max(m, num(e.seq)), cur.seq)

    if (cur.epoch && r && r.epoch && r.epoch !== cur.epoch) {
      setLive(agent, { epoch: r.epoch, seq: 0, primed: false, errors: 0 })

      return
    }

    if (!cur.primed) {
      // First read: replay only the turn still in flight (and the newest settings snapshot).
      let start = -1

      for (let i = events.length - 1; i >= 0; i -= 1) {
        if (events[i].type === 'message.complete') {
          break
        }

        if (events[i].type === 'message.start') {
          start = i
          break
        }
      }

      const infos = events.filter(e => e.type === 'session.info').slice(-1)
      const tail = start >= 0 ? events.slice(start) : []

      setLive(agent, { epoch: (r && r.epoch) || null, primed: true, errors: 0, seq: 0 })
      applyEvents(agent, [...infos, ...tail], { force: true })
      setLive(agent, { seq: latest })

      return
    }

    setLive(agent, { errors: 0, epoch: (r && r.epoch) || cur.epoch })
    applyEvents(agent, events)
  } catch (err) {
    const cur = liveOf(agent)
    const errors = (cur ? cur.errors : 0) + 1

    // The runtime went away (gateway restart, session closed): forget it, resume lazily later.
    setLive(agent, errors >= 3 || isNotFound(errText(err)) ? { runtime: null, primed: false, seq: 0, errors: 0 } : { errors })
  } finally {
    pollingAgents.delete(agent)
  }
}

// Gateway event tap: events of a known runtime session go straight into its live state.
function onGatewayEvent(ev) {
  const sid = ev && (ev.session_id || (ev.payload && ev.payload.session_id))
  const agent = liveAgentFor(sid)

  if (!agent) {
    return
  }

  const lv = liveOf(agent)

  if (!lv || !lv.primed || typeof ev.seq !== 'number') {
    return
  }

  applyEvents(agent, [ev])
}

/* side panel data */

async function fetchWorkspace(agent) {
  if (!C || !agent) {
    return
  }

  const prev = S.ws[agent]

  S.ws = { ...S.ws, [agent]: res(prev && prev.data ? 'ready' : 'loading', prev ? prev.data : null) }
  emit()

  try {
    const data = await C.rest(`/agents/${enc(agent)}/workspace`)

    S.ws = { ...S.ws, [agent]: res('ready', data) }
  } catch (err) {
    S.ws = { ...S.ws, [agent]: res('error', prev ? prev.data : null, errText(err)) }
  }

  emit()
}

async function fetchActivity(agent) {
  if (!C || !agent) {
    return
  }

  try {
    const data = await C.rest(`/agents/${enc(agent)}/activity`)

    S.activity = { ...S.activity, [agent]: res('ready', data) }
  } catch (err) {
    const prev = S.activity[agent]

    S.activity = { ...S.activity, [agent]: res('error', prev ? prev.data : null, errText(err)) }
  }

  emit()
}

// Dry run (apply=false) or apply a file restore to the state just before `since` (a message time).
function rollbackFiles(agent, since, { apply = false, paths } = {}) {
  return C.rest(`/agents/${enc(agent)}/rollback-files`, { method: 'POST', body: { since, apply, ...(paths ? { paths } : {}) } })
}

// Edit an earlier own message: optionally restore files, then cut the session at that message and resend.
async function rewindTo(agent, m, text, paths) {
  const since = num(m.timestamp)
  let restored = null

  if (paths && paths.length) {
    restored = await rollbackFiles(agent, since, { apply: true, paths })
    const bad = (restored.results || []).filter(r => !r.ok)

    if (bad.length) {
      throw new Error(`Could not restore ${bad.length} files: ${bad.map(b => `${baseOf(b.path)} (${b.error || b.method})`).join(', ')}`)
    }
  }

  if (text !== null) {
    await sendMessage(agent, text, [], { truncateRowId: Number(m.id) })
    const st = S.send[agent]

    if (st && st.error) {
      throw new Error(st.error)
    }
  } else {
    void fetchWorkspace(agent)
  }

  return restored
}

/* ── permission requests ── */

// Every answer is the owner's click; the plugin never answers a request on its own (catalog rule 12).

function approvalOf(p) {
  return {
    request_id: String(p.request_id || p.id || ''),
    command: String(p.command || p.cmd || ''),
    description: String(p.description || p.reason || p.message || ''),
    at: Date.now()
  }
}

function onApprovalRequest(agent, p) {
  const req = approvalOf(p)
  const rest = (S.approvals[agent] || []).filter(x => x.request_id !== req.request_id)

  S.approvals = { ...S.approvals, [agent]: [...rest, req] }
  emit()
}

function dropApproval(agent, id) {
  const cur = S.approvals[agent] || []
  const next = id ? cur.filter(x => x.request_id !== String(id)) : cur.slice(1)

  if (next.length !== cur.length) {
    S.approvals = { ...S.approvals, [agent]: next }
    emit()
  }
}

// choice: once | session (Hermes remembers it for this chat/goal) | always (Hermes's permanent allow) | deny.
async function answerApproval(agent, req, choice) {
  const lv = liveOf(agent)

  if (!lv || !lv.runtime) {
    throw new Error('The agent’s session is not ready yet; try again in a moment.')
  }

  await rp(agent, 'approval.respond', { session_id: lv.runtime, choice, ...(req.request_id ? { request_id: req.request_id } : {}) })
  dropApproval(agent, req.request_id)
}

// Pending requests survive reloads on the gateway side: re-read them.
async function syncApprovals(agent) {
  const lv = liveOf(agent)

  if (!C || !lv || !lv.runtime) {
    return
  }

  try {
    const r = await rp(agent, 'approval.pending', { session_id: lv.runtime }, false)
    const list = (Array.isArray(r && r.approvals) ? r.approvals : []).map(approvalOf)
    const prev = S.approvals[agent] || []

    if (list.length !== prev.length || list.some((x, i) => x.request_id !== (prev[i] || {}).request_id)) {
      S.approvals = { ...S.approvals, [agent]: list }
      emit()
    }
  } catch {
    /* older gateway without approval.pending */
  }
}

/* ── running commands (every agent) ── */

async function fetchCommands() {
  if (!C) {
    return
  }

  try {
    const data = await C.rest('/commands')

    S.commands = res('ready', data)
  } catch (err) {
    S.commands = res('error', S.commands ? S.commands.data : null, errText(err))
  }

  emit()
}

async function fetchCommandOutput(id) {
  try {
    const data = await C.rest(`/commands/output?id=${enc(id)}`)

    S.cmdOut = { ...S.cmdOut, [id]: data }
  } catch (err) {
    S.cmdOut = { ...S.cmdOut, [id]: { id, output: '', running: false, error: errText(err) } }
  }

  emit()
}

async function fetchGoals(agent) {
  if (!C || !agent) {
    return
  }

  try {
    const data = await C.rest(`/agents/${enc(agent)}/goals`)

    S.goals = { ...S.goals, [agent]: res('ready', data) }
  } catch (err) {
    const prev = S.goals[agent]

    S.goals = { ...S.goals, [agent]: res('error', prev ? prev.data : null, errText(err)) }
  }

  emit()
}

async function goalAction(agent, body) {
  const data = await C.rest(`/agents/${enc(agent)}/goals`, { method: 'POST', body })

  S.goals = { ...S.goals, [agent]: res('ready', data) }
  emit()

  return data
}

async function fetchTools(agent) {
  if (!C || !agent) {
    return
  }

  try {
    const data = await C.rest(`/agents/${enc(agent)}/tools`)

    S.tools = { ...S.tools, [agent]: res('ready', data) }
  } catch (err) {
    const prev = S.tools[agent]

    S.tools = { ...S.tools, [agent]: res('error', prev ? prev.data : null, errText(err)) }
  }

  emit()
}

async function toolAction(agent, body) {
  const data = await C.rest(`/agents/${enc(agent)}/tools`, { method: 'POST', body })

  S.tools = { ...S.tools, [agent]: res('ready', data) }
  emit()

  return data
}

async function fetchGoalsHistory() {
  if (!C) {
    return
  }

  try {
    const data = await C.rest('/goals/history?limit=60')

    S.goalsHistory = res('ready', data)
  } catch (err) {
    S.goalsHistory = res('error', S.goalsHistory ? S.goalsHistory.data : null, errText(err))
  }

  emit()
}

async function approveFiles(agent, body) {
  await C.rest(`/agents/${enc(agent)}/files/approve`, { method: 'POST', body })
  await fetchWorkspace(agent)
}

// Hub state the agent needs (its goals and saved tools), sent on the FIRST message of a chat session and
// afterwards only when it changed. The rules (how to update goals/tools, files, team) live in the
// agents-hub:hub-operating skill and the agent's own SOUL/memory, not in every message: a 1.7 KB block on each
// turn bloated every chat and, being new text each time, never reused the model's prompt cache.
const HUB_SENT_KEY = 'agents-hub.hubStateSent'
let hubSent = null

function hubSentMap() {
  if (hubSent) {
    return hubSent
  }

  try {
    hubSent = JSON.parse((typeof localStorage !== 'undefined' && localStorage.getItem(HUB_SENT_KEY)) || '{}') || {}
  } catch {
    hubSent = {}
  }

  return hubSent
}

function rememberHubSent(key, sig) {
  const m = hubSentMap()

  delete m[key]
  m[key] = sig

  const keys = Object.keys(m)

  for (const k of keys.slice(0, Math.max(0, keys.length - 200))) {
    delete m[k]
  }

  try {
    localStorage.setItem(HUB_SENT_KEY, JSON.stringify(m))
  } catch {
    /* private mode / quota: the in-memory map still dedupes this window */
  }
}

function hubState(agent) {
  const st = S.goals[agent]
  const d = st && st.data
  const goals = ((d && d.goals) || []).filter(g => g.status === 'active')
  const lines = goals.length ? goals.map(g => `- ${g.id}${g.id === d.current ? ' (current)' : ''}: ${g.title}${g.stale ? ` (idle ${g.idle_days}d: close or drop it)` : ''}`).join('\n') : '- (none)'
  const tools = ((S.tools[agent] && S.tools[agent].data && S.tools[agent].data.tools) || []).slice(0, 30)
  const toolLines = tools.length ? tools.map(t => `- ${t.id} ${t.name}: ${t.target}`).join('\n') : '- (none)'

  return `Active goals:\n${lines}\nSaved tools:\n${toolLines}`
}

// Returns { block, key, sig }: block is '' when this session already has the current state.
function goalsBlock(agent, runtime) {
  const state = hubState(agent)
  const key = `${agent}:${runtime || ''}`
  const first = !(key in hubSentMap())

  if (!first && hubSentMap()[key] === state) {
    return { block: '', key, sig: state }
  }

  const team = list('agents', 'agents').length > 1
  const teamMd = (S.team && S.team.data && S.team.data.team_md) || '<HERMES_HOME>/agents-hub/TEAM.md'
  const shared = (S.team && S.team.data && S.team.data.shared_dir) || (S.shared && S.shared.data && S.shared.data.dir) || ''
  const block = [
    '<hub-goals>',
    first ? 'Agents Hub chat. Rules for goals, saved tools and file edits: skill agents-hub:hub-operating (load it once per session); reply with <hub-goals-update>/<hub-tools-update> only when they change.' : 'Hub state changed:',
    state,
    first && team ? `Team: ${teamMd}${shared ? `; shared team space ${shared}` : ''}; skill agents-hub:team-coordination when work needs other members.` : null,
    '</hub-goals>'
  ]
    .filter(Boolean)
    .join('\n')

  return { block, key, sig: state }
}

const previewKey = (agent, path) => `${agent}::${path}`

async function fetchPreview(agent, path) {
  if (!C || !agent || !path) {
    return
  }

  const key = previewKey(agent, path)
  const prev = S.preview[key]

  S.preview = { ...S.preview, [key]: res(prev && prev.data ? 'ready' : 'loading', prev ? prev.data : null) }
  emit()

  try {
    const data = await C.rest(`/agents/${enc(agent)}/file?path=${enc(path)}`)

    S.preview = { ...S.preview, [key]: res('ready', data) }
  } catch (err) {
    S.preview = { ...S.preview, [key]: res('error', prev ? prev.data : null, errText(err)) }
  }

  emit()
}

function openSideFile(agent, path) {
  setUi({ side: true, sideFile: path, handoff: null })
  void fetchPreview(agent, path)
}

/* model + reasoning */

const REASONING_LEVELS = [
  { id: 'none', label: 'Off' },
  { id: 'minimal', label: 'Minimal' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' }
]

const reasoningLabel = id => {
  const lv = REASONING_LEVELS.find(x => x.id === String(id || '').toLowerCase())

  return lv ? lv.label : id ? String(id) : 'Default'
}

function currentModel(s, agent) {
  const a = (s.agents.data && Array.isArray(s.agents.data.agents) ? s.agents.data.agents : []).find(x => x.id === agent)
  const lv = s.live[agent]
  const info = lv && lv.info

  return {
    model: (info && info.model) || (a && a.model) || '',
    provider: (info && info.provider) || (a && a.provider) || '',
    effort: (info && info.reasoning_effort) || (a && a.reasoning_effort) || '',
    live: !!(info && info.model),
    pending: lv && lv.pendingModel
  }
}

async function loadModelOptions(agent, { refresh = false } = {}) {
  const prev = S.models[agent]

  if (prev && prev.status === 'loading') {
    return
  }

  S.models = { ...S.models, [agent]: res('loading', prev ? prev.data : null) }
  emit()

  try {
    const lv = liveOf(agent)
    const data = await rp(agent, 'model.options', { ...(lv && lv.runtime ? { session_id: lv.runtime } : {}), ...(refresh ? { refresh: true } : {}) })

    S.models = { ...S.models, [agent]: res('ready', data) }
  } catch (err) {
    S.models = { ...S.models, [agent]: res('error', prev ? prev.data : null, errText(err)) }
  }

  emit()
}

async function switchModel(agent, provider, model) {
  setLive(agent, { pendingModel: { provider, model }, modelError: null })

  try {
    const runtime = await ensureRuntime(agent, { create: true, fg: true })
    const value = `${model} --provider ${provider} --session`
    let r = await rp(agent, 'config.set', { session_id: runtime, key: 'model', value })

    if (r && r.confirm_required) {
      const ok = typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm(r.confirm_message || `Use model ${model}?`) : false

      if (!ok) {
        setLive(agent, { pendingModel: null })

        return
      }

      r = await rp(agent, 'config.set', { session_id: runtime, key: 'model', value, confirm_expensive_model: true })
    }

    setLive(agent, cur => ({ pendingModel: null, info: r && r.deferred ? cur.info : { ...(cur.info || {}), model, provider } }))

    if (r && r.deferred && typeof host.notify === 'function') {
      host.notify({ kind: 'info', message: `The agent is running; model ${model} applies from the next turn.` })
    }

    void pollEvents(agent)
  } catch (err) {
    setLive(agent, { pendingModel: null, modelError: errText(err) })
  }
}

async function switchReasoning(agent, effort) {
  setLive(agent, { modelError: null })

  try {
    const runtime = await ensureRuntime(agent, { create: true, fg: true })
    const r = await rp(agent, 'config.set', { session_id: runtime, key: 'reasoning', value: effort })
    const value = r && typeof r.value === 'string' && r.value ? r.value : effort

    setLive(agent, cur => ({ info: { ...(cur.info || {}), reasoning_effort: value } }))
    void pollEvents(agent)
  } catch (err) {
    setLive(agent, { modelError: errText(err) })
  }
}

/* slash commands */

function pushCmdLog(agent, entry) {
  const cur = (S.cmdlog[agent] || []).filter(e => e.id !== entry.id)

  S.cmdlog = { ...S.cmdlog, [agent]: [...cur, entry].slice(-20) }
  emit()
}

async function runSlash(agent, raw, depth = 0) {
  const text = String(raw || '').trim()
  const m = /^\/+([^\s]+)\s*([\s\S]*)$/.exec(text)

  if (!m || depth > 3) {
    return
  }

  const [, name, arg] = m
  const id = `cmd-${Date.now()}-${Math.random()}`

  pushCmdLog(agent, { id, text, state: 'run', output: '', at: Date.now() / 1000 })

  try {
    const runtime = await ensureRuntime(agent, { create: true, fg: true })
    let r

    try {
      r = await rp(agent, 'slash.exec', { session_id: runtime, command: text.replace(/^\/+/, '') })
    } catch (err) {
      if (!/4018|command\.dispatch|skill command|not a quick/i.test(errText(err))) {
        throw err
      }

      r = await rp(agent, 'command.dispatch', { session_id: runtime, name, arg })
    }

    const type = r && r.type

    if (type === 'alias' && r.target) {
      pushCmdLog(agent, { id, text, state: 'done', output: `Switch to /${r.target}`, at: Date.now() / 1000 })
      await runSlash(agent, `/${String(r.target).replace(/^\/+/, '')}${arg ? ` ${arg}` : ''}`, depth + 1)

      return
    }

    if ((type === 'send' || type === 'skill') && r.message) {
      pushCmdLog(agent, { id, text, state: 'done', output: r.notice || (type === 'skill' ? `Loaded skill ${r.name || name}` : 'Sent to the agent'), at: Date.now() / 1000 })
      await sendMessage(agent, String(r.message), [], { display: text })

      return
    }

    if (type === 'prefill' && r.message) {
      drafts[agent] = String(r.message)
      pushCmdLog(agent, { id, text, state: 'done', output: r.notice || 'Filled into the chat box', at: Date.now() / 1000, prefill: String(r.message) })

      return
    }

    const output = r && (r.output || r.notice || r.message || r.confirm_message)

    pushCmdLog(agent, { id, text, state: r && r.status === 'pending' ? 'run' : 'done', output: output ? String(output) : 'Command ran.', at: Date.now() / 1000 })
    void pollEvents(agent)
  } catch (err) {
    pushCmdLog(agent, { id, text, state: 'err', output: errText(err), at: Date.now() / 1000 })
  }
}

/* send flow */

const COMPOSER_MAX_LINES = 15
const MAX_ATTACH = 50
const ATT_VISIBLE = 10
const MAX_ATTACH_BYTES = 25 * 1024 * 1024
const draftAtt = {}

const normText = v => String(v || '').replace(/\s+/g, ' ').trim()

// Hermes stores a sent message as text only: the image the owner attached is staged under the agent's
// cache/images/ but not recorded on the row. The Hub remembers which saved message carried which images
// (paths only, in plugin storage) and shows them again: from memory right after sending, through
// GET /image after a reload.
const SENT_ATT_KEY = 'sentAttachments'
const SENT_ATT_MAX = 300
const attData = {}
let sentAtt = null

function sentAttMap() {
  if (!sentAtt) {
    const v = C && C.storage ? C.storage.get(SENT_ATT_KEY, null) : null
    sentAtt = v && typeof v === 'object' ? v : {}
  }

  return sentAtt
}

function bindSentAttachments(agent, messageId, atts) {
  const key = `${agent}:${messageId}`
  const map = sentAttMap()

  if (map[key] || !Array.isArray(atts) || atts.length === 0) {
    return
  }

  map[key] = atts.map(a => ({ name: a.name, kind: a.kind, size: a.size || 0, path: a.stagedPath || a.path || null }))
  atts.forEach((a, i) => {
    if (a.dataUrl) {
      attData[`${key}:${i}`] = a.dataUrl
    }
  })
  const keys = Object.keys(map)

  if (keys.length > SENT_ATT_MAX) {
    keys.slice(0, keys.length - SENT_ATT_MAX).forEach(k => delete map[k])
  }

  try {
    C.storage.set(SENT_ATT_KEY, map)
  } catch {
    /* storage full or unavailable: memory still holds this session */
  }
}

function withSentAttachments(agent, m) {
  if (!m || m.role !== 'user' || (Array.isArray(m.attachments) && m.attachments.length)) {
    return m
  }

  const key = `${agent}:${m.id}`
  const list = sentAttMap()[key]

  return list ? { ...m, attachments: list.map((a, i) => ({ ...a, agent, dataUrl: attData[`${key}:${i}`] || null })) } : m
}

async function loadStagedImage(agent, path) {
  const key = `img:${agent}:${path}`

  if (attData[key] !== undefined) {
    return attData[key]
  }

  attData[key] = null

  try {
    const r = await C.rest(`/image?agent=${encodeURIComponent(agent)}&path=${encodeURIComponent(path)}`)
    attData[key] = (r && r.data_url) || false
  } catch {
    attData[key] = false
  }

  return attData[key]
}

// The saved row of a given send: newer than the send and, when there was text, carrying that text, so a
// message sent a moment earlier is never mistaken for it.
function isSavedRowOf(it, content, sentAt) {
  const want = normText(content).slice(0, 60)

  return it.type === 'message' && it.role === 'user' && !it.auto && Number(it.timestamp) >= num(sentAt) - 2 && (!want || normText(it.content).includes(want))
}

// Sends with attachments still waiting for their saved row. Kept apart from the pending bubble, which is
// cleared when the turn ends, often before the saved row has been fetched.
let pendingAtt = []

function rememberSentAttachments(agent, content, sentAt, atts) {
  if (Array.isArray(atts) && atts.length) {
    pendingAtt = [...pendingAtt.filter(p => Date.now() / 1000 - p.sentAt < 3600), { agent, content, sentAt, atts }]
  }
}

function bindPendingAttachments(agent, items) {
  if (!pendingAtt.length) {
    return
  }

  pendingAtt = pendingAtt.filter(p => {
    if (p.agent !== agent) {
      return true
    }

    const saved = items.find(it => isSavedRowOf(it, p.content, p.sentAt) && !sentAttMap()[`${agent}:${it.id}`])

    if (saved) {
      bindSentAttachments(agent, saved.id, p.atts)

      return false
    }

    return true
  })
}

async function stageAttachments(agent, runtime, atts) {
  const refs = []

  for (const att of atts) {
    if (att.kind === 'image') {
      const r = await rp(agent, 'image.attach_bytes', { session_id: runtime, content_base64: String(att.dataUrl).split(',')[1] || '', filename: att.name })

      if (r && r.attached === false) {
        throw new Error(r.message || `Could not attach ${att.name}`)
      }

      if (r && typeof r.path === 'string') {
        att.stagedPath = r.path
      }
    } else {
      const r = await rp(agent, 'file.attach', { session_id: runtime, name: att.name, data_url: att.dataUrl })

      if (!r || r.attached === false || !r.ref_text) {
        throw new Error((r && r.message) || `Could not attach ${att.name}`)
      }

      refs.push(r.ref_text)
    }
  }

  return refs
}

async function sendMessage(agent, text, attachments = [], { display, truncateRowId } = {}) {
  const body = String(text || '').trim()
  const atts = Array.isArray(attachments) ? attachments : []
  const cur = S.send[agent]

  if (!C || (!body && atts.length === 0) || (cur && cur.busy)) {
    return
  }

  if (typeof host.requestProfile !== 'function') {
    setSend(agent, { error: 'This Hermes Desktop version cannot send messages from Agents Hub.', text: body, attachments: atts })

    return
  }

  const token = `${Date.now()}-${Math.random()}`
  const sentAt = Date.now() / 1000
  const alive = () => S && S.send[agent] && S.send[agent].token === token
  const shown = display || body

  setSend(agent, {
    busy: true,
    error: null,
    text: body,
    attachments: atts,
    token,
    sentAt,
    startedMs: Date.now(),
    lastChangeMs: Date.now(),
    sig: '',
    runtime: null,
    phase: 'send',
    optimistic: [{ id: `optimistic-${token}`, role: 'user', content: shown, timestamp: sentAt, attachments: atts.map(a => ({ name: a.name, kind: a.kind, dataUrl: a.kind === 'image' ? a.dataUrl : null })) }]
  })

  try {
    const runtime = await ensureRuntime(agent, { create: true, fg: true })

    if (!runtime) {
      throw new Error('The gateway returned no runtime session id.')
    }

    if (!alive()) {
      return
    }

    setSend(agent, { runtime, phase: atts.length ? 'upload' : 'send' })

    const refs = atts.length ? await stageAttachments(agent, runtime, atts) : []
    rememberSentAttachments(agent, shown, sentAt, atts)
    const images = atts.some(a => a.kind === 'image')
    const prompt = [refs.join('\n'), body].filter(Boolean).join('\n\n') || (images ? 'Please look at the attached image(s).' : '')

    if (!alive()) {
      return
    }

    setLive(agent, cur => ({ turn: cur.turn && cur.turn.active ? cur.turn : { ...newTurn(), phase: 'waiting' } }))
    if (Number.isInteger(truncateRowId)) {
      delete hubSentMap()[`${agent}:${runtime}`] // the cut may remove the turn that carried the Hub state
    }

    const hub = S.goals[agent] && S.goals[agent].status === 'ready' ? goalsBlock(agent, runtime) : null
    const withGoals = hub && hub.block ? `${prompt}\n\n${hub.block}` : prompt
    const cut = Number.isInteger(truncateRowId) ? { confirm_truncate: true, truncate_before_row_id: truncateRowId, confirm_deep_truncate: true } : {}

    await rp(agent, 'prompt.submit', { session_id: runtime, text: withGoals, ...cut })

    if (hub && hub.block) {
      rememberHubSent(hub.key, hub.sig) // only once the agent has it
    }

    if (cut.confirm_truncate) {
      // The cut rows are now inactive server-side: drop every cached page so they disappear.
      S.timeline = { ...S.timeline, [agent]: { ...emptyTimeline(), status: 'loading' } }
      emit()
      void fetchWorkspace(agent)
    }

    if (!alive()) {
      return
    }

    setSend(agent, { phase: 'wait', lastChangeMs: Date.now() })
    void pollEvents(agent)
    void fetchChatMeta(agent)
    void fetchTimeline(agent)
  } catch (err) {
    if (alive()) {
      setLive(agent, cur => ({ turn: cur.turn && cur.turn.phase === 'waiting' ? null : cur.turn }))
      setSend(agent, { busy: false, optimistic: [], phase: null, error: errText(err) })
    }
  }
}

// Fallback when no live events arrive (older gateway): settle on a quiet persisted reply.
async function pollTick(agent) {
  const st = S && S.send[agent]

  if (!C || !st || !st.busy || st.phase !== 'wait') {
    return
  }

  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    return
  }

  if (Date.now() - st.startedMs > MAX_TURN_MS) {
    setSend(agent, { busy: false, optimistic: [], phase: null, error: 'No reply from the agent after 15 minutes. Check the session in the chat view.' })

    return
  }

  await fetchTimeline(agent)

  const now = S.send[agent]
  const lv = liveOf(agent)

  if (!now || !now.busy || now.token !== st.token || (lv && lv.turn && lv.turn.active && lv.turn.phase !== 'waiting')) {
    return
  }

  const items = allTimelineItems(agent)
  const last = items[items.length - 1]
  const sig = `${items.length}:${last ? itemKey(last) : ''}`

  if (sig !== now.sig) {
    setSend(agent, { sig, lastChangeMs: Date.now() })

    return
  }

  const replied = items.some(it => it.type === 'message' && it.role === 'assistant' && it.content && Number(it.timestamp) >= num(now.sentAt) - 2)

  if (replied && Date.now() - now.lastChangeMs >= QUIET_MS) {
    setSend(agent, { busy: false, optimistic: [], phase: null })
    setLive(agent, cur => ({ turn: cur.turn && cur.turn.phase === 'waiting' ? null : cur.turn }))
  }
}

async function stopTurn(agent) {
  const st = S.send[agent] || {}
  const lv = liveOf(agent)
  const runtime = st.runtime || (lv && lv.runtime)

  setSend(agent, { busy: false, optimistic: [], phase: null, token: null })

  if (runtime && typeof host.requestProfile === 'function') {
    try {
      await rp(agent, 'session.interrupt', { session_id: runtime })
    } catch (err) {
      setSend(agent, { error: errText(err) })
    }
  }

  setLive(agent, cur => ({ turn: cur.turn ? { ...cur.turn, active: false, saving: true, phase: 'done', status: 'Stopped' } : null }))
  void finishTurn(agent, { drain: false })
}


/* ── messages typed while the agent works: queue, steer into the running turn, or remove ── */

let queueSeq = 0

function setQueue(agent, items) {
  S.queue = { ...S.queue, [agent]: items }
  emit()
}

function enqueueMessage(agent, text, attachments) {
  setQueue(agent, [...(S.queue[agent] || []), { id: `q${++queueSeq}`, text, attachments: attachments || [], at: Date.now() }])
}

function dropQueued(agent, id) {
  setQueue(agent, (S.queue[agent] || []).filter(x => x.id !== id))
}

// AIAgent.steer via the gateway: the text rides into the next tool result of the live turn, no new user
// turn and no interruption. 'rejected' means the agent went idle meanwhile: send it as a normal message.
async function steerQueued(agent, id) {
  const item = (S.queue[agent] || []).find(x => x.id === id)
  const st = S.send[agent] || {}
  const lv = liveOf(agent)
  const runtime = st.runtime || (lv && lv.runtime)

  if (!item) {
    return
  }

  setQueue(agent, (S.queue[agent] || []).map(x => (x.id === id ? { ...x, steering: true, error: null } : x)))

  try {
    const r = runtime ? await rp(agent, 'session.steer', { session_id: runtime, text: item.text }) : { status: 'rejected' }
    const status = r && r.status

    dropQueued(agent, id)

    if (status === 'rejected') {
      void sendMessage(agent, item.text, item.attachments)
    } else {
      setLive(agent, cur => ({ turn: cur.turn ? { ...cur.turn, steers: [...(cur.turn.steers || []), { text: item.text, at: Date.now(), status: status || 'queued' }] } : cur.turn }))
    }
  } catch (err) {
    setQueue(agent, (S.queue[agent] || []).map(x => (x.id === id ? { ...x, steering: false, error: errText(err) } : x)))
  }
}

// After a turn ends the next queued message goes out as a normal message (one per turn, like the app's queue).
function drainQueue(agent) {
  const items = S.queue[agent] || []
  const st = S.send[agent] || {}

  if (!items.length || st.busy) {
    return
  }

  const [next, ...rest] = items

  setQueue(agent, rest)
  void sendMessage(agent, next.text, next.attachments)
}

function QueueTray({ s, agent, running }) {
  const items = s.queue[agent] || []

  if (!items.length) {
    return null
  }

  return h(
    'div',
    { className: 'ah-queue', role: 'list', 'aria-label': 'Queued messages' },
    items.map(it =>
      h(
        'div',
        { key: it.id, className: 'ah-queue-item', role: 'listitem' },
        h(Icon, { name: 'clock', size: 14, className: 'ah-queue-ic' }),
        h('span', { className: 'ah-queue-text', title: it.text }, it.text || `${it.attachments.length} attachment(s)`),
        it.attachments.length ? h('span', { className: 'ah-queue-att' }, h(Icon, { name: 'attach', size: 12 }), String(it.attachments.length)) : null,
        it.error ? h('span', { className: 'ah-queue-err', title: it.error }, h(Icon, { name: 'warning', size: 12 })) : null,
        h(
          'button',
          {
            type: 'button',
            className: 'ah-queue-steer ah-state',
            disabled: !running || it.steering || it.attachments.length > 0 || !it.text.trim(),
            title: it.attachments.length ? 'Messages with attachments cannot steer; they are sent when the turn ends' : running ? 'Steer: hand this to the agent now, without stopping its work' : 'Sent when the agent is free',
            onClick: () => void steerQueued(agent, it.id)
          },
          it.steering ? h(Icon, { name: 'loading', size: 14, spinning: true }) : h(Icon, { name: 'compass', size: 14 }),
          'Steer'
        ),
        h('button', { type: 'button', className: 'ah-queue-remove ah-state', 'aria-label': 'Remove queued message', title: 'Remove', onClick: () => dropQueued(agent, it.id) }, h(Icon, { name: 'close', size: 14 }))
      )
    ),
    h('span', { className: 'ah-queue-hint' }, running ? 'Queued messages are sent after the current turn. Steer hands one to the agent right away.' : 'Sending queued messages…')
  )
}

/* ───────────────────────── shared small components ───────────────────────── */


function Approvals({ s, agent }) {
  const list = s.approvals[agent] || []
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState(null)

  const answer = async (req, choice) => {
    setBusy(`${req.request_id}:${choice}`)
    setErr(null)

    try {
      await answerApproval(agent, req, choice)
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy('')
    }
  }

  if (list.length === 0) {
    return null
  }

  return h(
    'div',
    { className: 'ah-approvals' },
    list.map(req =>
      h(
        'section',
        { key: req.request_id || req.command, className: 'ah-approval', role: 'alertdialog', 'aria-label': 'Permission request' },
        h('div', { className: 'ah-approval-head' }, h(Icon, { name: 'shield', size: 16 }), h('strong', null, `${agentName(s, agent)} asks to run`), h('span', { className: 'ah-spacer' }), h('time', { className: 'ah-side-time' }, relTime(req.at / 1000, s.now))),
        req.command ? h('pre', { className: 'ah-approval-cmd ah-mono' }, req.command) : null,
        req.description ? h('p', { className: 'ah-approval-why' }, req.description) : null,
        h(
          'div',
          { className: 'ah-approval-acts' },
          h('button', { type: 'button', className: 'ah-btn ah-btn-tonal ah-btn-sm ah-state', disabled: !!busy, onClick: () => void answer(req, 'once') }, h(Icon, { name: 'check', size: 14 }), 'Allow'),
          h('button', { type: 'button', className: 'ah-btn ah-btn-outlined ah-btn-sm ah-state', disabled: !!busy, title: 'Hermes remembers this for the current chat session (the goal in progress)', onClick: () => void answer(req, 'session') }, h(Icon, { name: 'target', size: 14 }), 'Always allow in this goal'),
          h('button', { type: 'button', className: 'ah-btn ah-btn-outlined ah-btn-sm ah-state', disabled: !!busy, title: 'Hermes always allows this kind of command from now on (its permanent allowlist)', onClick: () => void answer(req, 'always') }, h(Icon, { name: 'pass', size: 14 }), 'Always allow'),
          h('span', { className: 'ah-spacer' }),
          h('button', { type: 'button', className: 'ah-btn ah-btn-text ah-btn-sm ah-state ah-btn-danger', disabled: !!busy, onClick: () => void answer(req, 'deny') }, h(Icon, { name: 'close', size: 14 }), 'Deny')
        )
      )
    ),
    err ? h('p', { className: 'ah-live-error', role: 'alert' }, err) : null
  )
}

/* ── agent faces ── */

const MOOD_LABEL = { working: 'Focused, working', happy: 'Happy', waiting: 'Waiting for orders', asking: 'Asking you', thinking: 'Thinking', sleep: 'Offline', error: 'Hit an error' }

// What the agent's face shows: a pending question beats live work, which beats its plain status.
function moodOf(s, agent) {
  if ((s.approvals[agent] || []).length) {
    return 'asking'
  }

  const lv = s.live[agent]
  const turn = lv && lv.turn

  if (turn && turn.active) {
    return turn.phase === 'tool' || turn.phase === 'tool-gen' ? 'working' : turn.phase === 'writing' ? 'happy' : 'thinking'
  }

  if (turn && turn.error && Date.now() - num(turn.endedMs) < 120000) {
    return 'error'
  }

  if (turn && !turn.active && Date.now() - num(turn.endedMs) < 90000) {
    return 'happy'
  }

  const cmds = s.commands && s.commands.data && s.commands.data.counts

  if ((cmds && cmds[agent]) || ((s.activity[agent] && s.activity[agent].data && s.activity[agent].data.items) || []).some(i => i.active)) {
    return 'working'
  }

  const a = list('agents', 'agents').find(x => x.id === agent)

  return statusMood(a && a.status)
}

function statusMood(status) {
  return status === 'active' ? 'working' : status === 'offline' ? 'sleep' : status === 'error' || status === 'failed' ? 'error' : 'waiting'
}

function hashOf(str) {
  let x = 2166136261

  for (const ch of String(str || '')) {
    x = Math.imul(x ^ ch.charCodeAt(0), 16777619)
  }

  return x >>> 0
}

const SKINS = ['#F6D3B3', '#EDB98A', '#D08B5B', '#AE5D29', '#F2C9A0', '#8D5524']
const HAIRS = ['#2C1B12', '#4A2E1A', '#8A5A2B', '#D6A24A', '#1F1F2E', '#B5523B', '#6B6B78']

// Deterministic face per agent id: skin, hair style/colour, glasses or headphones; expression = mood.
function Face({ id, seed, mood = 'waiting' }) {
  // seed: from the team roster (random for new agents, = id for older ones so faces stay put)
  const hsh = hashOf(seed || avatarSeed(id))
  const skin = SKINS[hsh % SKINS.length]
  const hair = HAIRS[(hsh >>> 3) % HAIRS.length]
  const style = (hsh >>> 6) % 5
  const extra = (hsh >>> 9) % 4 // 0 none, 1 glasses, 2 headphones, 3 none
  const ink = '#2B2B33'
  const eye = { stroke: ink, strokeWidth: 1.6, strokeLinecap: 'round', fill: 'none' }
  const hairBack = style === 1 || style === 4 ? h('path', { d: 'M8 22 C8 10 32 10 32 22 L32 33 C28 35 12 35 8 33 Z', fill: hair }) : null
  const hairFront = [
    h('path', { key: 'h0', d: 'M9 19 C9 9 31 9 31 19 C27 15 22 13.5 15 15 C12 16 10 17.5 9 19 Z', fill: hair }),
    h('path', { key: 'h1', d: 'M9 20 C8 9 32 8 31 20 C28 14 24 13 20 13 C15 13 11 15 9 20 Z', fill: hair }),
    h('path', { key: 'h2', d: 'M10 18 C11 10 29 10 30 18 L27 16 L24 18 L21 15 L18 18 L15 15.5 L12 18 Z', fill: hair }),
    h('path', { key: 'h3', d: 'M9 17 C10 8 30 8 31 17 C29 15.5 11 15.5 9 17 Z M11 15 Q20 4 29 15', fill: hair }),
    h('path', { key: 'h4', d: 'M9 21 C8 10 31 7 31 19 C26 18 18 16 13 12 C12 16 10 18 9 21 Z', fill: hair })
  ][style]
  let eyes
  let brows
  let mouth

  switch (mood) {
    case 'happy':
      eyes = [h('path', { key: 'l', d: 'M13.8 22.6 Q15.6 20.4 17.4 22.6', ...eye }), h('path', { key: 'r', d: 'M22.6 22.6 Q24.4 20.4 26.2 22.6', ...eye })]
      brows = [h('path', { key: 'l', d: 'M13.6 18.6 Q15.6 17.4 17.6 18.4', ...eye, strokeWidth: 1.1 }), h('path', { key: 'r', d: 'M22.4 18.4 Q24.4 17.4 26.4 18.6', ...eye, strokeWidth: 1.1 })]
      mouth = h('path', { d: 'M15.5 27.2 Q20 31.5 24.5 27.2 Z', fill: '#B03A48', stroke: ink, strokeWidth: 1, strokeLinejoin: 'round' })
      break
    case 'working':
      eyes = [h('path', { key: 'l', d: 'M14 22.4 H17.4', ...eye, strokeWidth: 2 }), h('path', { key: 'r', d: 'M22.6 22.4 H26', ...eye, strokeWidth: 2 })]
      brows = [h('path', { key: 'l', d: 'M13.6 18.6 L17.6 19.8', ...eye, strokeWidth: 1.2 }), h('path', { key: 'r', d: 'M22.4 19.8 L26.4 18.6', ...eye, strokeWidth: 1.2 })]
      mouth = h('path', { d: 'M17.5 28 H22.5', ...eye, strokeWidth: 1.3 })
      break
    case 'thinking':
      eyes = [h('circle', { key: 'l', cx: 16.4, cy: 21.2, r: 1.5, fill: ink }), h('circle', { key: 'r', cx: 25, cy: 21.2, r: 1.5, fill: ink })]
      brows = [h('path', { key: 'l', d: 'M13.6 18.4 Q15.6 17.2 17.6 18.2', ...eye, strokeWidth: 1.1 }), h('path', { key: 'r', d: 'M22.4 17 Q24.4 16 26.4 17.4', ...eye, strokeWidth: 1.1 })]
      mouth = h('path', { d: 'M18 28.4 Q20.5 27.4 23 28', ...eye, strokeWidth: 1.3 })
      break
    case 'asking':
      eyes = [h('circle', { key: 'l', cx: 15.6, cy: 22, r: 1.6, fill: ink }), h('circle', { key: 'r', cx: 24.4, cy: 22, r: 1.6, fill: ink })]
      brows = [h('path', { key: 'l', d: 'M13.6 18.8 Q15.6 18 17.6 18.8', ...eye, strokeWidth: 1.1 }), h('path', { key: 'r', d: 'M22.4 17.2 Q24.4 15.6 26.4 17', ...eye, strokeWidth: 1.1 })]
      mouth = h('ellipse', { cx: 20, cy: 28.2, rx: 1.6, ry: 1.9, fill: '#7A2A33' })
      break
    case 'sleep':
      eyes = [h('path', { key: 'l', d: 'M14 22.6 Q15.7 23.8 17.4 22.6', ...eye }), h('path', { key: 'r', d: 'M22.6 22.6 Q24.3 23.8 26 22.6', ...eye })]
      brows = null
      mouth = h('path', { d: 'M18.4 28 H21.6', ...eye, strokeWidth: 1.1 })
      break
    case 'error':
      eyes = [h('circle', { key: 'l', cx: 15.6, cy: 22.2, r: 1.5, fill: ink }), h('circle', { key: 'r', cx: 24.4, cy: 22.2, r: 1.5, fill: ink })]
      brows = [h('path', { key: 'l', d: 'M13.8 19.6 L17.4 18.4', ...eye, strokeWidth: 1.2 }), h('path', { key: 'r', d: 'M22.6 18.4 L26.2 19.6', ...eye, strokeWidth: 1.2 })]
      mouth = h('path', { d: 'M16.8 29 Q20 26.6 23.2 29', ...eye, strokeWidth: 1.3 })
      break
    default:
      eyes = [h('circle', { key: 'l', cx: 15.6, cy: 22, r: 1.6, fill: ink }), h('circle', { key: 'r', cx: 24.4, cy: 22, r: 1.6, fill: ink })]
      brows = [h('path', { key: 'l', d: 'M13.6 18.8 Q15.6 17.8 17.6 18.6', ...eye, strokeWidth: 1.1 }), h('path', { key: 'r', d: 'M22.4 18.6 Q24.4 17.8 26.4 18.8', ...eye, strokeWidth: 1.1 })]
      mouth = h('path', { d: 'M17 27.4 Q20 29.6 23 27.4', ...eye, strokeWidth: 1.3 })
  }

  return h(
    'svg',
    { className: cx('ah-face', `is-${mood}`), viewBox: '3 4.5 34 34', 'aria-hidden': 'true', focusable: 'false' },
    h(
      'g',
      { className: 'ah-f-head' },
      hairBack,
      extra === 2 ? h('path', { d: 'M7.5 23 C7.5 6 32.5 6 32.5 23', fill: 'none', stroke: '#30303A', strokeWidth: 2.2 }) : null,
      h('ellipse', { cx: 20, cy: 23, rx: 11, ry: 12, fill: skin }),
      h('ellipse', { cx: 9.2, cy: 23.5, rx: 1.6, ry: 2.4, fill: skin }),
      h('ellipse', { cx: 30.8, cy: 23.5, rx: 1.6, ry: 2.4, fill: skin }),
      hairFront,
      mood === 'happy' ? [h('ellipse', { key: 'c1', cx: 13.6, cy: 25.6, rx: 1.9, ry: 1.1, fill: '#F28B8B', opacity: 0.55 }), h('ellipse', { key: 'c2', cx: 26.4, cy: 25.6, rx: 1.9, ry: 1.1, fill: '#F28B8B', opacity: 0.55 })] : null,
      h('g', { className: 'ah-f-brows' }, brows),
      h('g', { className: 'ah-f-eyes' }, eyes),
      extra === 1 ? h('g', { fill: 'none', stroke: '#2F2F3A', strokeWidth: 1.1 }, h('circle', { cx: 15.6, cy: 22, r: 3.2 }), h('circle', { cx: 24.4, cy: 22, r: 3.2 }), h('path', { d: 'M18.8 22 H21.2' })) : null,
      extra === 2 ? [h('rect', { key: 'p1', x: 6, y: 20, width: 4, height: 7, rx: 2, fill: '#30303A' }), h('rect', { key: 'p2', x: 30, y: 20, width: 4, height: 7, rx: 2, fill: '#30303A' })] : null,
      h('g', { className: 'ah-f-mouth' }, mouth)
    ),
    mood === 'thinking' ? h('g', { className: 'ah-f-think' }, h('circle', { className: 'ah-f-dot', cx: 29, cy: 9, r: 1.4 }), h('circle', { className: 'ah-f-dot', cx: 32.4, cy: 7, r: 1.7 }), h('circle', { className: 'ah-f-dot', cx: 36, cy: 4.6, r: 2 })) : null,
    mood === 'asking' ? h('g', { className: 'ah-f-q' }, h('circle', { cx: 33, cy: 7, r: 5.5, fill: '#FFB020' }), h('text', { x: 33, y: 9.6, textAnchor: 'middle', fontSize: 8, fontWeight: 700, fill: '#2B2B33' }, '?')) : null,
    mood === 'working' ? h('g', { className: 'ah-f-work' }, h('rect', { x: 3, y: 31, width: 12, height: 7, rx: 1.5, fill: '#30303A' }), h('rect', { className: 'ah-f-key', x: 5, y: 33.5, width: 2.5, height: 1.6, fill: '#9FE3B4' }), h('rect', { className: 'ah-f-key', x: 8.5, y: 33.5, width: 2.5, height: 1.6, fill: '#9FE3B4' })) : null,
    mood === 'sleep' ? h('text', { className: 'ah-f-z', x: 31, y: 10, fontSize: 7, fontWeight: 700, fill: '#7C7C8A' }, 'z') : null
  )
}

function Avatar({ id, name, size = 40, status, mood }) {
  const m = mood || statusMood(status)

  return h(
    'span',
    { className: cx('ah-avatar is-face', `mood-${m}`), style: { '--ah-ac': agentColor(id || name), '--ah-size': `${size}px` }, title: MOOD_LABEL[m] || undefined, 'aria-hidden': 'true' },
    h(Face, { id: id || name, mood: m }),
    h('span', { className: 'ah-avatar-text ah-sr' }, initialsOf(name, id)),
    status ? h('span', { className: cx('ah-avatar-dot', `is-${(AGENT_STATUS[status] || AGENT_STATUS.offline).tone}`) }) : null
  )
}

function Chip({ tone = 'neutral', icon, children, title }) {
  return h(
    'span',
    { className: cx('ah-chip', `is-${tone}`), title },
    icon ? h(Icon, { name: icon, size: 14 }) : null,
    h('span', null, children)
  )
}

function StatusChip({ status }) {
  const key = String(status || '').toLowerCase()

  return h(Chip, { tone: STATUS_TONE[key] || 'neutral' }, STATUS_LABEL[key] || status || 'Unknown')
}

function Skeleton({ rows = 4, className }) {
  return h(
    'div',
    { className: cx('ah-skel-wrap', className), 'aria-busy': 'true', 'aria-label': 'Loading' },
    Array.from({ length: rows }, (_, i) => h('div', { key: i, className: 'ah-skel', style: { width: `${92 - ((i * 13) % 35)}%` } }))
  )
}

function ErrorState({ message, detail, onRetry, compactMode }) {
  return h(
    'div',
    { className: cx('ah-state-box', compactMode && 'is-compact'), role: 'alert' },
    h('span', { className: 'ah-state-icon is-err' }, h(Icon, { name: 'warning', size: 24 })),
    h('p', { className: 'ah-state-title' }, message),
    detail ? h('p', { className: 'ah-state-detail' }, detail) : null,
    onRetry ? h('button', { type: 'button', className: 'ah-btn ah-btn-tonal ah-state', onClick: onRetry }, 'Retry') : null
  )
}

function EmptyState({ icon = 'inbox', title, hint }) {
  return h(
    'div',
    { className: 'ah-state-box' },
    h('span', { className: 'ah-state-icon' }, h(Icon, { name: icon, size: 24 })),
    h('p', { className: 'ah-state-title' }, title),
    hint ? h('p', { className: 'ah-state-detail' }, hint) : null
  )
}

function navKeys(event) {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']

  if (!keys.includes(event.key)) {
    return
  }

  const items = Array.from(event.currentTarget.querySelectorAll('[data-nav]:not([disabled])'))

  if (items.length === 0) {
    return
  }

  const at = items.indexOf(event.target.closest ? event.target.closest('[data-nav]') : event.target)
  let next = at

  if (event.key === 'ArrowDown') {
    next = Math.min(items.length - 1, at + 1)
  } else if (event.key === 'ArrowUp') {
    next = Math.max(0, at <= 0 ? 0 : at - 1)
  } else if (event.key === 'Home') {
    next = 0
  } else {
    next = items.length - 1
  }

  event.preventDefault()
  items[next].focus()
}

/* ───────────────────────── app bar ───────────────────────── */

function AppBar({ s }) {
  const { ui } = s
  const failed = s.agents.status === 'error' && ((s.agentFails || 0) >= 2 || !s.agents.data)
  const ago = s.fetchedAt ? relTime(s.fetchedAt / 1000, s.now) : null

  const liveText = failed ? 'Backend disconnected' : ago ? `Updated ${ago}` : 'Connecting'

  return h(
    'header',
    { className: 'ah-appbar' },
    h('h1', { className: 'ah-title' }, 'Agents Hub'),
    h(
      'span',
      { className: 'ah-live', role: 'status', 'aria-live': 'polite' },
      h('span', { className: cx('ah-live-dot', failed ? 'is-err' : ago ? 'is-ok' : 'is-wait'), 'aria-hidden': 'true' }),
      h('span', null, liveText)
    ),
    h('span', { className: 'ah-spacer' }),
    h(
      'label',
      { className: 'ah-search' },
      h('span', { className: 'ah-sr' }, 'Search this tab'),
      h(Icon, { name: 'search', size: 16 }),
      h('input', {
        type: 'search',
        value: ui.q,
        placeholder: 'Search',
        autoComplete: 'off',
        onChange: e => {
          S.ui = { ...S.ui, q: e.target.value }
          emit()
        }
      })
    ),
    h(
      'button',
      {
        type: 'button',
        className: 'ah-icon-btn ah-state',
        'aria-label': 'Refresh',
        title: 'Refresh',
        disabled: s.refreshing,
        'aria-busy': s.refreshing ? 'true' : 'false',
        onClick: () => void load()
      },
      h(Icon, { name: 'refresh', size: 18, spinning: s.refreshing })
    )
  )
}

/* ───────────────────────── tiny safe markdown ───────────────────────── */

function inlineMd(text, base) {
  const out = []
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^)\s]+\))|(?<![*\w])(\*[^*\s][^*\n]*?\*)(?![*\w])/g
  let last = 0
  let m
  let i = 0

  while ((m = re.exec(text))) {
    if (m.index > last) {
      out.push(text.slice(last, m.index))
    }

    if (m[1]) {
      out.push(h('code', { key: `${base}c${i}`, className: 'ah-md-code' }, m[1].slice(1, -1)))
    } else if (m[2]) {
      out.push(h('strong', { key: `${base}b${i}` }, m[2].slice(2, -2)))
    } else if (m[3]) {
      // Links are shown as text plus the address; nothing navigates from here.
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(m[3])

      out.push(h('span', { key: `${base}l${i}`, className: 'ah-md-link' }, mm[1], h('span', { className: 'ah-md-url' }, ` (${mm[2]})`)))
    } else {
      out.push(h('em', { key: `${base}e${i}` }, m[4].slice(1, -1)))
    }

    last = m.index + m[0].length
    i += 1
  }

  if (last < text.length) {
    out.push(text.slice(last))
  }

  return out
}

const splitRow = line =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(c => c.trim())

const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

function renderMarkdown(text, depth = 0) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let para = []
  let at = 0

  const flush = () => {
    if (para.length === 0) {
      return
    }

    const key = `p${blocks.length}`
    const kids = []

    para.forEach((ln, j) => {
      if (j > 0) {
        kids.push(h('br', { key: `br${j}` }))
      }

      kids.push(...inlineMd(ln, `${key}-${j}-`))
    })
    blocks.push(h('p', { key, className: 'ah-md-p' }, kids))
    para = []
  }

  while (at < lines.length) {
    const line = lines[at]
    const bullet = /^\s*[-*\u2022]\s+(.*)$/.exec(line)
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line)

    if (/^\s*```/.test(line)) {
      flush()
      const code = []

      at += 1

      while (at < lines.length && !/^\s*```/.test(lines[at])) {
        code.push(lines[at])
        at += 1
      }

      at += 1
      blocks.push(h('pre', { key: `pre${blocks.length}`, className: 'ah-md-pre' }, h('code', null, code.join('\n'))))
    } else if (line.includes('|') && at + 1 < lines.length && TABLE_SEP.test(lines[at + 1]) && lines[at + 1].includes('-')) {
      flush()
      const head = splitRow(line)
      const rows = []

      at += 2

      while (at < lines.length && lines[at].includes('|') && lines[at].trim() !== '') {
        rows.push(splitRow(lines[at]))
        at += 1
      }

      const key = `tb${blocks.length}`

      blocks.push(
        h(
          'div',
          { key, className: 'ah-md-tablewrap' },
          h(
            'table',
            { className: 'ah-md-table' },
            h('thead', null, h('tr', null, head.map((c, j) => h('th', { key: `${key}h${j}`, scope: 'col' }, inlineMd(c, `${key}h${j}-`))))),
            h('tbody', null, rows.map((r, ri) => h('tr', { key: `${key}r${ri}` }, head.map((_, j) => h('td', { key: `${key}r${ri}c${j}` }, inlineMd(r[j] || '', `${key}r${ri}c${j}-`))))))
          )
        )
      )
    } else if (/^\s{0,3}>/.test(line) && depth < 3) {
      flush()
      const quote = []

      while (at < lines.length && /^\s{0,3}>/.test(lines[at])) {
        quote.push(lines[at].replace(/^\s{0,3}>\s?/, ''))
        at += 1
      }

      blocks.push(h('blockquote', { key: `q${blocks.length}`, className: 'ah-md-quote' }, renderMarkdown(quote.join('\n'), depth + 1)))
    } else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flush()
      blocks.push(h('hr', { key: `hr${blocks.length}`, className: 'ah-md-hr' }))
      at += 1
    } else if (bullet || ordered) {
      flush()
      const re = bullet ? /^\s*[-*\u2022]\s+(.*)$/ : /^\s*\d+[.)]\s+(.*)$/
      const items = []

      while (at < lines.length && re.test(lines[at])) {
        items.push(re.exec(lines[at])[1])
        at += 1
      }

      const key = `l${blocks.length}`

      blocks.push(h(bullet ? 'ul' : 'ol', { key, className: 'ah-md-list' }, items.map((it, j) => h('li', { key: `${key}-${j}` }, inlineMd(it, `${key}-${j}-`)))))
    } else if (heading) {
      flush()
      const level = heading[1].length

      blocks.push(h('p', { key: `h${blocks.length}`, className: cx('ah-md-p ah-md-h', level <= 2 ? 'is-lg' : 'is-sm') }, inlineMd(heading[2], `h${blocks.length}-`)))
      at += 1
    } else if (line.trim() === '') {
      flush()
      at += 1
    } else {
      para.push(line)
      at += 1
    }
  }

  flush()

  return blocks
}

// Reply tags the Hub applies (goals, saved tools) never show, not even half-streamed.
const HUB_REPLY_TAG = /<hub-(goals|tools)-update>[\s\S]*?(<\/hub-\1-update>|$)/g
const hideHubTags = text => (typeof text === 'string' && text.includes('<hub-') ? text.replace(HUB_REPLY_TAG, '').trimEnd() : text)

function Markdown({ text }) {
  return h('div', { className: 'ah-md' }, renderMarkdown(hideHubTags(text)))
}

/* ───────────────────────── agents rail ───────────────────────── */

const RAIL_GROUPS = [
  { id: 'lead', label: 'Leadership' },
  { id: 'eng', label: 'Engineering' },
  { id: 'biz', label: 'Business & operations' },
  { id: 'other', label: 'Other' }
]

const LEAD_ORDER = ['default', 'manager', 'tech-lead']
const BIZ_IDS = ['marketing', 'sales', 'customer-success', 'process']

function groupOf(id) {
  if (LEAD_ORDER.includes(id)) {
    return 'lead'
  }

  if (String(id).startsWith('dev-')) {
    return 'eng'
  }

  return BIZ_IDS.includes(id) ? 'biz' : 'other'
}

function groupAgents(agents) {
  return RAIL_GROUPS.map(g => {
    const items = agents.filter(a => groupOf(a.id) === g.id)

    if (g.id === 'lead') {
      items.sort((a, b) => LEAD_ORDER.indexOf(a.id) - LEAD_ORDER.indexOf(b.id))
    }

    return { ...g, items }
  }).filter(g => g.items.length > 0)
}

function cmdCount(s, agent) {
  const c = s.commands && s.commands.data && s.commands.data.counts

  return (c && num(c[agent])) || 0
}

function Rail({ s }) {
  const agents = list('agents', 'agents')
  const { ui } = s
  const shown = agents.filter(a => matches(ui.q, a.name, a.id, a.role, a.model))
  let body

  if (s.agents.status === 'loading' || (s.agents.status === 'idle' && !s.agents.data)) {
    body = h(Skeleton, { rows: 6, className: 'ah-rail-skel' })
  } else if (s.agents.status === 'error' && agents.length === 0) {
    body = h('p', { className: 'ah-rail-note' }, 'Could not load the agent list.')
  } else if (shown.length === 0) {
    body = h('p', { className: 'ah-rail-note' }, 'No agent matches.')
  } else {
    body = groupAgents(shown).map(g =>
      h(
        'div',
        { key: g.id, className: 'ah-rail-group', role: 'group', 'aria-labelledby': `ah-rg-${g.id}` },
        h('h3', { id: `ah-rg-${g.id}`, className: 'ah-rail-section' }, g.label),
        g.items.map(a => {
          const st = AGENT_STATUS[a.status] || AGENT_STATUS.offline
          const selected = ui.agent === a.id
          const label = a.name || a.id
          const lvA = s.live[a.id]
          const liveTurn = lvA && lvA.turn && lvA.turn.active ? lvA.turn : null
          const liveModel = lvA && lvA.info && lvA.info.model
          const meta = liveTurn ? (PHASES[liveTurn.phase] || PHASES.thinking).label : `${liveModel || a.model ? `${liveModel || a.model} \u00b7 ` : ''}${num(a.messages_24h)} msgs/24h`

          return h(
            'button',
            {
              key: a.id,
              type: 'button',
              'data-nav': '',
              className: cx('ah-agent ah-state', selected && 'is-selected'),
              'aria-pressed': selected ? 'true' : 'false',
              'aria-label': `${label}, ${a.role || a.id}, ${st.label}`,
              title: label,
              onClick: () => setUi({ agent: selected ? null : a.id })
            },
            h('span', { className: cx('ah-live-av', liveTurn && 'is-on') }, h(Avatar, { id: a.id, name: label, status: a.status, mood: moodOf(s, a.id) })),
            h(
              'span',
              { className: 'ah-agent-body' },
              h('span', { className: 'ah-agent-name' }, label),
              h('span', { className: 'ah-agent-role' }, a.role || a.id),
              h('span', { className: cx('ah-agent-meta', liveTurn && 'is-live'), title: a.provider || undefined }, meta)
            ),
            cmdCount(s, a.id) ? h('span', { className: 'ah-agent-cmds', title: `${cmdCount(s, a.id)} running commands` }, h(Icon, { name: 'terminal', size: 12 }), cmdCount(s, a.id)) : null
          )
        })
      )
    )
  }

  return h(
    'nav',
    { className: 'ah-rail', 'aria-label': 'Agents' },
    h(
      'div',
      { className: 'ah-rail-head' },
      h('h2', { className: 'ah-rail-title' }, 'Agent'),
      h('span', { className: 'ah-rail-count' }, agents.length ? `${agents.length}` : '')
    ),
    h(
      'button',
      {
        type: 'button',
        'data-nav': '',
        className: cx('ah-agent ah-agent-all ah-state', !ui.agent && 'is-selected'),
        'aria-pressed': !ui.agent ? 'true' : 'false',
        'aria-label': 'All agents, no filter',
        title: 'All agents',
        onClick: () => setUi({ agent: null })
      },
      h('span', { className: 'ah-avatar is-all', style: { '--ah-size': '40px' }, 'aria-hidden': 'true' }, h(Icon, { name: 'organization', size: 20 })),
      h('span', { className: 'ah-agent-body' }, h('span', { className: 'ah-agent-name' }, 'All agents'), h('span', { className: 'ah-agent-role' }, 'No filter'))
    ),
    h('div', { className: 'ah-rail-list', onKeyDown: navKeys }, body)
  )
}

/* ───────────────────────── tabs ───────────────────────── */

function tabCounts(s) {
  const sel = s.ui.agent
  const conv = list('conversations', 'conversations').filter(c => !sel || c.from_agent === sel || c.to_agent === sel)
  const works = list('works', 'works').filter(w => !sel || w.agent === sel)
  const tasks = list('tasks', 'tasks').filter(t => !sel || t.assignee === sel || t.created_by === sel)
  const open = tasks.filter(t => t.status !== 'done' && t.status !== 'archived')
  const files = list('changes', 'repos').reduce((n, r) => n + (Array.isArray(r.files) ? r.files.length : 0), 0)

  return { overview: null, conversations: conv.length, works: works.length, tasks: open.length, changes: files }
}

function Tabs({ s }) {
  const counts = tabCounts(s)
  const tabs = tabsFor(s.ui.agent)
  const tab = effectiveTab(s.ui)

  const onKey = e => {
    const idx = tabs.findIndex(t => t.id === tab)
    let next = null

    if (e.key === 'ArrowRight') {
      next = (idx + 1) % tabs.length
    } else if (e.key === 'ArrowLeft') {
      next = (idx - 1 + tabs.length) % tabs.length
    } else if (e.key === 'Home') {
      next = 0
    } else if (e.key === 'End') {
      next = tabs.length - 1
    }

    if (next === null) {
      return
    }

    e.preventDefault()
    setUi({ tab: tabs[next].id })
    const buttons = e.currentTarget.querySelectorAll('[role="tab"]')

    if (buttons[next]) {
      buttons[next].focus()
    }
  }

  return h(
    'div',
    { className: 'ah-tabs', role: 'tablist', 'aria-label': 'Agents Hub sections', onKeyDown: onKey },
    tabs.map(t => {
      const selected = tab === t.id
      const count = counts[t.id]

      return h(
        'button',
        {
          key: t.id,
          type: 'button',
          role: 'tab',
          id: `ah-tab-${t.id}`,
          'aria-selected': selected ? 'true' : 'false',
          'aria-controls': `ah-panel-${t.id}`,
          tabIndex: selected ? 0 : -1,
          className: cx('ah-tab ah-state', selected && 'is-selected'),
          onClick: () => setUi({ tab: t.id })
        },
        h(Icon, { name: t.icon, size: 16 }),
        h('span', null, t.label),
        count ? h('span', { className: 'ah-tab-count' }, compact(count)) : null
      )
    }),
    s.ui.agent
      ? h(
          'span',
          { className: 'ah-filter' },
          h(
            'button',
            {
              type: 'button',
              className: 'ah-chip is-filter ah-state',
              'aria-label': `Clear agent filter ${agentName(s, s.ui.agent)}`,
              onClick: () => setUi({ agent: null })
            },
            h('span', null, `Filter: ${agentName(s, s.ui.agent)}`),
            h(Icon, { name: 'close', size: 14 })
          )
        )
      : null
  )
}

function agentName(s, id) {
  const a = list('agents', 'agents').find(x => x.id === id)

  return a ? a.name || a.id : id
}

/* ───────────────────────── overview ───────────────────────── */

function SectionCard({ title, icon, onMore, children }) {
  return h(
    'section',
    { className: 'ah-card' },
    h(
      'header',
      { className: 'ah-card-head' },
      h(Icon, { name: icon, size: 18 }),
      h('h3', { className: 'ah-card-title' }, title),
      h('span', { className: 'ah-spacer' }),
      onMore ? h('button', { type: 'button', className: 'ah-btn ah-btn-text ah-state', onClick: onMore }, 'View all') : null
    ),
    children
  )
}

function Tile({ icon, label, value, hint, onClick }) {
  return h(
    onClick ? 'button' : 'div',
    onClick ? { type: 'button', className: 'ah-tile ah-state', onClick } : { className: 'ah-tile' },
    h('span', { className: 'ah-tile-icon' }, h(Icon, { name: icon, size: 20 })),
    h('span', { className: 'ah-tile-body' }, h('span', { className: 'ah-tile-label' }, label), h('span', { className: 'ah-tile-value' }, value), hint ? h('span', { className: 'ah-tile-hint' }, hint) : null)
  )
}

function useViews(s) {
  const sel = s.ui.agent
  const q = s.ui.q

  return useMemo(() => {
    const agents = list('agents', 'agents')
    const conversations = list('conversations', 'conversations')
      .filter(c => !sel || c.from_agent === sel || c.to_agent === sel)
      .filter(c => matches(q, c.title, c.preview, c.from_agent, c.to_agent, c.kind))
    const works = list('works', 'works')
      .filter(w => !sel || w.agent === sel)
      .filter(w => matches(q, w.title, w.agent, w.schedule, w.last_result, w.kind))
    const tasks = list('tasks', 'tasks')
      .filter(t => !sel || t.assignee === sel || t.created_by === sel)
      .filter(t => matches(q, t.title, t.assignee, t.created_by, t.branch_name))
    const repos = list('changes', 'repos')

    return { agents, conversations, works, tasks, repos }
  }, [s.agents, s.conversations, s.works, s.tasks, s.changes, sel, q])
}

const GOAL_ACTION = { add: 'Add', done: 'Complete', edit: 'Edit', delete: 'Delete', drop: 'Drop', reopen: 'Reopen', current: 'Set current' }
const GOAL_ACTION_ICON = { add: 'add', done: 'pass-filled', edit: 'edit', delete: 'trash', drop: 'circle-slash', reopen: 'debug-restart', current: 'target' }

function GoalsOverview({ s }) {
  useEffect(() => {
    void fetchGoalsHistory()
  }, [])

  const d = s.goalsHistory && s.goalsHistory.data
  const openChat = agent => setUi({ agent, tab: 'chat', side: true, sideFile: null, handoff: null })
  const current = (d && d.current) || []
  const events = ((d && d.events) || []).filter(e => !s.ui.agent || e.agent === s.ui.agent)

  return h(
    'div',
    { className: 'ah-grid-2' },
    h(
      SectionCard,
      { title: 'Current goals', icon: 'target' },
      !d
        ? h('p', { className: 'ah-row-sub' }, s.goalsHistory && s.goalsHistory.status === 'error' ? `Could not load goals (${s.goalsHistory.error}).` : 'Loading…')
        : current.length === 0
          ? h(EmptyState, { icon: 'target', title: 'No agent has a goal yet', hint: 'Agents set goals themselves when you give them work in chat.' })
          : h(
              'ul',
              { className: 'ah-rows' },
              current.map(g =>
                h(
                  'li',
                  { key: g.agent },
                  h(
                    'button',
                    { type: 'button', className: 'ah-row ah-state', onClick: () => openChat(g.agent) },
                    h(Avatar, { id: g.agent, name: agentName(s, g.agent), size: 32, mood: moodOf(s, g.agent) }),
                    h('span', { className: 'ah-row-body' }, h('span', { className: 'ah-row-title' }, g.title), h('span', { className: 'ah-row-sub' }, `${agentName(s, g.agent)} · ${g.open} open goals`)),
                    h(Icon, { name: 'target', size: 14 })
                  )
                )
              )
            )
    ),
    h(
      SectionCard,
      { title: 'Goal history', icon: 'history' },
      events.length === 0
        ? h(EmptyState, { icon: 'history', title: 'No goal history yet', hint: 'Every goal added, edited, completed or deleted is logged here.' })
        : h(
            'ul',
            { className: 'ah-rows ah-goal-hist' },
            events.slice(0, 30).map((e, i) =>
              h(
                'li',
                { key: `${e.agent}-${e.goal_id}-${e.at}-${i}` },
                h(
                  'button',
                  { type: 'button', className: 'ah-row ah-state', onClick: () => openChat(e.agent) },
                  h('span', { className: cx('ah-kind-icon', `is-goal-${e.action}`) }, h(Icon, { name: GOAL_ACTION_ICON[e.action] || 'target', size: 16 })),
                  h('span', { className: 'ah-row-body' }, h('span', { className: 'ah-row-title' }, `${GOAL_ACTION[e.action] || e.action}: ${e.title}`), h('span', { className: 'ah-row-sub' }, `${agentName(s, e.agent)} · ${e.by === 'agent' ? 'updated by the agent' : 'You'} · ${relTime(e.at, s.now)}`))
                )
              )
            )
          )
    )
  )
}

// One row per member: what it is working on right now, what blocks it and on whom, what waits in its queue.
const TEAM_RANK = { working: 0, blocked: 1, review: 2, queued: 3, idle: 4 }

function teamRows(s, v) {
  const tasks = (s.tasks && s.tasks.data && s.tasks.data.tasks) || v.tasks || []

  return v.agents
    .map(a => {
      const mine = tasks.filter(t => t.assignee === a.id)
      const running = mine.filter(t => t.status === 'running')
      const blocked = mine.filter(t => t.status === 'blocked')
      const review = mine.filter(t => t.status === 'review')
      const queued = mine.filter(t => ['todo', 'ready', 'triage', 'scheduled'].includes(t.status))
      const state = running.length ? 'working' : blocked.length ? 'blocked' : review.length ? 'review' : queued.length ? 'queued' : 'idle'

      return { a, running, blocked, review, queued, state }
    })
    .sort((x, y) => TEAM_RANK[x.state] - TEAM_RANK[y.state])
}

function TeamNow({ s, v }) {
  const rows = teamRows(s, v)
  const working = rows.filter(r => r.state === 'working').length
  const needOwner = rows.reduce((n, r) => n + r.blocked.filter(t => t.waiting_on === 'owner').length, 0)

  if (!rows.length) {
    return null
  }

  return h(
    SectionCard,
    { title: `Team now · ${working} working${needOwner ? ` · ${needOwner} waiting on you` : ''}`, icon: 'organization', onMore: () => setUi({ tab: 'tasks' }) },
    h(
      'ul',
      { className: 'ah-rows ah-team-now' },
      rows.map(({ a, running, blocked, review, queued, state }) => {
        const t = running[0] || blocked[0] || review[0] || null
        const line =
          state === 'working'
            ? `Working on: ${t.title}${t.progress ? ` · ${t.progress.text}` : ''}${t.updated_at ? ` · ${relTime(t.updated_at, s.now)}` : ''}${running.length > 1 ? ` (+${running.length - 1})` : ''}`
            : state === 'blocked'
              ? `Blocked: ${t.title} · waiting on ${waitingLabel(s, t.waiting_on)}`
              : state === 'review'
                ? `In review: ${t.title}`
                : state === 'queued'
                  ? `${queued.length} task${queued.length > 1 ? 's' : ''} queued`
                  : 'Idle'

        return h(
          'li',
          { key: a.id },
          h(
            'button',
            { type: 'button', className: cx('ah-row ah-state', `is-${state}`), title: t && t.block_reason ? t.block_reason : line, onClick: () => setUi({ agent: a.id, tab: 'chat', handoff: null, sideFile: null }) },
            h('span', { className: cx('ah-live-av', state === 'working' && 'is-on') }, h(Avatar, { id: a.id, name: a.name, size: 32, status: a.status, mood: state === 'working' ? 'working' : state === 'blocked' ? 'waiting' : 'happy' })),
            h('span', { className: 'ah-row-body' }, h('span', { className: 'ah-row-title' }, a.name), h('span', { className: 'ah-row-sub' }, line)),
            h(StatusChip, { status: state === 'working' ? 'running' : state })
          )
        )
      })
    )
  )
}

function SharedSpace({ s }) {
  const d = s.shared && s.shared.data

  if (!d) {
    return null
  }

  const notes = String(d.notes || '')
    .split('\n')
    .filter(l => /^\s*-\s/.test(l))
    .slice(0, 6)
  const files = (d.files || []).slice(0, 6)
  const open = async p => {
    const os = C && C.os

    if (os && typeof os.openExternal === 'function') {
      await os.openExternal(p)
    }
  }

  return h(
    SectionCard,
    { title: 'Shared team space', icon: 'folder-library' },
    h('p', { className: 'ah-row-sub' }, 'Team memory and files every member reads and writes: ', h('code', { className: 'ah-mono' }, d.dir)),
    notes.length
      ? h('ul', { className: 'ah-shared-notes' }, notes.map((l, i) => h('li', { key: i }, l.replace(/^\s*-\s*/, ''))))
      : h('p', { className: 'ah-side-empty' }, 'No team notes yet. Members add one line per durable fact to NOTES.md.'),
    files.length
      ? h(
          'ul',
          { className: 'ah-rows' },
          files.map(f =>
            h('li', { key: f.path }, h('button', { type: 'button', className: 'ah-row ah-state', onClick: () => void open(f.path), title: f.path }, h(Icon, { name: 'file', size: 16 }), h('span', { className: 'ah-row-body' }, h('span', { className: 'ah-row-title' }, f.name), h('span', { className: 'ah-row-sub' }, relTime(f.modified_at, s.now)))))
          )
        )
      : null,
    h('button', { type: 'button', className: 'ah-btn ah-btn-text ah-btn-sm ah-state', onClick: () => void open(d.notes_path) }, h(Icon, { name: 'link-external', size: 14 }), ' Open NOTES.md')
  )
}

function Overview({ s, v }) {
  const day = s.now / 1000 - 86400
  const active = v.agents.filter(a => a.status === 'active').length
  const conv24 = v.conversations.filter(c => num(c.started_at) >= day).length
  const open = v.tasks.filter(t => t.status !== 'done' && t.status !== 'archived').length
  const fileCount = v.repos.reduce((n, r) => n + (Array.isArray(r.files) ? r.files.length : 0), 0)
  const running = v.works.filter(w => w.status === 'running')
  // Running jobs first, then what runs next; paused/finished last. (Showing only running jobs left the card
  // empty while ten jobs were scheduled.)
  const nextAt = w => (w.status === 'running' ? 0 : num(w.next_run_at) || Number.MAX_SAFE_INTEGER)
  const upcoming = v.works.filter(w => w.status !== 'done').slice().sort((a, b) => nextAt(a) - nextAt(b))
  const flatFiles = v.repos
    .flatMap(r => (Array.isArray(r.files) ? r.files : []).map(f => ({ ...f, repo: r })))
    .filter(f => matches(s.ui.q, f.path))
    .sort((a, b) => (a.status === 'hidden') - (b.status === 'hidden'))
    .slice(0, 5)

  const go = tab => setUi({ tab })

  return h(
    'div',
    { className: 'ah-overview' },
    h(
      'div',
      { className: 'ah-tiles' },
      h(Tile, { icon: 'pulse', label: 'Active agents', value: `${active}/${v.agents.length}`, hint: `${v.agents.length - active} agents idle or offline` }),
      h(Tile, { icon: 'comment-discussion', label: 'Conversations in 24h', value: String(conv24), hint: `${v.conversations.length} recent conversations`, onClick: () => go('conversations') }),
      h(Tile, { icon: 'checklist', label: 'Open tasks', value: String(open), hint: `${v.tasks.length} tasks in total`, onClick: () => go('tasks') }),
      h(Tile, { icon: 'git-compare', label: 'Changed files', value: String(fileCount), hint: `${v.repos.length} repositories`, onClick: () => go('changes') })
    ),
    h(TeamNow, { s, v }),
    h(GoalsOverview, { s }),
    h(SharedSpace, { s }),
    h(
      'div',
      { className: 'ah-grid-3' },
      h(
        SectionCard,
        { title: 'Recent conversations', icon: 'comment-discussion', onMore: () => go('conversations') },
        v.conversations.length === 0
          ? h(EmptyState, { icon: 'comment-discussion', title: 'No agent-to-agent conversations yet', hint: 'They appear when one agent delegates work to another.' })
          : h(
              'ul',
              { className: 'ah-rows' },
              v.conversations.slice(0, 5).map(c =>
                h(
                  'li',
                  { key: convKey(c) + c.id },
                  h(
                    'button',
                    { type: 'button', className: 'ah-row ah-state', onClick: () => setUi({ tab: 'conversations', conv: { profile: c.profile, session_id: c.session_id } }) },
                    h(Avatar, { id: c.from_agent, name: agentName(s, c.from_agent), size: 32 }),
                    h('span', { className: 'ah-row-body' }, h('span', { className: 'ah-row-title' }, c.title || `${c.from_agent} and ${c.to_agent}`), h('span', { className: 'ah-row-sub' }, `${agentName(s, c.from_agent)} sent ${agentName(s, c.to_agent)}, ${relTime(c.started_at, s.now)}`)),
                    h(StatusChip, { status: c.status })
                  )
                )
              )
            )
      ),
      h(
        SectionCard,
        { title: 'Scheduled jobs', icon: 'history', onMore: () => go('works') },
        upcoming.length === 0
          ? h(EmptyState, { icon: 'history', title: 'No scheduled jobs', hint: 'Jobs you schedule (Scheduled tab or a Bot) show up here, running ones first.' })
          : h(
              'ul',
              { className: 'ah-rows' },
              upcoming.slice(0, 5).map(w =>
                h(
                  'li',
                  { key: `${w.kind}-${w.id}` },
                  h(
                    'button',
                    { type: 'button', className: 'ah-row ah-state', onClick: () => go('works') },
                    h('span', { className: 'ah-kind-icon' }, h(Icon, { name: KIND_ICON[w.kind] || 'play', size: 16 })),
                    h(
                      'span',
                      { className: 'ah-row-body' },
                      h('span', { className: 'ah-row-title' }, w.title),
                      h('span', { className: 'ah-row-sub' }, `${agentName(s, w.agent)}, ${w.status !== 'running' && w.next_run_at ? `next ${relTime(w.next_run_at, s.now)}` : KIND_LABEL[w.kind] || w.kind}`)
                    ),
                    h(StatusChip, { status: w.status })
                  )
                )
              )
            )
      ),
      h(
        SectionCard,
        { title: 'Changed files', icon: 'git-compare', onMore: () => go('changes') },
        flatFiles.length === 0
          ? h(EmptyState, { icon: 'git-compare', title: 'No changed files', hint: 'All tracked repositories are clean.' })
          : h(
              'ul',
              { className: 'ah-rows' },
              flatFiles.map(f =>
                h(
                  'li',
                  { key: `${f.repo.id}:${f.path}` },
                  h(
                    'button',
                    { type: 'button', className: 'ah-row ah-state', onClick: () => setUi({ tab: 'changes', repo: f.repo.id, file: f.status === 'hidden' ? null : f.path }) },
                    h(FileBadge, { status: f.status }),
                    h('span', { className: 'ah-row-body' }, h('span', { className: 'ah-row-title ah-mono' }, baseOf(f.path)), h('span', { className: 'ah-row-sub' }, f.repo.label || f.repo.path)),
                    f.status === 'hidden' ? null : h(Delta, { a: f.additions, d: f.deletions })
                  )
                )
              )
            )
      )
    )
  )
}

/* ───────────────────────── conversations ───────────────────────── */

function Conversations({ s, v }) {
  const items = v.conversations
  const selected = s.ui.conv && items.find(c => convKey(c) === convKey(s.ui.conv)) ? s.ui.conv : null
  const current = selected || (items[0] ? { profile: items[0].profile, session_id: items[0].session_id } : null)
  const currentKey = convKey(current)

  useEffect(() => {
    if (current && !S.detail[currentKey]) {
      void fetchDetail(current)
    }
  }, [currentKey])

  const meta = items.find(c => convKey(c) === currentKey)

  if (s.conversations.status === 'error' && items.length === 0) {
    return h(ErrorState, { message: 'Could not load conversations', detail: s.conversations.error, onRetry: () => void load() })
  }

  if (s.conversations.status !== 'ready' && !s.conversations.data) {
    return h(Skeleton, { rows: 8, className: 'ah-inset' })
  }

  if (items.length === 0) {
    return h(
      'div',
      { className: 'ah-inset' },
      h(EmptyState, {
        icon: 'comment-discussion',
        title: s.ui.agent || s.ui.q ? 'No conversation matches the filter' : 'No agent-to-agent conversations yet',
        hint: s.ui.agent || s.ui.q ? 'Clear the agent filter or change the search.' : 'They appear when one agent delegates work to another.'
      })
    )
  }

  const detail = S.detail[currentKey]

  return h(
    'div',
    { className: 'ah-split' },
    h(
      'ul',
      { className: 'ah-master', 'aria-label': 'Conversation list', onKeyDown: navKeys },
      items.map(c => {
        const on = convKey(c) === currentKey

        return h(
          'li',
          { key: convKey(c) + c.id },
          h(
            'button',
            {
              type: 'button',
              'data-nav': '',
              className: cx('ah-conv ah-state', on && 'is-selected'),
              'aria-current': on ? 'true' : undefined,
              onClick: () => setUi({ conv: { profile: c.profile, session_id: c.session_id } })
            },
            h('span', { className: 'ah-conv-title' }, c.title || 'Untitled'),
            h(
              'span',
              { className: 'ah-conv-line' },
              h('span', { className: 'ah-conv-names' }, `From ${agentName(s, c.from_agent)} to ${agentName(s, c.to_agent)}`),
              h('time', { className: 'ah-conv-time', title: absTime(c.started_at) }, relTime(c.started_at, s.now))
            ),
            h('span', { className: 'ah-conv-chips' }, h(Chip, { tone: 'flat' }, KIND_LABEL[c.kind] || c.kind), h(StatusChip, { status: c.status }), h('span', { className: 'ah-conv-count' }, `${num(c.message_count)} messages`))
          )
        )
      })
    ),
    h('section', { className: 'ah-detail', 'aria-label': 'Conversation' }, h(Transcript, { s, meta, detail, current }))
  )
}

/* ───────────────────────── message stream (chat + conversations) ───────────────────────── */

const TOOL_NAME_LABEL = { terminal: 'terminal' }

function toolIcon(name) {
  const n = String(name || '').toLowerCase()

  if (n === 'delegate_task' || n.startsWith('delegate')) {
    return 'organization'
  }

  if (n.startsWith('skill')) {
    return 'book'
  }

  if (n.startsWith('web_') || n.startsWith('browser')) {
    return 'globe'
  }

  if (n.includes('search')) {
    return 'search'
  }

  if (n.includes('file') || n === 'patch' || n.includes('edit')) {
    return 'file'
  }

  if (n === 'terminal' || n.includes('shell') || n.includes('bash') || n.includes('exec')) {
    return 'terminal'
  }

  return 'tools'
}

function prettyText(text) {
  const raw = String(text ?? '')
  const t = raw.trim()

  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      return JSON.stringify(JSON.parse(t), null, 2)
    } catch {
      return raw
    }
  }

  return raw
}

function prettyArgs(args) {
  if (!args || typeof args !== 'object' || Object.keys(args).length === 0) {
    return ''
  }

  try {
    return JSON.stringify(args, null, 2)
  } catch {
    return String(args)
  }
}

function ToolCall({ uid, call, result }) {
  const [open, setOpen] = useState(false)
  const name = call.name || 'tools'
  const args = call.args && typeof call.args === 'object' ? call.args : {}
  const isTerm = name === 'terminal' && typeof args.command === 'string'
  const summary = isTerm ? `$ ${args.command}` : call.summary || ''
  const id = `ah-tc-${uid}`
  const argText = isTerm ? `$ ${args.command}` : prettyArgs(args)

  return h(
    'div',
    { className: cx('ah-tc', open && 'is-open') },
    h(
      'button',
      { type: 'button', className: 'ah-tc-row ah-state', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': id, title: summary || name, onClick: () => setOpen(!open) },
      h('span', { className: 'ah-tc-icon' }, h(Icon, { name: toolIcon(name), size: 14 })),
      h('span', { className: 'ah-tc-name' }, TOOL_NAME_LABEL[name] || name),
      h('span', { className: 'ah-tc-sum ah-mono' }, summary),
      h(Icon, { name: open ? 'chevron-down' : 'chevron-right', size: 14 })
    ),
    open
      ? h(
          'div',
          { id, className: 'ah-tc-body' },
          argText ? h('div', { className: 'ah-tc-label' }, isTerm ? 'Commands' : 'Arguments') : null,
          argText ? h('pre', { className: 'ah-tc-pre ah-mono' }, argText) : null,
          h('div', { className: 'ah-tc-label' }, 'Result'),
          result ? h('pre', { className: 'ah-tc-pre ah-tc-result ah-mono' }, prettyText(result.content) || '(empty)') : h('p', { className: 'ah-tc-none' }, 'No result for this step yet.')
        )
      : null
  )
}

// Tool steps and their results are collapsed by default and tagged as run by the agent.
function ToolGroup({ uid, calls, steps, resultById }) {
  const [open, setOpen] = useState(false)
  const [openStep, setOpenStep] = useState({})
  const list = Array.isArray(steps) && steps.length ? steps : [{ label: '', calls }]
  const last = list[list.length - 1]
  const lastLabel = last.label || callLabel(last.calls[last.calls.length - 1])
  const gid = `ah-tg-${uid}`
  const toolRows = (cs, base) => cs.map((c, i) => h(ToolCall, { key: `${c.id || 'c'}-${base}-${i}`, uid: `${uid}-${base}-${i}`, call: c, result: c.id ? resultById.get(c.id) : null }))

  return h(
    'div',
    { className: cx('ah-tg is-auto', open && 'is-open') },
    h(
      'button',
      { type: 'button', className: 'ah-tg-head ah-state', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': gid, onClick: () => setOpen(!open) },
      h(Icon, { name: open ? 'chevron-down' : 'chevron-right', size: 14 }),
      h(Icon, { name: calls.length === 1 ? toolIcon(calls[0].name) : 'tools', size: 14 }),
      h('span', { className: 'ah-auto-tag' }, 'Agent worked on its own'),
      h('span', { className: 'ah-tg-title' }, list.length > 1 ? `${list.length} steps` : 'Step 1', ` · ${calls.length} tools`),
      h('span', { className: cx('ah-tg-names', !last.label && 'ah-mono') }, lastLabel)
    ),
    open
      ? h(
          'ol',
          { id: gid, className: 'ah-tg-list ah-steps' },
          list.map((st, i) => {
            const so = openStep[i] !== undefined ? openStep[i] : list.length === 1

            return h(
              'li',
              { key: i, className: 'ah-step' },
              h(
                'button',
                { type: 'button', className: 'ah-step-head ah-state', 'aria-expanded': so ? 'true' : 'false', onClick: () => setOpenStep({ ...openStep, [i]: !so }) },
                h(Icon, { name: so ? 'chevron-down' : 'chevron-right', size: 12 }),
                h('span', { className: 'ah-step-n' }, `Step ${i + 1}`),
                h('span', { className: 'ah-step-label' }, st.label || callLabel(st.calls[0])),
                h('span', { className: 'ah-step-tools' }, Array.from(new Set(st.calls.map(c => c.name))).slice(0, 3).join(', '))
              ),
              so ? h('div', { className: 'ah-step-body' }, toolRows(st.calls, i)) : null
            )
          })
        )
      : null
  )
}

function OrphanResults({ uid, items }) {
  const [open, setOpen] = useState(false)
  const id = `ah-or-${uid}`

  return h(
    'div',
    { className: 'ah-tg is-auto' },
    h(
      'button',
      { type: 'button', className: 'ah-tg-head ah-state', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': id, onClick: () => setOpen(!open) },
      h(Icon, { name: open ? 'chevron-down' : 'chevron-right', size: 14 }),
      h(Icon, { name: 'output', size: 14 }),
      h('span', { className: 'ah-auto-tag' }, 'Auto'),
      h('span', { className: 'ah-tg-title' }, 'Tool results'),
      h('span', { className: 'ah-tg-names' }, `${items.length} results`)
    ),
    open
      ? h(
          'div',
          { id, className: 'ah-tg-list' },
          items.map((m, i) => h('div', { key: `${m.id}-${i}`, className: 'ah-tc is-open' }, h('div', { className: 'ah-tc-body' }, h('div', { className: 'ah-tc-label' }, m.tool_name || 'tools'), h('pre', { className: 'ah-tc-pre ah-tc-result ah-mono' }, prettyText(m.content) || '(empty)'))))
        )
      : null
  )
}

// entries: [{kind:'msg', m} | {kind:'divider'|'handoff', key, item}]
// One short line describing a step: first meaningful line of the agent's text (markdown stripped).
function stepLabel(text) {
  const line = String(text || '')
    .split('\n')
    .map(x => x.replace(/^[#>*\-\s`]+/, '').replace(/[*`]+/g, '').trim())
    .find(Boolean)

  return line ? (line.length > 140 ? `${line.slice(0, 139)}…` : line) : ''
}

// Latest thought in a reasoning stream: its last sentence or line.
function thoughtLabel(text) {
  const lines = String(text || '').split('\n').map(x => x.trim()).filter(Boolean)
  const last = lines.length ? lines[lines.length - 1] : ''
  const parts = last.split(/(?<=[.!?])\s+/).filter(x => x.length > 3)
  const pick = parts.length ? parts[parts.length - 1] : last

  return stepLabel(pick)
}

function callLabel(c) {
  if (!c) {
    return ''
  }

  if (c.name === 'terminal' && c.args && typeof c.args.command === 'string') {
    return `$ ${c.args.command}`
  }

  return c.summary ? `${c.name}: ${c.summary}` : c.name
}

function entryTime(e) {
  if (e.kind === 'msg') {
    return num(e.m.timestamp)
  }

  if (e.kind === 'work') {
    return num(e.item.last_at)
  }

  const it = e.item || {}

  return num(it.at || it.started_at || it.timestamp)
}

function buildBlocks(entries) {
  const callIds = new Set()
  const resultById = new Map()

  for (const e of entries) {
    if (e.kind !== 'msg') {
      continue
    }

    const m = e.m

    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) {
        if (c && c.id) {
          callIds.add(c.id)
        }
      }
    }

    if (m.role === 'tool' && m.tool_call_id) {
      resultById.set(m.tool_call_id, m)
    }
  }

  const blocks = []

  entries.forEach((e, idx) => {
    if (e.kind !== 'msg') {
      blocks.push(e)

      return
    }

    const m = e.m
    const key = `${m.session_id || ''}:${m.id ?? idx}`

    if (m.role === 'system') {
      return
    }

    if (m.role === 'tool') {
      if (m.tool_call_id && callIds.has(m.tool_call_id)) {
        return
      }

      const last = blocks[blocks.length - 1]

      if (last && last.kind === 'orphan') {
        last.items.push(m)
      } else {
        blocks.push({ kind: 'orphan', key: `o:${key}`, items: [m] })
      }

      return
    }

    if (m.role === 'assistant') {
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls.filter(Boolean) : []
      const said = m.content && String(m.content).trim()

      if (calls.length === 0) {
        if (said) {
          blocks.push({ kind: 'assistant', key: `a:${key}`, m })
        }

        return
      }

      // Text next to tool calls is the agent narrating its own work ("Checking…"): it becomes the step label.
      const step = { label: stepLabel(said), calls: [...calls] }
      const last = blocks[blocks.length - 1]

      if (last && last.kind === 'tools') {
        last.calls.push(...calls)
        last.steps.push(step)
      } else {
        blocks.push({ kind: 'tools', key: `t:${key}`, calls: [...calls], steps: [step] })
      }

      return
    }

    blocks.push({ kind: 'user', key: `u:${key}`, m })
  })

  return { blocks, resultById }
}

function MsgTime({ ts, s }) {
  return ts ? h('time', { className: 'ah-msg-time', title: absTime(ts) }, relTime(ts, s.now)) : null
}

const AUTO_ICON = {
  'Background process finished': 'server-process',
  'Background task result': 'organization',
  'Model switch': 'hubot',
  'Scheduled job': 'history',
  'Context compacted': 'fold'
}

// Fallback when the backend is older than the `auto` field: same prefixes as plugin_api.auto_label.
const AUTO_PREFIXES = [
  ['[CONTEXT COMPACTION', 'Context compacted'],
  ['[IMPORTANT: Background process', 'Background process finished'],
  ['[IMPORTANT:', 'System notice'],
  ['[INTERNAL NOTIFICATION', 'System notice'],
  ['[ASYNC DELEGATION', 'Background task result'],
  ['[System', 'System note'],
  ['[SYSTEM', 'System note']
]

function autoOf(m) {
  if (!m || m.role !== 'user' || m.optimistic) {
    return null
  }

  if (m.auto) {
    return m.auto
  }

  const head = String(m.content || '').trimStart().slice(0, 60)
  const hit = AUTO_PREFIXES.find(([p]) => head.startsWith(p))

  return hit ? hit[1] : null
}

// A user-role row the owner did not type (gateway notice, background result, cron prompt...):
// collapsed by default, clearly tagged, never styled like the owner's own bubble.
const COMPACTION_LABEL = 'Context compacted'

function AutoMessage({ m, s }) {
  const [open, setOpen] = useState(false)

  // Context compaction: one quiet line, nothing to expand (the summary is for the model, not the owner).
  if (m.auto === COMPACTION_LABEL) {
    return h(
      'div',
      { className: 'ah-automsg is-compact', role: 'note', title: 'Earlier messages were summarized to free up context' },
      h(Icon, { name: 'fold', size: 14 }),
      h('span', { className: 'ah-automsg-label' }, COMPACTION_LABEL),
      m.timestamp ? h('time', { className: 'ah-automsg-time', title: absTime(m.timestamp) }, relTime(m.timestamp, s.now)) : null
    )
  }

  const id = `ah-auto-${m.session_id || ''}-${m.id}`
  const summary = m.auto_summary || String(m.content || '').split('\n')[0]

  return h(
    'div',
    { className: cx('ah-automsg', open && 'is-open') },
    h(
      'button',
      { type: 'button', className: 'ah-automsg-head ah-state', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': id, title: 'Automatic message, not typed by you', onClick: () => setOpen(!open) },
      h(Icon, { name: open ? 'chevron-down' : 'chevron-right', size: 14 }),
      h(Icon, { name: AUTO_ICON[m.auto] || 'bell', size: 14 }),
      h('span', { className: 'ah-auto-tag' }, 'Auto'),
      h('span', { className: 'ah-automsg-label' }, m.auto),
      h('span', { className: 'ah-automsg-sum' }, summary),
      m.timestamp ? h('time', { className: 'ah-automsg-time', title: absTime(m.timestamp) }, relTime(m.timestamp, s.now)) : null
    ),
    open ? h('div', { id, className: 'ah-automsg-body' }, h('pre', { className: 'ah-tc-pre ah-mono' }, m.content || '(empty)')) : null
  )
}

// mode 'chat': owner on the right, the selected agent on the left.
// mode 'agents': agent-to-agent transcript, everyone on the left with speaker avatars.
function MessageStream({ s, entries, mode, agentId, info, renderEntry }) {
  const { blocks, resultById } = useMemo(() => buildBlocks(entries), [entries])

  return h(
    'ol',
    { className: cx('ah-stream', `is-${mode}`) },
    blocks.map((b, i) => {
      if (b.kind === 'work') {
        return h('li', { key: b.key, className: 'ah-stream-item is-agent is-work' }, renderEntry ? renderEntry(b) : null)
      }

      if (b.kind === 'divider' || b.kind === 'handoff') {
        return h('li', { key: b.key, className: cx('ah-stream-item', b.kind === 'divider' ? 'is-divider' : 'is-handoff') }, renderEntry ? renderEntry(b) : null)
      }

      if (b.kind === 'tools') {
        return h('li', { key: b.key, className: 'ah-stream-item is-tools' }, mode === 'chat' ? h('span', { className: 'ah-av-gap' }) : h('span', { className: 'ah-av-gap' }), h(ToolGroup, { uid: b.key, calls: b.calls, steps: b.steps, resultById }))
      }

      if (b.kind === 'orphan') {
        return h('li', { key: b.key, className: 'ah-stream-item is-tools' }, h('span', { className: 'ah-av-gap' }), h(OrphanResults, { uid: b.key, items: b.items }))
      }

      const m = b.m

      const auto = b.kind === 'user' ? autoOf(m) : null

      if (auto) {
        return h('li', { key: b.key, className: 'ah-stream-item is-auto' }, h('span', { className: 'ah-av-gap' }), h(AutoMessage, { m: { ...m, auto }, s }))
      }

      if (mode === 'chat') {
        if (b.kind === 'user') {
          return h(UserMessage, { key: b.key, s, m, agent: agentId })
        }

        return h(
          'li',
          { key: b.key, className: 'ah-stream-item is-agent' },
          h(Avatar, { id: agentId, name: agentName(s, agentId), size: 32 }),
          h('div', { className: 'ah-bub-col' }, h('div', { className: 'ah-bub role-assistant' }, h(Markdown, { text: m.content || '' })), h(MsgTime, { ts: m.timestamp, s }))
        )
      }

      const speaker = m.speaker || (b.kind === 'user' ? info && info.from_agent : info && info.to_agent) || m.role

      return h(
        'li',
        { key: b.key, className: 'ah-stream-item is-agent' },
        h(Avatar, { id: speaker, name: agentName(s, speaker), size: 32 }),
        h(
          'div',
          { className: cx('ah-bub', `role-${m.role}`) },
          h('div', { className: 'ah-bubble-head' }, h('span', { className: 'ah-bubble-name' }, agentName(s, speaker)), h('time', { className: 'ah-bubble-time', title: absTime(m.timestamp) }, relTime(m.timestamp, s.now))),
          h(Markdown, { text: m.content || '' })
        )
      )
    })
  )
}

const NOT_FOUND_MSG = 'Conversation not found: it may have been deleted or belong to another profile'
const isNotFound = text => /404|not\s*found|unknown profile|không tìm thấy/i.test(String(text || ''))

function ConvBody({ s, entry, current, info }) {
  const messages = entry && entry.data && Array.isArray(entry.data.messages) ? entry.data.messages : []
  const endRef = useRef(null)

  useEffect(() => {
    if (endRef.current && endRef.current.scrollIntoView) {
      endRef.current.scrollIntoView({ block: 'end' })
    }
  }, [messages.length])

  const entries = useMemo(() => messages.map(m => ({ kind: 'msg', m })), [entry && entry.data])

  if (!entry || (entry.status === 'loading' && !entry.data)) {
    return h(Skeleton, { rows: 7, className: 'ah-inset' })
  }

  if (entry.status === 'error' && !entry.data) {
    const missing = isNotFound(entry.error)

    return h(ErrorState, {
      message: missing ? NOT_FOUND_MSG : 'Could not load the conversation',
      detail: missing ? null : entry.error,
      onRetry: missing ? null : () => void fetchDetail(current)
    })
  }

  if (messages.length === 0) {
    return h(EmptyState, { icon: 'comment', title: 'No messages yet', hint: 'Messages appear once the agents start talking.' })
  }

  return h('div', { className: 'ah-convbody' }, h(MessageStream, { s, entries, mode: 'agents', info }), h('span', { ref: endRef, className: 'ah-end', 'aria-hidden': 'true' }))
}

function Transcript({ s, meta, detail, current }) {
  const info = (detail && detail.data && detail.data.meta) || meta
  const loaded = detail && (detail.data || detail.status === 'error')

  return h(
    'div',
    { className: 'ah-transcript' },
    info && loaded
      ? h(
          'header',
          { className: 'ah-transcript-head' },
          h('h2', { className: 'ah-transcript-title' }, info.title || 'Conversations'),
          h('p', { className: 'ah-transcript-sub' }, `From ${agentName(s, info.from_agent)} to ${agentName(s, info.to_agent)}, started ${relTime(info.started_at, s.now)}`),
          h('div', { className: 'ah-conv-chips' }, h(Chip, { tone: 'flat' }, KIND_LABEL[info.kind] || info.kind), h(StatusChip, { status: info.status }))
        )
      : null,
    h(ConvBody, { s, entry: detail, current, info })
  )
}

/* ───────────────────────── chat tab ───────────────────────── */

function HandoffRow({ s, item }) {
  const [open, setOpen] = useState(false)
  const from = item.from_agent
  const to = item.to_agent
  const id = `ah-ho-${item.session_id}`
  const text = `${agentName(s, from)} messaged ${agentName(s, to)}`
  const active = s.ui.handoff && convKey(s.ui.handoff) === convKey(item)

  return h(
    'div',
    { className: cx('ah-handoff', `is-${item.direction === 'in' ? 'in' : 'out'}`), style: { '--ah-ac': agentColor(from) } },
    h(
      'button',
      { type: 'button', className: cx('ah-handoff-pill ah-state', open && 'is-open'), 'aria-expanded': open ? 'true' : 'false', 'aria-controls': id, onClick: () => setOpen(!open) },
      h(Avatar, { id: from, name: agentName(s, from), size: 22 }),
      h(Icon, { name: 'arrow-right', size: 12 }),
      h(Avatar, { id: to, name: agentName(s, to), size: 22 }),
      h('span', { className: 'ah-handoff-text' }, text),
      h('time', { className: 'ah-handoff-time', title: absTime(item.at) }, relTime(item.at, s.now)),
      item.status ? h(StatusChip, { status: item.status }) : null
    ),
    open
      ? h(
          'div',
          { id, className: 'ah-handoff-card' },
          h('p', { className: 'ah-handoff-title' }, item.title || 'Agent-to-agent conversation'),
          item.summary ? h('p', { className: 'ah-handoff-sum' }, item.summary) : null,
          h(
            'div',
            { className: 'ah-handoff-foot' },
            h(Chip, { tone: 'flat' }, KIND_LABEL[item.kind] || item.kind || 'Conversations'),
            num(item.message_count) > 0 ? h('span', { className: 'ah-conv-count' }, `${item.message_count} messages`) : null,
            h('span', { className: 'ah-spacer' }),
            h(
              'button',
              { type: 'button', className: cx('ah-btn ah-btn-tonal ah-btn-sm ah-state', active && 'is-on'), onClick: () => openHandoff(item) },
              h(Icon, { name: 'comment-discussion', size: 16 }),
              h('span', null, 'View all')
            )
          )
        )
      : null
  )
}

function SessionDivider({ s, item }) {
  return h(
    'div',
    { className: 'ah-divider', role: 'separator' },
    h('span', { className: 'ah-divider-line' }),
    h('span', { className: 'ah-divider-label', title: item.source ? `Source: ${item.source}` : undefined }, `Session: ${item.title || 'Untitled'}, ${relTime(item.started_at, s.now)}`),
    h('span', { className: 'ah-divider-line' })
  )
}

function HandoffPanel({ s }) {
  const hf = s.ui.handoff
  const current = { profile: hf.profile, session_id: hf.session_id }
  const entry = S.detail[convKey(current)]
  const info = (entry && entry.data && entry.data.meta) || { title: hf.title, from_agent: hf.from_agent, to_agent: hf.to_agent, kind: hf.kind, status: hf.status, started_at: hf.at }

  return h(
    'aside',
    { className: 'ah-hpanel', 'aria-label': 'Agent-to-agent conversation details' },
    h(
      'header',
      { className: 'ah-hpanel-head' },
      h('button', { type: 'button', className: 'ah-icon-btn ah-state ah-hpanel-back', 'aria-label': 'Back to the chat', title: 'Back to the chat', onClick: () => setUi({ handoff: null }) }, h(Icon, { name: 'arrow-left', size: 18 })),
      h('div', { className: 'ah-hpanel-titles' }, h('h2', { className: 'ah-hpanel-title' }, info.title || 'Conversations'), h('p', { className: 'ah-hpanel-sub' }, `${agentName(s, info.from_agent)} messaged ${agentName(s, info.to_agent)}`)),
      h('button', { type: 'button', className: 'ah-icon-btn ah-state ah-hpanel-close', 'aria-label': 'Close details', title: 'Close details', onClick: () => setUi({ handoff: null }) }, h(Icon, { name: 'close', size: 18 }))
    ),
    h('div', { className: 'ah-hpanel-body' }, h(ConvBody, { s, entry, current, info }))
  )
}

const fmtBytes = n => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`)

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()

    fr.onload = () => resolve(String(fr.result || ''))
    fr.onerror = () => reject(fr.error || new Error('Could not read the file'))
    fr.readAsDataURL(file)
  })
}

async function toAttachment(file) {
  const isImg = /^image\//.test(file.type || '')
  const ext = isImg ? (String(file.type).split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') : ''
  const name = file.name && file.name !== 'image.png' ? file.name : isImg ? `anh-dan-${Date.now()}.${ext || 'png'}` : file.name || `tep-${Date.now()}`

  return { id: `${Date.now()}-${Math.random()}`, name, size: file.size || 0, mime: file.type || '', kind: isImg ? 'image' : 'file', dataUrl: await readDataUrl(file) }
}

function attIcon(att) {
  if (att.kind === 'image') {
    return 'file-media'
  }

  if (/pdf$/i.test(att.mime) || /\.pdf$/i.test(att.name)) {
    return 'file-pdf'
  }

  if (/zip|compressed|tar|gzip/i.test(att.mime)) {
    return 'file-zip'
  }

  return /^text\/|json|xml|javascript|csv/.test(att.mime) ? 'file-code' : 'file'
}

function AttachmentChip({ att, onRemove }) {
  const [loaded, setLoaded] = useState(null)
  const src = att.dataUrl || loaded

  useEffect(() => {
    if (att.kind !== 'image' || att.dataUrl || !att.path || !att.agent || !C) {
      return undefined
    }

    let live = true
    void loadStagedImage(att.agent, att.path).then(url => {
      if (live && url) {
        setLoaded(url)
      }
    })

    return () => {
      live = false
    }
  }, [att.agent, att.path, att.dataUrl])

  return h(
    'span',
    { className: cx('ah-att', att.kind === 'image' && 'is-image'), title: `${att.name} (${fmtBytes(att.size || 0)})` },
    att.kind === 'image' && src ? h('img', { className: 'ah-att-thumb', src, alt: '' }) : h('span', { className: 'ah-att-icon' }, h(Icon, { name: attIcon(att), size: 16 })),
    h('span', { className: 'ah-att-body' }, h('span', { className: 'ah-att-name' }, att.name), att.size ? h('span', { className: 'ah-att-size' }, fmtBytes(att.size)) : null),
    onRemove ? h('button', { type: 'button', className: 'ah-att-x ah-state', 'aria-label': `Drop ${att.name}`, title: 'Remove this file', onClick: onRemove }, h(Icon, { name: 'close', size: 14 })) : null
  )
}

// Attachments above the text: image thumbnails (then file chips), first ATT_VISIBLE shown, the rest behind "+N".
function AttachmentTray({ atts, onRemove }) {
  const [all, setAll] = useState(false)
  const ordered = [...atts.filter(a => a.kind === 'image'), ...atts.filter(a => a.kind !== 'image')]
  const shown = all ? ordered : ordered.slice(0, ATT_VISIBLE)
  const more = ordered.length - shown.length

  return h(
    'div',
    { className: 'ah-att-tray' },
    shown.map(att =>
      att.kind === 'image' && att.dataUrl
        ? h(
            'span',
            { key: att.id, className: 'ah-thumb', title: `${att.name} (${fmtBytes(att.size || 0)})` },
            h('img', { src: att.dataUrl, alt: att.name }),
            h('button', { type: 'button', className: 'ah-thumb-x', 'aria-label': `Drop ${att.name}`, title: 'Remove this image', onClick: () => onRemove(att.id) }, h(Icon, { name: 'close', size: 12 }))
          )
        : h(AttachmentChip, { key: att.id, att, onRemove: () => onRemove(att.id) })
    ),
    more > 0
      ? h('button', { type: 'button', className: 'ah-thumb ah-thumb-more ah-state', title: `Show ${more} more files`, 'aria-label': `Show ${more} more files`, onClick: () => setAll(true) }, `+${more}`)
      : all && ordered.length > ATT_VISIBLE
        ? h('button', { type: 'button', className: 'ah-thumb ah-thumb-more ah-state', title: 'Collapse', 'aria-label': 'Collapse', onClick: () => setAll(false) }, h(Icon, { name: 'chevron-up', size: 16 }))
        : null
  )
}

function useOutside(ref, open, close) {
  useEffect(() => {
    if (!open || typeof document === 'undefined') {
      return undefined
    }

    const onDown = e => {
      if (ref.current && !ref.current.contains(e.target)) {
        close()
      }
    }

    const onKey = e => {
      if (e.key === 'Escape') {
        close()
      }
    }

    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)

    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
}

// Provider order in the model menu: Anthropic, ChatGPT/Codex subscription, Nous, then the rest.
const PROVIDER_ORDER = [/^anthropic$|claude/i, /^openai-codex$|codex|chatgpt/i, /^nous|nous/i]

function providerRank(p) {
  const i = PROVIDER_ORDER.findIndex(re => re.test(p.slug) || re.test(p.name))

  return i < 0 ? PROVIDER_ORDER.length : i
}

function ModelPicker({ s, agent }) {
  const [open, setOpen] = useState(null)
  const [q, setQ] = useState('')
  const [left, setLeft] = useState(0)
  const [expanded, setExpanded] = useState({})
  const ref = useRef(null)
  const cur = currentModel(s, agent)
  const lv = s.live[agent] || {}
  const opts = s.models[agent]
  const busy = !!(lv.turn && lv.turn.active)

  useOutside(ref, !!open, () => setOpen(null))

  const toggle = (which, e) => {
    const next = open === which ? null : which
    const btn = e && e.currentTarget

    // Popovers are positioned against the composer box (above the textarea), at the trigger's x.
    if (btn && typeof btn.getBoundingClientRect === 'function') {
      const box = btn.closest('.ah-composer')
      const bl = btn.getBoundingClientRect().left
      const cl = box ? box.getBoundingClientRect().left : bl

      setLeft(Math.max(0, Math.round(bl - cl)))
    }

    setOpen(next)
    setQ('')
    setExpanded({})

    if (next === 'model' && (!opts || opts.status === 'error')) {
      void loadModelOptions(agent)
    }
  }

  const providers = useMemo(() => {
    const list = opts && opts.data && Array.isArray(opts.data.providers) ? opts.data.providers : []
    const ql = q.trim().toLowerCase()

    return list
      .filter(p => p && p.authenticated !== false && Array.isArray(p.models) && p.models.length > 0)
      .map(p => {
        const unavailable = new Set(Array.isArray(p.unavailable_models) ? p.unavailable_models : [])
        const featured = Array.isArray(p.featured_models) ? p.featured_models : []
        const models = [...new Set([...featured, ...p.models])].filter(m => !unavailable.has(m) && (!ql || m.toLowerCase().includes(ql) || String(p.name || p.slug).toLowerCase().includes(ql)))

        return { slug: p.slug, name: p.name || p.slug, models, current: p.slug === cur.provider || !!p.is_current, caps: p.capabilities || {} }
      })
      .filter(p => p.models.length > 0)
      .sort((x, y) => providerRank(x) - providerRank(y))
  }, [opts && opts.data, q, cur.provider])

  const caps = useMemo(() => {
    const list = opts && opts.data && Array.isArray(opts.data.providers) ? opts.data.providers : []
    const p = list.find(x => x.slug === cur.provider)

    return p && p.capabilities ? p.capabilities[cur.model] : null
  }, [opts && opts.data, cur.provider, cur.model])

  const shownModel = cur.pending ? cur.pending.model : cur.model
  const levels = caps && caps.reasoning === false ? [] : REASONING_LEVELS.filter(l => l.id !== 'none' || !caps || caps.can_disable_reasoning !== false)

  return h(
    'div',
    { className: 'ah-picker', ref },
    h(
      'button',
      {
        type: 'button',
        className: cx('ah-tool-btn ah-model-btn ah-state', open === 'model' && 'is-open', cur.pending && 'is-pending'),
        'aria-haspopup': 'listbox',
        'aria-expanded': open === 'model' ? 'true' : 'false',
        title: `Agent model${cur.live ? ' (in use this session)' : ' (config default)'}: ${cur.provider ? `${cur.provider} / ` : ''}${shownModel || 'unknown'}`,
        onClick: e => toggle('model', e)
      },
      cur.pending ? h(Icon, { name: 'loading', size: 14, spinning: true }) : h(Icon, { name: 'hubot', size: 14 }),
      h('span', { className: 'ah-model-name' }, shownModel || 'Model'),
      h(Icon, { name: 'chevron-down', size: 12 })
    ),
    h(
      'button',
      {
        type: 'button',
        className: cx('ah-tool-btn ah-state', open === 'reason' && 'is-open'),
        'aria-haspopup': 'listbox',
        'aria-expanded': open === 'reason' ? 'true' : 'false',
        title: `Reasoning: ${reasoningLabel(cur.effort)}`,
        disabled: levels.length === 0,
        onClick: e => toggle('reason', e)
      },
      h(Icon, { name: 'lightbulb', size: 14 }),
      h('span', null, reasoningLabel(cur.effort)),
      h(Icon, { name: 'chevron-down', size: 12 })
    ),
    open === 'model'
      ? h(
          'div',
          { className: 'ah-pop ah-pop-model', role: 'dialog', 'aria-label': 'Choose model', style: { left } },
          h(
            'div',
            { className: 'ah-pop-head' },
            h(Icon, { name: 'search', size: 14 }),
            h('input', { className: 'ah-pop-search', value: q, placeholder: 'Search models or providers', autoFocus: true, onChange: e => setQ(e.target.value) }),
            h('button', { type: 'button', className: 'ah-icon-btn ah-icon-btn-sm ah-state', title: 'Reload list', 'aria-label': 'Reload list', onClick: () => void loadModelOptions(agent, { refresh: true }) }, h(Icon, { name: 'sync', size: 14, spinning: !!(opts && opts.status === 'loading') }))
          ),
          busy ? h('p', { className: 'ah-pop-note' }, 'The agent is running: the new model applies from the next turn.') : null,
          h(
            'div',
            { className: 'ah-pop-list', role: 'listbox' },
            !opts || (opts.status === 'loading' && !opts.data)
              ? h(Skeleton, { rows: 4, className: 'ah-pop-skel' })
              : opts.status === 'error' && !opts.data
                ? h('p', { className: 'ah-pop-note is-err' }, opts.error || 'Could not load models')
                : providers.length === 0
                  ? h('p', { className: 'ah-pop-note' }, 'No matching model.')
                  : providers.map(p => {
                      // Only the provider of the active model starts open; a search opens every match.
                      const isOpen = q.trim() ? true : expanded[p.slug] !== undefined ? expanded[p.slug] : p.current

                      return h(
                        'div',
                        { key: p.slug, className: cx('ah-pop-group', isOpen && 'is-open') },
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'ah-pop-group-title ah-state',
                            'aria-expanded': isOpen ? 'true' : 'false',
                            onClick: () => setExpanded({ ...expanded, [p.slug]: !isOpen })
                          },
                          h(Icon, { name: isOpen ? 'chevron-down' : 'chevron-right', size: 12 }),
                          h('span', { className: 'ah-pop-group-name' }, p.name),
                          p.current ? h('span', { className: 'ah-pop-group-cur ah-mono' }, cur.model) : null,
                          h('span', { className: 'ah-pop-group-n' }, p.models.length)
                        ),
                        !isOpen ? null : p.models.slice(0, q ? 60 : 40).map(m => {
                          const on = m === cur.model && p.slug === cur.provider

                          return h(
                            'button',
                            {
                              key: m,
                              type: 'button',
                              role: 'option',
                              'aria-selected': on ? 'true' : 'false',
                              className: cx('ah-pop-item ah-state', on && 'is-on'),
                              onClick: () => {
                                setOpen(null)

                                if (!on) {
                                  void switchModel(agent, p.slug, m)
                                }
                              }
                            },
                            h('span', { className: 'ah-pop-check' }, on ? h(Icon, { name: 'check', size: 14 }) : null),
                            h('span', { className: 'ah-pop-label ah-mono' }, m),
                            p.caps && p.caps[m] && p.caps[m].reasoning ? h('span', { className: 'ah-pop-tag', title: 'Supports reasoning' }, h(Icon, { name: 'lightbulb', size: 12 })) : null
                          )
                        })
                      )
                    })
          ),
          h('p', { className: 'ah-pop-foot' }, 'Applies to this agent’s chat session. If the agent switches model itself, this follows.')
        )
      : null,
    open === 'reason'
      ? h(
          'div',
          { className: 'ah-pop ah-pop-reason', role: 'listbox', 'aria-label': 'Reasoning effort', style: { left } },
          levels.map(l => {
            const on = String(cur.effort || '').toLowerCase() === l.id

            return h(
              'button',
              {
                key: l.id,
                type: 'button',
                role: 'option',
                'aria-selected': on ? 'true' : 'false',
                className: cx('ah-pop-item ah-state', on && 'is-on'),
                onClick: () => {
                  setOpen(null)

                  if (!on) {
                    void switchReasoning(agent, l.id)
                  }
                }
              },
              h('span', { className: 'ah-pop-check' }, on ? h(Icon, { name: 'check', size: 14 }) : null),
              h('span', { className: 'ah-pop-label' }, l.label),
              h('span', { className: 'ah-pop-meta ah-mono' }, l.id)
            )
          })
        )
      : null
  )
}

function Composer({ s, agent, onSent }) {
  const a = list('agents', 'agents').find(x => x.id === agent)
  const name = a ? a.name || a.id : agent
  const st = s.send[agent] || {}
  const lv = s.live[agent] || {}
  const [text, setText] = useState(drafts[agent] || '')
  const [atts, setAtts] = useState(draftAtt[agent] || [])
  const [drag, setDrag] = useState(false)
  const [note, setNote] = useState('')
  const [slash, setSlash] = useState({ items: [], sel: 0, from: 0, open: false })
  const taRef = useRef(null)
  const fileRef = useRef(null)
  const slashSeq = useRef(0)
  const rpc = typeof host.requestProfile === 'function'
  const running = !!st.busy || !!(lv.turn && lv.turn.active)
  const hasPayload = text.trim().length > 0 || atts.length > 0
  const canSend = rpc && hasPayload && (!st.busy || running)

  // A slash command may prefill the draft (type "prefill").
  useEffect(() => {
    if (drafts[agent] !== undefined && drafts[agent] !== text) {
      setText(drafts[agent])
    }
  }, [s.cmdlog[agent]])

  const fit = el => {
    if (el && el.style) {
      el.style.height = 'auto'
      // Grow with the text up to 15 lines, then scroll.
      const cs = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null
      const lh = (cs && parseFloat(cs.lineHeight)) || 24
      const pad = cs ? (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) : 8

      // ...but the composer never takes more than ~70% of the chat column, so a short window keeps the timeline visible.
      const main = el.closest && el.closest('.ah-chat-main')
      const box = el.closest && el.closest('.ah-composer')
      const extra = box ? Math.max(0, box.offsetHeight - el.offsetHeight) : 0
      const room = main && main.clientHeight > 0 ? Math.max(lh * 3 + pad, Math.floor(main.clientHeight * 0.7) - extra) : Infinity
      const cap = Math.min(Math.round(lh * COMPOSER_MAX_LINES + pad), room)

      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, cap)}px`
      el.style.overflowY = el.scrollHeight > cap + 1 ? 'auto' : 'hidden'
    }
  }

  useEffect(() => {
    fit(taRef.current)
  }, [text, atts.length])

  const setAttachments = next => {
    draftAtt[agent] = next
    setAtts(next)
  }

  const addFiles = async files => {
    const arr = Array.from(files || []).filter(Boolean)

    if (arr.length === 0) {
      return
    }

    const room = MAX_ATTACH - atts.length
    const tooBig = arr.filter(f => f.size > MAX_ATTACH_BYTES)
    const ok = arr.filter(f => f.size <= MAX_ATTACH_BYTES).slice(0, Math.max(0, room))

    setNote(tooBig.length ? `Skipped ${tooBig.length} files larger than ${fmtBytes(MAX_ATTACH_BYTES)}.` : arr.length > ok.length ? `At most ${MAX_ATTACH} files per message.` : '')

    try {
      const read = await Promise.all(ok.map(toAttachment))
      const next = [...(draftAtt[agent] || atts), ...read].slice(0, MAX_ATTACH)

      setAttachments(next)
    } catch (err) {
      setNote(errText(err))
    }
  }

  const updateSlash = value => {
    const m = /^\/[^\s]*$/.exec(value)

    if (!m || !rpc) {
      if (slash.open) {
        setSlash({ items: [], sel: 0, from: 0, open: false })
      }

      return
    }

    const seq = (slashSeq.current += 1)
    const runtime = lv.runtime

    rp(agent, 'complete.slash', { text: value, ...(runtime ? { session_id: runtime } : {}) }, false)
      .then(r => {
        if (seq !== slashSeq.current) {
          return
        }

        const items = Array.isArray(r && r.items) ? r.items.slice(0, 50) : []

        setSlash({ items, sel: 0, from: typeof (r && r.replace_from) === 'number' ? r.replace_from : 0, open: items.length > 0 })
      })
      .catch(() => {
        if (seq === slashSeq.current) {
          setSlash({ items: [], sel: 0, from: 0, open: false })
        }
      })
  }

  const change = value => {
    setText(value)
    drafts[agent] = value
    updateSlash(value)
  }

  const pickSlash = item => {
    if (!item) {
      return
    }

    const value = `${text.slice(0, slash.from)}${item.text}${/\s$/.test(item.text) ? '' : ' '}`

    change(value)
    setSlash({ items: [], sel: 0, from: 0, open: false })

    if (taRef.current) {
      taRef.current.focus()
    }
  }

  const submit = () => {
    if (!canSend) {
      return
    }

    const body = text.trim()
    const sending = atts

    setText('')
    drafts[agent] = ''
    setAttachments([])
    setNote('')
    setSlash({ items: [], sel: 0, from: 0, open: false })

    if (taRef.current) {
      taRef.current.style.height = 'auto'
    }

    onSent()

    if (running) {
      // the agent is working: queue it (Steer or remove from the tray above the input)
      enqueueMessage(agent, body, sending)

      return
    }

    if (body.startsWith('/') && sending.length === 0 && !body.includes('\n')) {
      void runSlash(agent, body)
    } else {
      void sendMessage(agent, body, sending)
    }
  }

  const onKeyDown = e => {
    const composing = (e.nativeEvent && e.nativeEvent.isComposing) || e.keyCode === 229

    if (slash.open && slash.items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSlash({ ...slash, sel: (slash.sel + (e.key === 'ArrowDown' ? 1 : slash.items.length - 1)) % slash.items.length })

        return
      }

      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !composing && text.trim() !== slash.items[slash.sel].text.trim())) {
        e.preventDefault()
        pickSlash(slash.items[slash.sel])

        return
      }

      if (e.key === 'Escape') {
        e.preventDefault()
        setSlash({ ...slash, open: false })

        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey && !composing) {
      e.preventDefault()
      submit()
    }
  }

  const onPaste = e => {
    const files = e.clipboardData && e.clipboardData.files

    if (files && files.length > 0) {
      e.preventDefault()
      void addFiles(files)
    }
  }

  const sendLabel = st.phase === 'upload' ? 'Uploading files' : running ? 'Queue message (Enter): send after this turn or Steer it in' : 'Send message (Enter)'

  return h(
    'div',
    { className: 'ah-composer-wrap' },
    h(QueueTray, { key: 'queue', s, agent, running }),
    h(
      'div',
      { key: 'col', className: 'ah-composer-col' },
      slash.open
        ? h(
            'div',
            { className: 'ah-slash', role: 'listbox', 'aria-label': 'Commands' },
            h('div', { className: 'ah-slash-head' }, h(Icon, { name: 'symbol-keyword', size: 14 }), h('span', null, 'Commands'), h('span', { className: 'ah-spacer' }), h('span', { className: 'ah-slash-hint' }, 'Tab to pick, Esc to close')),
            h(
              'div',
              { className: 'ah-slash-list' },
              slash.items.map((it, i) =>
                h(
                  'button',
                  {
                    key: `${it.text}-${i}`,
                    type: 'button',
                    role: 'option',
                    'aria-selected': i === slash.sel ? 'true' : 'false',
                    className: cx('ah-slash-item ah-state', i === slash.sel && 'is-on'),
                    onMouseDown: e => e.preventDefault(),
                    onClick: () => pickSlash(it)
                  },
                  h('span', { className: 'ah-slash-cmd ah-mono' }, it.display || it.text),
                  it.meta ? h('span', { className: 'ah-slash-meta' }, it.meta) : null
                )
              )
            )
          )
        : null,
      h(
        'div',
        {
          className: cx('ah-composer', !rpc && 'is-disabled', drag && 'is-drag', running && 'is-running'),
          onDragOver: e => {
            if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
              e.preventDefault()
              setDrag(true)
            }
          },
          onDragLeave: () => setDrag(false),
          onDrop: e => {
            if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
              e.preventDefault()
              setDrag(false)
              void addFiles(e.dataTransfer.files)
            }
          }
        },
        // Stable keys: h() drops nulls, so without them the tray appearing would shift the textarea and remount it (losing its height).
        atts.length ? h(AttachmentTray, { key: 'tray', atts, onRemove: id => setAttachments(atts.filter(x => x.id !== id)) }) : null,
        h('label', { key: 'label', className: 'ah-sr', htmlFor: 'ah-composer-input' }, `Message ${name}`),
        h('textarea', {
          key: 'input',
          id: 'ah-composer-input',
          ref: taRef,
          className: 'ah-composer-input',
          rows: 1,
          value: text,
          disabled: !rpc,
          placeholder: `Message ${name}, type / for commands, paste or drop images and files…`,
          onChange: e => {
            change(e.target.value)
            fit(e.target)
          },
          onKeyDown,
          onPaste
        }),
        h(
          'div',
          { key: 'bar', className: 'ah-composer-bar' },
          h('input', { ref: fileRef, type: 'file', multiple: true, className: 'ah-sr', tabIndex: -1, 'aria-hidden': 'true', onChange: e => { void addFiles(e.target.files); e.target.value = '' } }),
          h('button', { type: 'button', className: 'ah-tool-btn ah-tool-icon ah-state', disabled: !rpc || atts.length >= MAX_ATTACH, title: 'Attach images or files', 'aria-label': 'Attach images or files', onClick: () => fileRef.current && fileRef.current.click() }, h(Icon, { name: 'attach', size: 16 })),
          h(
            'button',
            {
              type: 'button',
              className: 'ah-tool-btn ah-tool-icon ah-state',
              disabled: !rpc,
              title: 'Commands (type /)',
              'aria-label': 'Open the command list',
              onClick: () => {
                const v = text.startsWith('/') ? text : `/${text}`

                change(v)

                if (taRef.current) {
                  taRef.current.focus()
                }
              }
            },
            h(Icon, { name: 'symbol-keyword', size: 16 })
          ),
          h('span', { className: 'ah-bar-sep', 'aria-hidden': 'true' }),
          rpc ? h(ModelPicker, { s, agent }) : null,
          h('span', { className: 'ah-spacer' }),
          running
            ? h('button', { type: 'button', className: 'ah-stop ah-state', 'aria-label': 'Stop the agent', title: 'Stop the agent', onClick: () => void stopTurn(agent) }, h(Icon, { name: 'debug-stop', size: 16 }))
            : null,
          h(
            'button',
            { type: 'button', className: cx('ah-send ah-state', st.phase === 'upload' && 'is-busy'), 'aria-label': sendLabel, title: sendLabel, disabled: !canSend, onClick: submit },
            st.phase === 'upload' ? h(Icon, { name: 'loading', size: 18, spinning: true }) : h(Icon, { name: 'send', size: 18 })
          )
        )
      ),
      drag ? h('p', { className: 'ah-composer-note' }, 'Drop to attach.') : null,
      note ? h('p', { className: 'ah-composer-note' }, note) : null,
      lv.modelError ? h('div', { className: 'ah-composer-error', role: 'alert' }, h(Icon, { name: 'error', size: 16 }), h('span', { className: 'ah-composer-error-text' }, `Could not change model or reasoning: ${lv.modelError}`)) : null,
      !rpc ? h('p', { className: 'ah-composer-note' }, 'This Hermes Desktop version cannot send messages from Agents Hub. Update the app or use Open in chat.') : null,
      st.error
        ? h(
            'div',
            { className: 'ah-composer-error', role: 'alert' },
            h(Icon, { name: 'error', size: 16 }),
            h('span', { className: 'ah-composer-error-text' }, st.error),
            st.text || (st.attachments && st.attachments.length) ? h('button', { type: 'button', className: 'ah-btn ah-btn-text ah-btn-sm ah-state', onClick: () => void sendMessage(agent, st.text, st.attachments || []) }, 'Retry') : null
          )
        : null,
      h(UsageBar, { key: 'usage', s, agent })
    )
  )
}

/* live turn: what the agent is doing right now */

const PHASES = {
  waiting: { label: 'Waiting for the agent to pick it up', icon: 'watch' },
  thinking: { label: 'Thinking', icon: 'sparkle' },
  reasoning: { label: 'Reasoning', icon: 'lightbulb-sparkle' },
  writing: { label: 'Writing the reply', icon: 'edit' },
  'tool-gen': { label: 'Preparing a command', icon: 'code' },
  tool: { label: 'Executing', icon: 'terminal' },
  done: { label: 'Done', icon: 'pass' }
}

const fmtDur = sec => {
  const s = Math.max(0, Math.round(sec))

  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}s`
}

function useTicker(active) {
  const [, setT] = useState(0)

  useEffect(() => {
    if (!active) {
      return undefined
    }

    const id = setInterval(() => setT(x => x + 1), 1000)

    return () => clearInterval(id)
  }, [active])
}

function LiveTool({ tool }) {
  const run = tool.state === 'run'
  const secs = run ? (Date.now() - tool.startMs) / 1000 : tool.duration

  return h(
    'li',
    { className: cx('ah-lt', `is-${tool.state}`) },
    h('span', { className: 'ah-lt-state' }, run ? h(Icon, { name: 'loading', size: 14, spinning: true }) : tool.state === 'err' ? h(Icon, { name: 'error', size: 14 }) : h(Icon, { name: 'check', size: 14 })),
    h('span', { className: 'ah-lt-icon' }, h(Icon, { name: toolIcon(tool.name), size: 14 })),
    h('span', { className: 'ah-lt-name' }, tool.name),
    h('span', { className: 'ah-lt-ctx ah-mono', title: tool.summary || tool.context }, tool.message || tool.summary || tool.context),
    typeof tool.percent === 'number' ? h('span', { className: 'ah-lt-pct' }, `${tool.percent}%`) : null,
    typeof secs === 'number' && Number.isFinite(secs) ? h('span', { className: 'ah-lt-dur' }, fmtDur(secs)) : null,
    run ? h('span', { className: 'ah-lt-bar', 'aria-hidden': 'true' }) : null
  )
}

// Live steps: earlier steps fold to one line each; the current one shows its thought and its tools.
function LiveSteps({ turn, showReason, setShowReason, allTools, setAllTools, reasonRef }) {
  const [openStep, setOpenStep] = useState({})
  const byId = new Map(turn.tools.map(t => [t.id, t]))
  const steps = Array.isArray(turn.steps) && turn.steps.length ? turn.steps : turn.tools.length || turn.reasoning || turn.text ? [{ label: thoughtLabel(turn.reasoning), text: turn.text, reasoning: turn.reasoning, tools: turn.tools.map(t => t.id) }] : []

  if (steps.length === 0) {
    return null
  }

  const cur = steps[steps.length - 1]
  const prev = steps.slice(0, -1)
  const shownPrev = allTools ? prev : prev.slice(-3)
  const hiddenPrev = prev.length - shownPrev.length
  const curTools = cur.tools.map(id => byId.get(id)).filter(Boolean)
  const answer = cur.tools.length === 0 && cur.text ? cur.text : ''
  const working = turn.active && !answer
  const n = steps.length

  return h(
    'div',
    { className: 'ah-live-steps' },
    hiddenPrev > 0 ? h('button', { type: 'button', className: 'ah-btn ah-btn-text ah-btn-sm ah-state', onClick: () => setAllTools(true) }, `Show ${hiddenPrev} earlier steps`) : null,
    prev.length
      ? h(
          'ol',
          { className: 'ah-steps is-done' },
          shownPrev.map((st, k) => {
            const idx = prev.length - shownPrev.length + k
            const open = !!openStep[idx]
            const ts = st.tools.map(id => byId.get(id)).filter(Boolean)

            return h(
              'li',
              { key: idx, className: 'ah-step' },
              h(
                'button',
                { type: 'button', className: 'ah-step-head ah-state', 'aria-expanded': open ? 'true' : 'false', onClick: () => setOpenStep({ ...openStep, [idx]: !open }) },
                h(Icon, { name: ts.some(t => t.state === 'err') ? 'error' : 'check', size: 12 }),
                h('span', { className: 'ah-step-n' }, `Step ${idx + 1}`),
                h('span', { className: 'ah-step-label' }, st.label || (ts[0] ? ts[0].name : 'Reasoning')),
                h('span', { className: 'ah-step-tools' }, ts.length ? `${ts.length} tools` : '')
              ),
              open && ts.length ? h('ol', { className: 'ah-live-tools' }, ts.map(t => h(LiveTool, { key: t.id, tool: t }))) : null
            )
          })
        )
      : null,
    answer && n === 1
      ? null
      : h(
          'div',
          { className: cx('ah-step-cur', working && 'is-active') },
          h(
            'div',
            { className: 'ah-step-cur-head' },
            h('span', { className: 'ah-step-n' }, `Step ${answer ? n - 1 || 1 : n}`),
            h('span', { className: cx('ah-step-label', working && 'is-shimmer') }, working ? `Working: ${cur.label || (curTools.length ? curTools[curTools.length - 1].name : 'reasoning')}` : (answer ? (prev[prev.length - 1] || {}).label : cur.label) || 'Xong'),
            cur.reasoning
              ? h(
                  'button',
                  { type: 'button', className: 'ah-live-reason-toggle ah-state', 'aria-expanded': showReason ? 'true' : 'false', onClick: () => setShowReason(!showReason) },
                  h(Icon, { name: showReason ? 'chevron-down' : 'chevron-right', size: 12 }),
                  h('span', null, 'Reasoning')
                )
              : null
          ),
          showReason && cur.reasoning ? h('pre', { className: 'ah-live-reason-body', ref: reasonRef }, cur.reasoning.slice(-2400)) : null,
          curTools.length ? h('ol', { className: 'ah-live-tools' }, curTools.map(t => h(LiveTool, { key: t.id, tool: t }))) : null
        ),
    answer ? h('div', { className: cx('ah-live-text', turn.active && turn.phase === 'writing' && 'is-typing') }, h(Markdown, { text: answer })) : null
  )
}

function LiveTurn({ s, agent, turn }) {
  const [showReason, setShowReason] = useState(false)
  const [allTools, setAllTools] = useState(false)
  const reasonRef = useRef(null)

  useTicker(!!turn.active)

  useEffect(() => {
    const el = reasonRef.current

    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [turn.reasoning && turn.reasoning.length])

  const ph = turn.active ? PHASES[turn.phase] || PHASES.thinking : turn.error ? { label: 'The turn failed', icon: 'error' } : PHASES.done
  const label = turn.active && turn.phase === 'tool' ? (() => {
    const running = turn.tools.filter(t => t.state === 'run')

    return running.length ? `Running ${running.map(t => t.name).slice(0, 2).join(', ')}${running.length > 2 ? '…' : ''}` : ph.label
  })() : turn.active && turn.phase === 'tool-gen' && turn.gen ? `Preparing a command ${turn.gen}` : ph.label
  const secs = ((turn.active ? Date.now() : turn.endedMs || Date.now()) - turn.startedMs) / 1000
  const usage = turn.usage || {}
  const tokens = num(usage.output_tokens) || num(usage.completion_tokens)
  const tools = allTools ? turn.tools : turn.tools.slice(-8)
  const hidden = turn.tools.length - tools.length

  return h(
    'li',
    { className: cx('ah-stream-item is-agent is-live', turn.active && 'is-active') },
    h('span', { className: cx('ah-live-av', turn.active && 'is-on') }, h(Avatar, { id: agent, name: agentName(s, agent), size: 32, mood: moodOf(s, agent) })),
    h(
      'div',
      { className: cx('ah-live-card', turn.error && 'is-err'), role: 'status', 'aria-live': 'polite' },
      h(
        'div',
        { className: 'ah-live-head' },
        h('span', { className: cx('ah-live-orb', `is-${turn.active ? turn.phase : turn.error ? 'err' : 'done'}`) }, h(Icon, { name: ph.icon, size: 14 })),
        h('span', { className: cx('ah-live-label', turn.active && 'is-shimmer') }, label),
        turn.active ? h('span', { className: 'ah-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')) : null,
        h('span', { className: 'ah-spacer' }),
        tokens ? h('span', { className: 'ah-live-meta', title: 'Output tokens this turn' }, `${compact(tokens)} token`) : null,
        h('span', { className: 'ah-live-meta ah-mono' }, fmtDur(secs))
      ),
      turn.status ? h('p', { className: 'ah-live-status' }, h(Icon, { name: turn.statusKind === 'compacting' ? 'fold' : 'info', size: 12 }), h('span', null, turn.status)) : null,
      turn.active && turn.spin && turn.phase === 'thinking' ? h('p', { className: 'ah-live-spin ah-mono' }, turn.spin) : null,
      h(LiveSteps, { turn, showReason, setShowReason, allTools, setAllTools, reasonRef }),
      (turn.steers || []).map((st, i) => h('p', { key: `steer${i}`, className: 'ah-live-steer' }, h(Icon, { name: 'compass', size: 12 }), h('b', null, 'Steered'), h('span', null, st.text))),
      turn.error ? h('p', { className: 'ah-live-error' }, turn.error) : null
    )
  )
}

// What the agent is doing outside this chat (delegated tasks, asks from other agents, scheduled runs).
// One piece of work the agent did in another session, placed in the chat by its last activity time.
function WorkItem({ s, agent, it }) {
  const [open, setOpen] = useState({})

  return h(
    'div',
    { className: 'ah-work-row' },
    h('span', { className: cx('ah-live-av', it.active && 'is-on') }, h(Avatar, { id: agent, name: agentName(s, agent), size: 32, mood: it.active ? 'working' : 'happy' })),
    h(
      'div',
      { className: 'ah-work-col' },
      (() => {
        const isOpen = open[it.session_id] !== undefined ? open[it.session_id] : it.active
        const steps = isOpen ? it.steps : []
        const from = it.from_agent && it.from_agent !== agent ? agentName(s, it.from_agent) : null

        return h(
          'section',
          { key: it.session_id, className: cx('ah-work', it.active && 'is-active') },
          h(
            'button',
            { type: 'button', className: 'ah-work-head ah-state', 'aria-expanded': isOpen ? 'true' : 'false', onClick: () => setOpen({ ...open, [it.session_id]: !isOpen }) },
            h('span', { className: cx('ah-live-orb', it.active ? 'is-tool' : 'is-done') }, h(Icon, { name: it.active ? 'loading' : 'history', size: 14, spinning: it.active })),
            h(
              'span',
              { className: 'ah-work-titles' },
              h('span', { className: cx('ah-work-label', it.active && 'is-shimmer') }, it.active ? 'Working in another session' : 'Worked in another session', from ? ` · ${from} giao` : it.source && it.source !== 'tool' ? ` · ${it.source}` : ''),
              h('span', { className: 'ah-work-title', title: it.title }, it.title)
            ),
            h('time', { className: 'ah-side-time', title: absTime(it.last_at) }, relTime(it.last_at, s.now)),
            h(Icon, { name: isOpen ? 'chevron-up' : 'chevron-down', size: 14 })
          ),
          it.activity && it.active ? h('p', { className: 'ah-live-status' }, h(Icon, { name: 'pulse', size: 12 }), h('span', null, it.activity)) : null,
          steps.length
            ? h(
                'ol',
                { className: 'ah-live-tools ah-work-steps' },
                steps.map((st2, i) =>
                  st2.kind === 'tool'
                    ? h(
                        'li',
                        { key: i, className: cx('ah-lt', it.active && i === steps.length - 1 ? 'is-run' : 'is-ok') },
                        h('span', { className: 'ah-lt-state' }, it.active && i === steps.length - 1 ? h(Icon, { name: 'loading', size: 14, spinning: true }) : h(Icon, { name: 'check', size: 14 })),
                        h('span', { className: 'ah-lt-icon' }, h(Icon, { name: toolIcon(st2.name), size: 14 })),
                        h('span', { className: 'ah-lt-name' }, st2.name),
                        h('span', { className: 'ah-lt-ctx ah-mono', title: st2.text }, st2.text),
                        h('span', { className: 'ah-lt-dur' }, relTime(st2.at, s.now))
                      )
                    : h(
                        'li',
                        { key: i, className: cx('ah-work-say', st2.kind === 'ask' && 'is-ask') },
                        h(Icon, { name: st2.kind === 'ask' ? 'mail' : 'comment', size: 12 }),
                        h('span', null, st2.text)
                      )
                )
              )
            : null
        )
      })()
    )
  )
}

const RB_METHOD = {
  replay: 'Rebuild the earlier content',
  reverse: 'Undo the edits',
  delete: 'Delete (created after this message)',
  unchanged: 'Already in that state, nothing to change',
  unknown: 'Could not restore'
}

// Inline editor for an earlier own message: edit text, choose files to restore, cut the session and resend.
function EditMessage({ s, agent, m, onClose }) {
  const [text, setText] = useState(String(m.content || ''))
  const [plan, setPlan] = useState({ status: 'loading', files: [], error: null })
  const [pick, setPick] = useState({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const taRef = useRef(null)
  const turnBusy = !!((s.live[agent] && s.live[agent].turn && s.live[agent].turn.active) || (s.send[agent] && s.send[agent].busy))

  useEffect(() => {
    let off = false

    rollbackFiles(agent, num(m.timestamp))
      .then(d => {
        if (off) {
          return
        }

        const files = Array.isArray(d.files) ? d.files : []
        const sel = {}

        for (const f of files) {
          sel[f.path] = f.method !== 'unknown' && f.method !== 'unchanged'
        }

        setPick(sel)
        setPlan({ status: 'ready', files, error: null })
      })
      .catch(e => !off && setPlan({ status: 'error', files: [], error: errText(e) }))

    const ta = taRef.current

    if (ta) {
      ta.focus()
      ta.style.height = 'auto'
      ta.style.height = `${Math.min(ta.scrollHeight, 368)}px`
    }

    return () => {
      off = true
    }
  }, [agent, m.id])

  const chosen = plan.files.filter(f => pick[f.path]).map(f => f.path)

  const run = async resend => {
    if (busy || turnBusy) {
      return
    }

    setBusy(true)
    setErr(null)

    try {
      await rewindTo(agent, m, resend ? text.trim() : null, chosen)
      onClose(resend ? 'sent' : 'restored')
    } catch (e) {
      setErr(errText(e))
      setBusy(false)
    }
  }

  return h(
    'div',
    { className: 'ah-edit', role: 'group', 'aria-label': 'Edit the message and rerun from here' },
    h('textarea', {
      ref: taRef,
      className: 'ah-edit-input',
      value: text,
      rows: 2,
      'aria-label': 'Message text',
      onChange: e => {
        setText(e.target.value)
        const ta = e.target
        ta.style.height = 'auto'
        ta.style.height = `${Math.min(ta.scrollHeight, 368)}px`
      },
      onKeyDown: e => {
        if (e.key === 'Escape') {
          onClose(null)
        } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault()
          void run(true)
        }
      }
    }),
    h('p', { className: 'ah-edit-warn' }, h(Icon, { name: 'warning', size: 12 }), h('span', null, 'This message and everything after it are removed from the session; the agent reruns from the new text.')),
    h(
      'div',
      { className: 'ah-edit-files' },
      h('span', { className: 'ah-edit-files-head' }, h(Icon, { name: 'history', size: 12 }), 'Restore files to when this message was sent'),
      plan.status === 'loading'
        ? h('span', { className: 'ah-side-empty' }, 'Checking files edited after this message…')
        : plan.status === 'error'
          ? h('span', { className: 'ah-side-empty' }, `Could not check files (${plan.error}).`)
          : plan.files.length === 0
            ? h('span', { className: 'ah-side-empty' }, 'The agent edited no files after this message.')
            : h(
                'ul',
                { className: 'ah-edit-flist' },
                plan.files.map(f => {
                  const can = f.method !== 'unknown' && f.method !== 'unchanged'

                  return h(
                    'li',
                    { key: f.path },
                    h(
                      'label',
                      { className: cx('ah-edit-file', !can && 'is-off'), title: f.reason ? `${f.path}\n${f.reason}` : f.path },
                      h('input', { type: 'checkbox', checked: !!pick[f.path], disabled: !can || busy, onChange: e => setPick({ ...pick, [f.path]: e.target.checked }) }),
                      h('span', { className: 'ah-side-file-name' }, f.name),
                      h('span', { className: cx('ah-edit-method', !can && f.method === 'unknown' && 'is-warn') }, RB_METHOD[f.method] || f.method)
                    )
                  )
                })
              )
    ),
    err ? h('p', { className: 'ah-live-error' }, err) : null,
    h(
      'div',
      { className: 'ah-edit-actions' },
      turnBusy ? h('span', { className: 'ah-row-sub' }, 'Wait for the agent to finish its turn.') : null,
      h('span', { className: 'ah-spacer' }),
      h('button', { type: 'button', className: 'ah-btn ah-btn-text ah-btn-sm ah-state', disabled: busy, onClick: () => onClose(null) }, 'Cancel'),
      chosen.length
        ? h('button', { type: 'button', className: 'ah-btn ah-btn-outlined ah-btn-sm ah-state', disabled: busy || turnBusy, title: 'Restore files only, keep the chat', onClick: () => void run(false) }, `Restore only ${chosen.length} files`)
        : null,
      h(
        'button',
        { type: 'button', className: 'ah-btn ah-btn-tonal ah-btn-sm ah-state', disabled: busy || turnBusy || !text.trim(), onClick: () => void run(true) },
        busy ? h(Icon, { name: 'loading', size: 14, spinning: true }) : h(Icon, { name: 'discard', size: 14 }),
        chosen.length ? `Restore ${chosen.length} files & resend` : 'Resend from here'
      )
    )
  )
}

function UserMessage({ s, m, agent }) {
  const [editing, setEditing] = useState(false)
  const [note, setNote] = useState(null)
  const canEdit = !m.optimistic && Number.isInteger(Number(m.id)) && !!agent && !!C

  return h(
    'li',
    { className: cx('ah-stream-item is-user', m.optimistic && 'is-pending', editing && 'is-editing') },
    editing
      ? h(EditMessage, {
          s,
          agent,
          m,
          onClose: r => {
            setEditing(false)
            setNote(r === 'restored' ? 'Files restored.' : null)
          }
        })
      : h(
          'div',
          { className: 'ah-bub role-user' },
          Array.isArray(m.attachments) && m.attachments.length ? h('div', { className: 'ah-att-row is-sent' }, m.attachments.map((att, i) => h(AttachmentChip, { key: i, att }))) : null,
          m.content ? h(Markdown, { text: m.content }) : null
        ),
    editing
      ? null
      : h(
          'div',
          { className: 'ah-user-foot' },
          note ? h('span', { className: 'ah-row-sub' }, note) : null,
          canEdit
            ? h(
                'button',
                { type: 'button', className: 'ah-icon-btn ah-icon-btn-sm ah-user-edit ah-state', title: 'Edit & rerun from here (restore files)', 'aria-label': 'Edit the message and rerun from here', onClick: () => setEditing(true) },
                h(Icon, { name: 'edit', size: 14 })
              )
            : null,
          h(MsgTime, { ts: m.timestamp, s })
        )
  )
}

function CmdLog({ entries }) {
  if (!entries || entries.length === 0) {
    return null
  }

  return h(
    'ol',
    { className: 'ah-cmdlog' },
    entries.slice(-6).map(e =>
      h(
        'li',
        { key: e.id, className: cx('ah-cmd', `is-${e.state}`) },
        h('span', { className: 'ah-cmd-state' }, e.state === 'run' ? h(Icon, { name: 'loading', size: 14, spinning: true }) : e.state === 'err' ? h(Icon, { name: 'error', size: 14 }) : h(Icon, { name: 'symbol-keyword', size: 14 })),
        h('div', { className: 'ah-cmd-body' }, h('code', { className: 'ah-cmd-text ah-mono' }, e.text), e.output ? h('pre', { className: 'ah-cmd-out ah-mono' }, String(e.output).slice(0, 4000)) : null)
      )
    )
  )
}

function ChatView({ s }) {
  const agent = s.ui.agent
  const a = list('agents', 'agents').find(x => x.id === agent)
  const name = a ? a.name || a.id : agent
  const tl = s.timeline[agent]
  const send = s.send[agent] || {}
  const lv = s.live[agent] || {}
  const turn = lv.turn || null
  const turnLive = !!(turn && turn.active)
  // Rows of the turn stay hidden while its card is up, including the short save window after message.complete.
  const turnHides = !!(turn && (turn.active || turn.saving))
  const chatMeta = s.chat[agent]
  const scrollRef = useRef(null)
  const stick = useRef(true)
  const lastSig = useRef('')
  const prevH = useRef(0)
  const prevTop = useRef(0)
  const moreFlag = useRef(false)
  const [pill, setPill] = useState(false)

  useEffect(() => {
    void fetchTimeline(agent)
    void fetchChatMeta(agent)
    void fetchSessions(agent)
    void fetchTools(agent)
    void fetchWorkspace(agent)
    void fetchActivity(agent)
    void fetchGoals(agent)
    ensureRuntime(agent)
      .then(rt => (rt ? pollEvents(agent) : null))
      .catch(() => {})
  }, [agent])

  // Live event loop: fast while a turn runs, slow otherwise (catches model switches and turns
  // started elsewhere). Stops when the view unmounts or the page is hidden.
  useEffect(() => {
    let stopped = false
    let timer = null

    const tick = async () => {
      if (stopped) {
        return
      }

      const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden'
      const cur = S && S.live[agent]

      if (visible) {
        if (cur && cur.runtime) {
          await pollEvents(agent)
        } else if (S && S.send[agent] && S.send[agent].busy) {
          await ensureRuntime(agent).catch(() => null)
        }
      }

      const now = S && S.live[agent]
      const fast = (now && now.turn && now.turn.active) || (S && S.send[agent] && S.send[agent].busy)

      if (!stopped) {
        timer = setTimeout(tick, fast ? LIVE_FAST_MS : LIVE_SLOW_MS)
      }
    }

    timer = setTimeout(tick, LIVE_FAST_MS)

    return () => {
      stopped = true

      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [agent])

  // Work the agent does in other sessions (delegations, cron runs): refresh every few seconds.
  useEffect(() => {
    if (!C) {
      return undefined
    }

    const stop = C.setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
        void fetchActivity(agent)
        void fetchGoals(agent)
        void syncApprovals(agent)
      }
    }, ACTIVITY_POLL_MS)

    return () => {
      if (typeof stop === 'function') {
        stop()
      }
    }
  }, [agent])

  // Timeline fallback poll while our own send is in flight.
  useEffect(() => {
    if (!send.busy || !C) {
      return undefined
    }

    const stop = C.setInterval(() => void pollTick(agent), 2500)

    return () => {
      if (typeof stop === 'function') {
        stop()
      }
    }
  }, [agent, !!send.busy])

  const turnStart = turn ? turn.startedMs / 1000 : num(send.sentAt)
  const activityItems = s.activity[agent] && s.activity[agent].data ? s.activity[agent].data.items : null

  const entries = useMemo(() => {
    const items = tl ? [...tl.older, ...tl.latest] : []
    bindPendingAttachments(agent, items)
    const seen = new Set()
    const out = []
    const hideFrom = turnHides ? turnStart - 1 : null

    for (const it of items) {
      const key = itemKey(it)

      if (seen.has(key)) {
        continue
      }

      seen.add(key)

      if (it.type === 'session') {
        out.push({ kind: 'divider', key, item: it })
      } else if (it.type === 'handoff') {
        out.push({ kind: 'handoff', key, item: it })
      } else if (it.type === 'message') {
        // While a turn streams, its persisted rows are shown by the live card instead.
        if (hideFrom !== null && it.role !== 'user' && Number(it.timestamp) >= hideFrom) {
          continue
        }

        out.push({ kind: 'msg', m: withSentAttachments(agent, it) })
      }
    }

    // Work in other sessions sits where it happened in time, not pinned to the bottom.
    const works = (activityItems || []).slice().sort((x, y) => num(x.last_at) - num(y.last_at))

    for (const it of works) {
      const at = num(it.last_at)
      const pos = out.findIndex(e => entryTime(e) > at)
      const entry = { kind: 'work', key: `w:${it.session_id}`, item: it }

      if (pos < 0) {
        out.push(entry)
      } else {
        out.splice(pos, 0, entry)
      }
    }

    for (const m of send.optimistic || []) {
      const saved = items.find(it => isSavedRowOf(it, m.content, send.sentAt))

      if (!saved) {
        out.push({ kind: 'msg', m: { ...m, optimistic: true } })
      }
    }

    return out
  }, [tl && tl.latest, tl && tl.older, send.optimistic, send.sentAt, turnHides, turnStart, activityItems])

  const cmds = s.cmdlog[agent] || []
  const liveSig = turn ? `${turn.phase}:${turn.text.length}:${turn.tools.length}:${turn.reasoning.length > 0 ? 1 : 0}:${turn.active ? 1 : 0}` : ''
  const workSig = ((s.activity[agent] && s.activity[agent].data && s.activity[agent].data.items) || []).map(i => `${i.session_id}:${i.steps.length}:${i.last_at}`).join('|')
  const sig = `${workSig}:${entries.length}:${entries.length ? entryKey(entries[entries.length - 1]) : ''}:${send.busy ? 1 : 0}:${liveSig}:${cmds.length}:${cmds.length ? cmds[cmds.length - 1].state : ''}`

  useEffect(() => {
    const el = scrollRef.current

    if (!el) {
      return
    }

    if (moreFlag.current) {
      el.scrollTop = prevTop.current + (el.scrollHeight - prevH.current)
      moreFlag.current = false
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight
    } else if (lastSig.current && lastSig.current !== sig && !liveSig) {
      setPill(true)
    }

    lastSig.current = sig
    prevH.current = el.scrollHeight
    prevTop.current = el.scrollTop
  }, [sig])

  useEffect(() => {
    if (!(tl && tl.loadingMore)) {
      moreFlag.current = false
    }
  }, [tl && tl.loadingMore])

  // Not enough history to scroll yet: keep pulling older pages until there is (or none are left).
  useEffect(() => {
    const el = scrollRef.current

    if (el && tl && tl.status === 'ready' && tl.has_more && !tl.loadingMore && !tl.moreError && el.scrollHeight <= el.clientHeight + LOAD_MORE_PX) {
      loadMore()
    }
  }, [tl && tl.status, tl && tl.older && tl.older.length, tl && tl.loadingMore])

  const onScroll = e => {
    const el = e.currentTarget

    prevTop.current = el.scrollTop
    prevH.current = el.scrollHeight
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80

    // Scrolling near the top pulls older messages in (no "Load more" button).
    if (el.scrollTop < LOAD_MORE_PX && tl && tl.has_more && !tl.loadingMore && !tl.moreError) {
      loadMore()
    }

    if (stick.current && pill) {
      setPill(false)
    }
  }

  const jumpBottom = () => {
    const el = scrollRef.current

    stick.current = true
    setPill(false)

    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }

  const loadMore = () => {
    const el = scrollRef.current

    if (el) {
      prevTop.current = el.scrollTop
      prevH.current = el.scrollHeight
      moreFlag.current = true
    }

    void fetchTimeline(agent, { more: true })
  }

  const chatId = chatMeta && chatMeta.data && chatMeta.data.session_id
  const canOpen = !!chatId && typeof host.openSession === 'function'
  const showTurn = turn && (turn.active || turn.saving || turn.stale)

  let body

  if (!tl || (tl.status === 'loading' && entries.length === 0)) {
    body = h(Skeleton, { rows: 8, className: 'ah-chat-skel' })
  } else if (tl.status === 'error' && entries.length === 0) {
    body = h(ErrorState, { message: 'Could not load the chat', detail: tl.error, onRetry: () => void fetchTimeline(agent), compactMode: true })
  } else if (entries.length === 0 && !showTurn && cmds.length === 0 && !(s.activity[agent] && s.activity[agent].data && (s.activity[agent].data.items || []).length)) {
    body = h(EmptyState, { icon: 'comment', title: `No chat yet with ${name}`, hint: 'Type a message below to start. Type / for commands; paste images or drop files to attach.' })
  } else {
    body = [
      tl.has_more && (tl.loadingMore || tl.moreError)
        ? h(
            'div',
            { key: 'more', className: 'ah-more', role: 'status' },
            tl.loadingMore ? [h(Icon, { key: 'i', name: 'loading', size: 14, spinning: true }), h('span', { key: 't', className: 'ah-row-sub' }, 'Loading older messages…')] : null,
            tl.moreError ? [h('span', { key: 'e', className: 'ah-row-sub' }, `Could not load older messages: ${tl.moreError}. `), h('button', { key: 'r', type: 'button', className: 'ah-link ah-state', onClick: () => { fetchTimelineRetry(agent); loadMore() } }, 'Retry')] : null
          )
        : null,
      h(MessageStream, {
        key: 'stream',
        s,
        entries,
        mode: 'chat',
        agentId: agent,
        renderEntry: b => (b.kind === 'divider' ? h(SessionDivider, { s, item: b.item }) : b.kind === 'work' ? h(WorkItem, { s, agent, it: b.item }) : h(HandoffRow, { s, item: b.item }))
      }),
      h(CmdLog, { key: 'cmds', entries: cmds }),
      showTurn ? h('ol', { key: 'live', className: 'ah-stream is-chat' }, h(LiveTurn, { s, agent, turn })) : null,
      h(Approvals, { key: 'approvals', s, agent })
    ]
  }

  const st = a ? AGENT_STATUS[a.status] || AGENT_STATUS.offline : null
  const cur = currentModel(s, agent)
  const sideOpen = !!s.ui.side && !s.ui.handoff
  const ph = turnLive ? PHASES[turn.phase] || PHASES.thinking : null
  const workLive = ((s.activity[agent] && s.activity[agent].data && s.activity[agent].data.items) || []).find(i => i.active) || null

  return h(
    'div',
    { className: cx('ah-chat', (s.ui.handoff || sideOpen) && 'has-panel', sideOpen && 'has-side', sideOpen && s.ui.sideFile && 'is-wide') },
    h(
      'section',
      { className: 'ah-chat-main', 'aria-label': `Chat with ${name}` },
      h(
        'header',
        { className: 'ah-chat-head' },
        h('span', { className: cx('ah-live-av', turnLive && 'is-on') }, h(Avatar, { id: agent, name, size: 36, status: a && a.status, mood: moodOf(s, agent) })),
        h(
          'div',
          { className: 'ah-chat-titles' },
          h('h2', { className: 'ah-chat-title' }, name),
          h(
            'p',
            { className: 'ah-chat-sub' },
            turnLive
              ? h('span', { className: 'ah-head-live' }, h('span', { className: 'ah-pulse', 'aria-hidden': 'true' }), ph.label)
              : workLive
                ? h('span', { className: 'ah-head-live' }, h('span', { className: 'ah-pulse', 'aria-hidden': 'true' }), `Working on: ${workLive.title}`)
                : a
                ? `${a.role || a.id}${st ? `, ${st.label.toLowerCase()}` : ''}`
                : agent,
            cur.model ? h('span', { className: 'ah-head-model ah-mono', title: `${cur.provider} / ${cur.model}` }, ` · ${cur.model}${cur.effort ? ` · ${reasoningLabel(cur.effort).toLowerCase()}` : ''}`) : null
          )
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'ah-btn ah-btn-outlined ah-state',
            disabled: !canOpen,
            title: chatId ? 'Open this agent’s Bot Chat session in the chat view' : 'This agent has no Bot Chat session yet',
            onClick: () => void openChatSession(agent)
          },
          h(Icon, { name: 'link-external', size: 16 }),
          h('span', { className: 'ah-hide-sm' }, 'Open in chat')
        ),
        h(
          'button',
          {
            type: 'button',
            className: cx('ah-icon-btn ah-state', sideOpen && 'is-on'),
            'aria-pressed': sideOpen ? 'true' : 'false',
            title: sideOpen ? 'Hide the session panel' : 'Show the session panel',
            'aria-label': sideOpen ? 'Hide the session panel' : 'Show the session panel',
            onClick: () => setUi({ side: !sideOpen, handoff: null })
          },
          h(Icon, { name: sideOpen ? 'layout-sidebar-right' : 'layout-sidebar-right-off', size: 18 })
        )
      ),
      h(SessionPicker, { s, agent }),
      h(
        'div',
        { className: 'ah-chat-body' },
        h(
          'div',
          { className: 'ah-chat-scroll', ref: scrollRef, onScroll, tabIndex: 0, role: 'log', 'aria-label': 'Chat timeline', 'aria-live': 'off' },
          h('div', { className: 'ah-chat-col' }, body)
        ),
        pill ? h('button', { type: 'button', className: 'ah-newpill ah-state', onClick: jumpBottom }, h(Icon, { name: 'arrow-down', size: 14 }), h('span', null, 'New messages')) : null
      ),
      h(Composer, { s, agent, onSent: () => { stick.current = true; setPill(false) } })
    ),
    s.ui.handoff ? h(HandoffPanel, { s }) : sideOpen ? h(ChatSide, { s, agent }) : null
  )
}

const SOURCE_LABEL = { desktop: 'Hermes', local: 'CLI', cli: 'CLI', tui: 'CLI', oneshot: 'One-shot', api: 'API', webhook: 'Webhook', facebook: 'Facebook', messenger: 'Messenger', zalo: 'Zalo', telegram: 'Telegram', discord: 'Discord', slack: 'Slack', whatsapp: 'WhatsApp', email: 'Email' }
const SOURCE_ICON = { desktop: 'comment', local: 'terminal', cli: 'terminal', tui: 'terminal', api: 'plug', webhook: 'plug', email: 'mail' }

function sourceLabel(src) {
  const k = String(src || '').toLowerCase()

  return SOURCE_LABEL[k] || (k ? k.charAt(0).toUpperCase() + k.slice(1) : 'Session')
}

// Switch between an agent's conversations (shown only when it has two or more). The pick is remembered.
function SessionPicker({ s, agent }) {
  const st = s.sessions[agent]
  const items = (st && st.data) || []

  if (items.length < 2) {
    return null
  }

  const pick = pickedSession(agent)
  const lv = s.live[agent]
  const locked = !!((lv && lv.turn && lv.turn.active) || (s.send[agent] && s.send[agent].busy))
  const chip = (id, label, sub, icon, title) => {
    const on = (pick || null) === (id || null)

    return h(
      'button',
      {
        key: id || '*',
        type: 'button',
        role: 'tab',
        'aria-selected': on ? 'true' : 'false',
        className: cx('ah-sess-chip ah-state', on && 'is-on'),
        disabled: locked && !on,
        title: locked && !on ? 'Switch after the current reply finishes' : title,
        onClick: () => pickSession(agent, id)
      },
      h(Icon, { name: icon, size: 14 }),
      h('span', { className: 'ah-sess-name' }, label),
      sub ? h('span', { className: 'ah-sess-sub' }, sub) : null
    )
  }

  return h(
    'div',
    { className: 'ah-sess-bar', role: 'tablist', 'aria-label': 'Conversations of this agent' },
    chip(null, 'All', String(items.length), 'list-unordered', 'Every conversation, merged. New messages go to the Bot Chat.'),
    items.map(g =>
      chip(
        g.id,
        g.bot_chat ? 'Bot Chat' : g.title,
        `${sourceLabel(g.source)} · ${relTime(g.last_at, s.now)}`,
        g.bot_chat ? 'comment' : SOURCE_ICON[String(g.source || '').toLowerCase()] || 'comment-discussion',
        `${g.title} (${sourceLabel(g.source)}, ${g.message_count} messages). New messages go to this conversation.`
      )
    )
  )
}

/* ───────────────────────── chat side panel ───────────────────────── */

const SIDE_FILES_PER_GROUP = 5
const SIDE_GROUPS = 6

function SideSection({ id, title, icon, count, children, actions }) {
  const closed = !!(S.ui.sideClosed && S.ui.sideClosed[id])

  return h(
    'section',
    { className: cx('ah-side-sec', closed && 'is-closed') },
    h(
      'div',
      { className: 'ah-side-sec-head' },
      h(
        'button',
        {
          type: 'button',
          className: 'ah-side-sec-toggle ah-state',
          'aria-expanded': closed ? 'false' : 'true',
          onClick: () => setUi({ sideClosed: { ...(S.ui.sideClosed || {}), [id]: !closed } })
        },
        h(Icon, { name: closed ? 'chevron-right' : 'chevron-down', size: 14 }),
        h(Icon, { name: icon, size: 14 }),
        h('span', { className: 'ah-side-sec-title' }, title),
        typeof count === 'number' ? h('span', { className: 'ah-tab-count' }, count) : null
      ),
      actions || null
    ),
    closed ? null : h('div', { className: 'ah-side-sec-body' }, children)
  )
}

function shortDir(dir, ctx) {
  const d = String(dir || '')

  for (const c of ctx || []) {
    const root = String(c.path || '').replace(/\/+$/, '')

    if (root && d.toLowerCase().startsWith(root.toLowerCase()) && c.kind !== 'home') {
      const rest = d.slice(root.length).replace(/^\/+/, '')

      return `${baseOf(root)}${rest ? `/${rest}` : ''}`
    }
  }

  const parts = d.split('/').filter(Boolean)

  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : d
}

function FilesSection({ s, agent, data }) {
  const [sel, setSel] = useState({})
  const [abusy, setAbusy] = useState(false)
  const [aerr, setAerr] = useState(null)
  const [openDirs, setOpenDirs] = useState({})
  const [moreDirs, setMoreDirs] = useState({})
  const [allGroups, setAllGroups] = useState(false)
  const files = (data && data.files) || []
  const groups = useMemo(() => {
    const m = new Map()

    for (const f of files) {
      const g = m.get(f.dir) || { dir: f.dir, files: [], last: 0 }

      g.files.push(f)
      g.last = Math.max(g.last, num(f.last_at))
      m.set(f.dir, g)
    }

    return [...m.values()].sort((x, y) => y.last - x.last)
  }, [files])

  const approvedN = num(data && data.files_approved)
  const picked = files.filter(f => sel[f.path]).map(f => f.path)
  const approve = async body => {
    setAbusy(true)
    setAerr(null)

    try {
      await approveFiles(agent, body)
      setSel({})
    } catch (e) {
      setAerr(errText(e))
    } finally {
      setAbusy(false)
    }
  }
  const approvedNote = approvedN
    ? h(
        'p',
        { className: 'ah-side-empty ah-approved-note' },
        h(Icon, { name: 'pass', size: 12 }),
        `${approvedN} approved files hidden (you can still roll back in chat). `,
        h('button', { type: 'button', className: 'ah-link ah-state', disabled: abusy, onClick: () => void approve({ reset: true }) }, 'Show again')
      )
    : null

  if (files.length === 0) {
    return h('div', null, h('p', { className: 'ah-side-empty' }, approvedN ? 'All changes approved.' : 'No files edited in this chat session yet.'), approvedNote, aerr ? h('p', { className: 'ah-live-error' }, aerr) : null)
  }

  const shown = allGroups ? groups : groups.slice(0, SIDE_GROUPS)

  return h(
    'div',
    { className: 'ah-side-files-wrap' },
    h(
      'div',
      { className: 'ah-approve-bar' },
      h('input', {
        type: 'checkbox',
        className: 'ah-approve-all-box',
        'aria-label': 'Select all files',
        checked: picked.length > 0 && picked.length === files.length,
        ref: el => {
          if (el) {
            el.indeterminate = picked.length > 0 && picked.length < files.length
          }
        },
        onChange: e => setSel(e.target.checked ? Object.fromEntries(files.map(f => [f.path, true])) : {})
      }),
      h('span', { className: 'ah-row-sub' }, picked.length ? `Selected ${picked.length}` : `${files.length} files to review`),
      h('span', { className: 'ah-spacer' }),
      picked.length
        ? h('button', { type: 'button', className: 'ah-btn ah-btn-tonal ah-btn-sm ah-state', disabled: abusy, title: 'Accept the selected changes and hide them', onClick: () => void approve({ paths: picked }) }, h(Icon, { name: 'check', size: 14 }), `Approve ${picked.length} files`)
        : h('button', { type: 'button', className: 'ah-btn ah-btn-tonal ah-btn-sm ah-state', disabled: abusy, title: 'Accept every change and hide them', onClick: () => void approve({ all: true }) }, h(Icon, { name: 'check-all', size: 14 }), 'Approve all')
    ),
    aerr ? h('p', { className: 'ah-live-error' }, aerr) : null,
    h(
    'div',
    { className: 'ah-side-files' },
    shown.map(g => {
      const collapsed = openDirs[g.dir] === false
      const more = !!moreDirs[g.dir]
      const list = more ? g.files : g.files.slice(0, SIDE_FILES_PER_GROUP)

      return h(
        'div',
        { key: g.dir, className: 'ah-side-dir' },
        h(
          'button',
          { type: 'button', className: 'ah-side-dir-head ah-state', 'aria-expanded': collapsed ? 'false' : 'true', title: g.dir, onClick: () => setOpenDirs({ ...openDirs, [g.dir]: collapsed }) },
          h(Icon, { name: collapsed ? 'chevron-right' : 'chevron-down', size: 12 }),
          h(Icon, { name: collapsed ? 'folder' : 'folder-opened', size: 14 }),
          h('span', { className: 'ah-side-dir-name ah-mono' }, shortDir(g.dir, data.context)),
          h('span', { className: 'ah-side-dir-n' }, g.files.length)
        ),
        collapsed
          ? null
          : h(
              'ul',
              { className: 'ah-side-flist' },
              list.map(f =>
                h(
                  'li',
                  { key: f.path, className: 'ah-side-fitem' },
                  h('input', { type: 'checkbox', className: 'ah-side-fcheck', 'aria-label': `Select ${f.name}`, checked: !!sel[f.path], onChange: e => setSel({ ...sel, [f.path]: e.target.checked }) }),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: cx('ah-side-file ah-state', s.ui.sideFile === f.path && 'is-selected'),
                      title: f.path,
                      onClick: () => openSideFile(agent, f.path)
                    },
                    h(FileBadge, { status: f.status }),
                    h('span', { className: 'ah-side-file-name' }, f.name),
                    f.failed ? h('span', { className: 'ah-side-file-warn', title: `${f.failed} failed edits` }, h(Icon, { name: 'warning', size: 12 })) : null,
                    h('span', { className: 'ah-spacer' }),
                    h(Delta, { a: f.additions, d: f.deletions }),
                    h('time', { className: 'ah-side-time', title: absTime(f.last_at) }, relTime(f.last_at, s.now))
                  )
                )
              ),
              g.files.length > SIDE_FILES_PER_GROUP
                ? h('li', { key: 'more' }, h('button', { type: 'button', className: 'ah-btn ah-btn-text ah-btn-sm ah-state', onClick: () => setMoreDirs({ ...moreDirs, [g.dir]: !more }) }, more ? 'Collapse' : `Show ${g.files.length - SIDE_FILES_PER_GROUP} more files`))
                : null
            )
      )
    }),
    groups.length > SIDE_GROUPS
      ? h('button', { type: 'button', className: 'ah-btn ah-btn-text ah-btn-sm ah-state', onClick: () => setAllGroups(!allGroups) }, allGroups ? 'Collapse folders' : `Show ${groups.length - SIDE_GROUPS} more folders`)
      : null,
    data.files_total > files.length ? h('p', { className: 'ah-side-empty' }, `Showing ${files.length} of ${data.files_total} files.`) : null
    ),
    approvedNote
  )
}

const GOAL_ICON = { active: 'circle-large-outline', done: 'pass-filled', dropped: 'circle-slash' }

function GoalsSection({ s, agent }) {
  const st = s.goals[agent]
  const d = st && st.data
  const [adding, setAdding] = useState('')
  const [editId, setEditId] = useState(null)
  const [editText, setEditText] = useState('')
  const [showClosed, setShowClosed] = useState(false)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)

  if (!d) {
    return h('p', { className: 'ah-side-empty' }, st && st.status === 'error' ? `Could not load goals (${st.error}).` : 'Loading goals…')
  }

  const act = async body => {
    setBusy(true)
    setErr(null)

    try {
      await goalAction(agent, body)

      return true
    } catch (e) {
      setErr(errText(e))

      return false
    } finally {
      setBusy(false)
    }
  }

  const saveEdit = async () => {
    const t = editText.trim()

    if (t && (await act({ action: 'edit', id: editId, title: t }))) {
      setEditId(null)
    }
  }

  const goals = d.goals || []
  const active = goals.filter(g => g.status === 'active')
  const closed = goals.filter(g => g.status !== 'active')

  const row = g => {
    const current = g.id === d.current

    if (editId === g.id) {
      return h(
        'li',
        { key: g.id, className: 'ah-goal is-editing' },
        h('input', {
          className: 'ah-goal-input',
          value: editText,
          autoFocus: true,
          'aria-label': 'Edit goal',
          onChange: e => setEditText(e.target.value),
          onKeyDown: e => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void saveEdit()
            } else if (e.key === 'Escape') {
              setEditId(null)
            }
          }
        }),
        h('button', { type: 'button', className: 'ah-icon-btn ah-icon-btn-sm ah-state', title: 'Save', 'aria-label': 'Save goal', disabled: busy, onClick: () => void saveEdit() }, h(Icon, { name: 'check', size: 14 })),
        h('button', { type: 'button', className: 'ah-icon-btn ah-icon-btn-sm ah-state', title: 'Cancel', 'aria-label': 'Cancel edit', onClick: () => setEditId(null) }, h(Icon, { name: 'close', size: 14 }))
      )
    }

    return h(
      'li',
      { key: g.id, className: cx('ah-goal', current && 'is-current', `is-${g.status}`) },
      h(
        'button',
        {
          type: 'button',
          className: 'ah-goal-main ah-state',
          disabled: busy || g.status !== 'active' || current,
          title: current ? 'Current goals' : g.status === 'active' ? 'Make current goal' : g.title,
          onClick: () => void act({ action: 'current', id: g.id })
        },
        h(Icon, { name: current ? 'target' : GOAL_ICON[g.status] || 'circle-large-outline', size: 14, className: 'ah-goal-ico' }),
        h(
          'span',
          { className: 'ah-goal-body' },
          current ? h('span', { className: 'ah-goal-tag' }, 'Current') : null,
          h('span', { className: 'ah-goal-title' }, g.title),
          h('span', { className: 'ah-goal-meta' }, `${g.by === 'agent' ? 'Set by agent' : 'Set by you'} · ${g.status === 'done' ? `done ${relTime(g.done_at, s.now)}` : relTime(g.updated_at || g.created_at, s.now)}`, g.stale ? h('span', { className: 'ah-goal-stale', title: 'No progress for a while: mark it done or delete it' }, ` · idle ${g.idle_days} days`) : null)
        )
      ),
      h(
        'span',
        { className: 'ah-goal-acts' },
        g.status === 'active'
          ? h('button', { type: 'button', className: 'ah-icon-btn ah-icon-btn-sm ah-state', title: 'Mark done', 'aria-label': `Xong: ${g.title}`, disabled: busy, onClick: () => void act({ action: 'done', id: g.id }) }, h(Icon, { name: 'check', size: 14 }))
          : h('button', { type: 'button', className: 'ah-icon-btn ah-icon-btn-sm ah-state', title: 'Reopen', 'aria-label': `Reopen: ${g.title}`, disabled: busy, onClick: () => void act({ action: 'reopen', id: g.id }) }, h(Icon, { name: 'debug-restart', size: 14 })),
        h('button', { type: 'button', className: 'ah-icon-btn ah-icon-btn-sm ah-state', title: 'Edit', 'aria-label': `Edit: ${g.title}`, onClick: () => { setEditId(g.id); setEditText(g.title) } }, h(Icon, { name: 'edit', size: 14 })),
        h(
          'button',
          {
            type: 'button',
            className: 'ah-icon-btn ah-icon-btn-sm ah-state',
            title: 'Delete',
            'aria-label': `Delete: ${g.title}`,
            disabled: busy,
            onClick: () => {
              const okDel = typeof window === 'undefined' || typeof window.confirm !== 'function' || window.confirm(`Delete goal "${g.title}"?`)

              if (okDel) {
                void act({ action: 'delete', id: g.id })
              }
            }
          },
          h(Icon, { name: 'trash', size: 14 })
        )
      )
    )
  }

  const add = async () => {
    const t = adding.trim()

    if (t && (await act({ action: 'add', title: t, current: active.length === 0 }))) {
      setAdding('')
    }
  }

  return h(
    'div',
    { className: 'ah-goals' },
    active.length === 0 && closed.length === 0 ? h('p', { className: 'ah-side-empty' }, 'No goals yet. Give the agent work and it sets and updates goals itself, or add one below.') : null,
    active.length ? h('ul', { className: 'ah-goal-list' }, active.map(row)) : null,
    closed.length
      ? h(
          'div',
          { className: 'ah-goal-closed' },
          h('button', { type: 'button', className: 'ah-btn ah-btn-text ah-btn-sm ah-state', 'aria-expanded': showClosed ? 'true' : 'false', onClick: () => setShowClosed(!showClosed) }, h(Icon, { name: showClosed ? 'chevron-down' : 'chevron-right', size: 12 }), `${closed.length} goals done or dropped`),
          showClosed ? h('ul', { className: 'ah-goal-list' }, closed.map(row)) : null
        )
      : null,
    h(
      'div',
      { className: 'ah-goal-add' },
      h(Icon, { name: 'add', size: 14 }),
      h('input', {
        className: 'ah-goal-input',
        value: adding,
        placeholder: 'Add a goal…',
        'aria-label': 'Add goal',
        disabled: busy,
        onChange: e => setAdding(e.target.value),
        onKeyDown: e => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void add()
          }
        }
      })
    ),
    err ? h('p', { className: 'ah-live-error' }, err) : null
  )
}

const TOOL_ICON = { url: 'globe', path: 'file-symlink-file', command: 'terminal' }
const RUNNABLE_EXT = /\.(exe|bat|cmd|ps1|vbs|msi|lnk|com|scr|jar|sh)$/i

function ToolsSection({ s, agent }) {
  const st = s.tools[agent]
  const d = st && st.data
  const [err, setErr] = useState(null)
  const [note, setNote] = useState(null)
  const [busy, setBusy] = useState(false)

  if (!d) {
    return h('p', { className: 'ah-side-empty' }, st && st.status === 'error' ? `Could not load tools (${st.error}).` : 'Loading tools…')
  }

  const os = C && C.os
  const copy = async t => {
    const ok = os && typeof os.writeClipboard === 'function' ? await os.writeClipboard(t.target) : false

    setNote(ok ? `Copied: ${t.target}` : t.target)
  }

  const open = async t => {
    setErr(null)
    setNote(null)

    if (t.kind === 'command') {
      await copy(t) // the Hub never runs commands; paste it, or ask the agent to run it

      return
    }

    if (RUNNABLE_EXT.test(t.target) && typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(`Run ${t.target}?`)) {
      return
    }

    const ok = os && typeof os.openExternal === 'function' ? await os.openExternal(t.target) : false

    if (!ok) {
      setErr(`Could not open ${t.target}. Ask the agent to open it.`)
    }
  }

  const remove = async t => {
    const okDel = typeof window === 'undefined' || typeof window.confirm !== 'function' || window.confirm(`Remove "${t.name}" from saved tools?`)

    if (!okDel) {
      return
    }

    setBusy(true)
    setErr(null)

    try {
      await toolAction(agent, { action: 'remove', id: t.id })
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const tools = d.tools || []

  return h(
    'div',
    { className: 'ah-tools' },
    tools.length === 0
      ? h('p', { className: 'ah-side-empty' }, 'No saved tools. Tools and apps this agent builds for you to reopen show here; ask it to add one to the Hub.')
      : h(
          'ul',
          { className: 'ah-goal-list' },
          tools.map(t =>
            h(
              'li',
              { key: t.id, className: 'ah-goal ah-tool' },
              h(
                'button',
                { type: 'button', className: 'ah-goal-main ah-state', title: t.kind === 'command' ? `Copy the command: ${t.target}` : `Open ${t.target}`, onClick: () => void open(t) },
                h(Icon, { name: TOOL_ICON[t.kind] || 'tools', size: 14, className: 'ah-goal-ico' }),
                h(
                  'span',
                  { className: 'ah-goal-body' },
                  h('span', { className: 'ah-goal-title' }, t.name),
                  t.note ? h('span', { className: 'ah-goal-meta' }, t.note) : null,
                  h('span', { className: 'ah-goal-meta ah-mono ah-tool-target' }, t.target)
                )
              ),
              h(
                'span',
                { className: 'ah-goal-acts' },
                h('button', { type: 'button', className: 'ah-icon-btn ah-icon-btn-sm ah-state', title: 'Copy', 'aria-label': `Copy: ${t.name}`, onClick: () => void copy(t) }, h(Icon, { name: 'copy', size: 14 })),
                h('button', { type: 'button', className: 'ah-icon-btn ah-icon-btn-sm ah-state', title: 'Remove', 'aria-label': `Remove: ${t.name}`, disabled: busy, onClick: () => void remove(t) }, h(Icon, { name: 'trash', size: 14 }))
              )
            )
          )
        ),
    note ? h('p', { className: 'ah-side-empty ah-mono' }, note) : null,
    err ? h('p', { className: 'ah-live-error' }, err) : null
  )
}

function CommandsSection({ s, agent }) {
  const [openId, setOpenId] = useState(null)
  const st = s.commands
  const items = ((st && st.data && st.data.items) || []).filter(x => x.agent === agent)
  const lv = s.live[agent]
  const liveTools = lv && lv.turn && lv.turn.active ? lv.turn.tools.filter(t => t.state === 'run') : []
  const open = items.find(x => x.id === openId) || null

  useEffect(() => {
    if (!open || open.kind !== 'background' || !C) {
      return undefined
    }

    void fetchCommandOutput(open.id)
    const stop = C.setInterval(() => void fetchCommandOutput(open.id), 3000)

    return () => {
      if (typeof stop === 'function') {
        stop()
      }
    }
  }, [open && open.id])

  if (!st || (!st.data && st.status !== 'error')) {
    return h('p', { className: 'ah-side-empty' }, 'Loading…')
  }

  if (!st.data) {
    return h('p', { className: 'ah-side-empty' }, `Could not load commands (${st.error}).`)
  }

  if (items.length === 0) {
    return h('p', { className: 'ah-side-empty' }, 'No commands running.')
  }

  return h(
    'ul',
    { className: 'ah-cmds' },
    items.map(c => {
      const isOpen = openId === c.id
      const out = s.cmdOut[c.id]
      const liveTool = c.kind === 'foreground' ? liveTools.find(t => t.name === c.tool) : null

      return h(
        'li',
        { key: c.id, className: cx('ah-cmd-item', isOpen && 'is-open') },
        h(
          'button',
          { type: 'button', className: 'ah-cmd-row ah-state', 'aria-expanded': isOpen ? 'true' : 'false', onClick: () => setOpenId(isOpen ? null : c.id), title: c.visible ? 'Running visibly in the chat session: click to view' : 'Running hidden (background): click to view output' },
          h('span', { className: 'ah-cmd-live', 'aria-hidden': 'true' }),
          h(Icon, { name: c.visible ? 'eye' : 'eye-closed', size: 14, className: 'ah-cmd-vis' }),
          h(Icon, { name: toolIcon(c.tool), size: 14 }),
          h('span', { className: 'ah-cmd-text ah-mono' }, c.command || c.tool),
          h('time', { className: 'ah-side-time', title: absTime(c.started_at) }, relTime(c.started_at, s.now))
        ),
        isOpen
          ? h(
              'div',
              { className: 'ah-cmd-detail' },
              h('pre', { className: 'ah-cmd-full ah-mono' }, c.command),
              h(
                'p',
                { className: 'ah-cmd-meta' },
                c.visible ? 'Visible · the agent is waiting for the result' : 'Hidden (background)',
                c.pid ? ` · PID ${c.pid}` : '',
                c.cwd ? ` · ${c.cwd}` : '',
                c.session_title ? ` · ${c.session_title}` : ''
              ),
              c.kind === 'background'
                ? h('pre', { className: 'ah-cmd-out ah-mono' }, out ? out.output || (out.error ? `Could not read output (${out.error}).` : '(no output yet)') : 'Loading output…')
                : liveTool
                  ? h('ol', { className: 'ah-live-tools' }, h(LiveTool, { tool: liveTool }))
                  : h('p', { className: 'ah-side-empty' }, 'Output appears in the chat when the command finishes.')
            )
          : null
      )
    })
  )
}

function PeersSection({ s, agent, data }) {
  const peers = (data && data.peers) || []
  const lv = s.live[agent]
  const myTurn = lv && lv.turn && lv.turn.active ? lv.turn : null
  const delegating = myTurn ? myTurn.tools.filter(t => t.state === 'run' && /delegate|subagent|send_message|bot_relay/i.test(t.name)) : []

  if (peers.length === 0 && delegating.length === 0) {
    return h('p', { className: 'ah-side-empty' }, 'This agent has not worked with other agents yet.')
  }

  return h(
    'ul',
    { className: 'ah-side-peers' },
    delegating.map(t =>
      h(
        'li',
        { key: `run-${t.id}`, className: 'ah-peer is-live' },
        h('span', { className: 'ah-peer-av' }, h(Icon, { name: 'organization', size: 16 })),
        h('div', { className: 'ah-peer-body' }, h('span', { className: 'ah-peer-name' }, 'Delegating'), h('span', { className: 'ah-peer-doing' }, t.context || t.name)),
        h(Icon, { name: 'loading', size: 14, spinning: true })
      )
    ),
    peers.map(p => {
      const active = p.agent_status === 'active' || p.running > 0
      const other = list('agents', 'agents').find(x => x.id === p.agent)

      return h(
        'li',
        { key: p.agent, className: cx('ah-peer', active && 'is-live') },
        h(
          'button',
          {
            type: 'button',
            className: 'ah-peer-main ah-state',
            title: `Chat with ${p.name}: see what ${p.name} is doing`,
            onClick: () => setUi({ agent: p.agent, tab: 'chat', handoff: null, sideFile: null })
          },
          h('span', { className: cx('ah-live-av', active && 'is-on') }, h(Avatar, { id: p.agent, name: p.name, size: 32, status: other ? other.status : active ? 'active' : 'idle', mood: moodOf(s, p.agent) })),
          h(
            'div',
            { className: 'ah-peer-body' },
            h(
              'span',
              { className: 'ah-peer-name' },
              p.name,
              h('span', { className: cx('ah-peer-dir', p.direction === 'out' ? 'is-out' : 'is-in') }, p.direction === 'out' ? 'was given work' : 'gave this agent work'),
              p.count > 1 ? h('span', { className: 'ah-peer-count' }, `${p.count} times`) : null,
              !active && p.blocked > 0 ? h('span', { className: 'ah-peer-count is-blocked', title: 'A shared Kanban card is blocked: open the Tasks tab to see who it waits on' }, 'Blocked') : null
            ),
            h('span', { className: 'ah-peer-task', title: p.title }, p.title),
            p.doing
              ? h('span', { className: cx('ah-peer-doing', active && 'is-active') }, active ? h('span', { className: 'ah-pulse', 'aria-hidden': 'true' }) : null, `${active ? 'Working' : 'Latest'}: ${p.doing}`, p.doing_at ? h('time', { className: 'ah-side-time' }, ` · ${relTime(p.doing_at, s.now)}`) : null)
              : null
          )
        ),
        h(Icon, { name: 'chevron-right', size: 14, className: 'ah-peer-go' })
      )
    })
  )
}

const CTX_ICON = { cwd: 'terminal', repo: 'repo', project: 'folder-library', touched: 'edit', home: 'home' }

function ContextSection({ data }) {
  const ctx = (data && data.context) || []
  const [copied, setCopied] = useState('')

  if (ctx.length === 0) {
    return h('p', { className: 'ah-side-empty' }, 'No working folder detected yet.')
  }

  const copy = p => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        void navigator.clipboard.writeText(p)
        setCopied(p)
        setTimeout(() => setCopied(''), 1500)
      }
    } catch {
      /* clipboard is best effort */
    }
  }

  return h(
    'ul',
    { className: 'ah-side-ctx' },
    ctx.map(c =>
      h(
        'li',
        { key: c.path, className: cx('ah-ctx', !c.exists && 'is-missing') },
        h('span', { className: 'ah-ctx-icon' }, h(Icon, { name: c.denied ? 'lock' : CTX_ICON[c.kind] || 'folder', size: 14 })),
        h('div', { className: 'ah-ctx-body' }, h('span', { className: 'ah-ctx-label' }, c.label, !c.exists ? ' (no longer exists)' : ''), h('span', { className: 'ah-ctx-path ah-mono', title: c.path }, c.path)),
        h('button', { type: 'button', className: 'ah-icon-btn ah-icon-btn-sm ah-state', title: copied === c.path ? 'Copied' : 'Copy path', 'aria-label': 'Copy path', onClick: () => copy(c.path) }, h(Icon, { name: copied === c.path ? 'check' : 'copy', size: 14 }))
      )
    )
  )
}

function DiffBody({ text, wrap, label, empty }) {
  const lines = useMemo(() => parseDiff(text), [text])

  if (lines.length === 0) {
    return empty || h(EmptyState, { icon: 'diff', title: 'No changes to show' })
  }

  const shown = lines.slice(0, MAX_DIFF_LINES)

  return h(
    'div',
    { className: cx('ah-diff', wrap && 'is-wrap'), role: 'region', 'aria-label': label, tabIndex: 0 },
    h(
      'div',
      { className: 'ah-diff-body' },
      shown.map((ln, i) => {
        if (ln.t === 'hunk') {
          return h('div', { key: i, className: 'ah-dl is-hunk' }, h('span', { className: 'ah-dl-code' }, ln.text))
        }

        if (ln.t === 'meta' || ln.t === 'note') {
          return h('div', { key: i, className: 'ah-dl is-meta' }, h('span', { className: 'ah-dl-code' }, ln.text))
        }

        const sign = ln.t === 'add' ? '+' : ln.t === 'del' ? '\u2212' : ' '

        return h(
          'div',
          { key: i, className: cx('ah-dl', `is-${ln.t}`) },
          h('span', { className: 'ah-dl-no', 'aria-hidden': 'true' }, ln.o ?? ''),
          h('span', { className: 'ah-dl-no', 'aria-hidden': 'true' }, ln.n ?? ''),
          h('span', { className: 'ah-dl-sign', 'aria-hidden': 'true' }, sign),
          h('span', { className: 'ah-dl-code' }, ln.text === '' ? '\u00a0' : ln.text)
        )
      })
    ),
    lines.length > MAX_DIFF_LINES ? h('p', { className: 'ah-diff-note' }, `Showing the first ${MAX_DIFF_LINES} of ${lines.length} lines.`) : null
  )
}

function CodeBody({ text, wrap, label }) {
  const lines = useMemo(() => String(text || '').split('\n'), [text])
  const shown = lines.slice(0, MAX_DIFF_LINES)

  return h(
    'div',
    { className: cx('ah-diff ah-code', wrap && 'is-wrap'), role: 'region', 'aria-label': label, tabIndex: 0 },
    h(
      'div',
      { className: 'ah-diff-body' },
      shown.map((ln, i) => h('div', { key: i, className: 'ah-dl is-ctx' }, h('span', { className: 'ah-dl-no', 'aria-hidden': 'true' }, i + 1), h('span', { className: 'ah-dl-code' }, ln === '' ? '\u00a0' : ln)))
    ),
    lines.length > MAX_DIFF_LINES ? h('p', { className: 'ah-diff-note' }, `Showing the first ${MAX_DIFF_LINES} of ${lines.length} lines.`) : null
  )
}

const DIFF_SOURCE = { git: 'Against git HEAD', session: 'Patches in this session', write: 'Content the agent wrote', none: '' }

function FilePreview({ s, agent, path }) {
  const entry = s.preview[previewKey(agent, path)]
  const d = entry && entry.data
  const isMd = /\.(md|markdown|mdx)$/i.test(path || '')
  const view = s.ui.sideView === 'preview' ? (isMd ? 'preview' : 'content') : s.ui.sideView === 'content' ? 'content' : 'diff'
  const wrap = !!s.ui.wrap
  const ws = s.ws[agent] && s.ws[agent].data
  const f = ws && Array.isArray(ws.files) ? ws.files.find(x => x.path === path) : null

  let body

  if (!entry || (entry.status === 'loading' && !d)) {
    body = h(Skeleton, { rows: 10, className: 'ah-inset' })
  } else if (entry.status === 'error' && !d) {
    body = h(ErrorState, { message: 'Could not open the file', detail: entry.error, onRetry: () => void fetchPreview(agent, path), compactMode: true })
  } else if (d.hidden) {
    body = h(EmptyState, { icon: 'lock', title: 'File hidden for security', hint: 'The file is on the deny list (keys, tokens, private folders…).' })
  } else if (view === 'diff') {
    body = h(DiffBody, {
      text: d.diff,
      wrap,
      label: `Changes to ${d.name}`,
      empty: h(EmptyState, { icon: 'diff', title: 'No text diff', hint: d.exists ? 'The file may be committed or binary. See the Content tab.' : 'The file no longer exists.' })
    })
  } else if (!d.exists) {
    body = h(EmptyState, { icon: 'file', title: 'The file no longer exists', hint: 'The agent deleted or moved this file.' })
  } else if (d.binary) {
    body = h(EmptyState, { icon: 'file-media', title: 'Binary file', hint: 'Binary files cannot be previewed.' })
  } else if (view === 'preview') {
    body = h('div', { className: 'ah-md-preview', 'aria-label': `Preview ${d.name}` }, h(Markdown, { text: d.content }))
  } else {
    body = h(CodeBody, { text: d.content, wrap, label: `Content ${d.name}` })
  }

  return h(
    'div',
    { className: 'ah-side-preview' },
    h(
      'header',
      { className: 'ah-side-pv-head' },
      h('button', { type: 'button', className: 'ah-icon-btn ah-icon-btn-sm ah-state', title: 'Back to the list', 'aria-label': 'Back to the list', onClick: () => setUi({ sideFile: null }) }, h(Icon, { name: 'arrow-left', size: 16 })),
      f ? h(FileBadge, { status: f.status }) : null,
      h('div', { className: 'ah-side-pv-titles' }, h('span', { className: 'ah-side-pv-name' }, baseOf(path)), h('span', { className: 'ah-side-pv-path ah-mono', title: path }, path)),
      h('button', { type: 'button', className: 'ah-icon-btn ah-icon-btn-sm ah-state', title: 'Reload', 'aria-label': 'Reload', onClick: () => void fetchPreview(agent, path) }, h(Icon, { name: 'sync', size: 14, spinning: !!(entry && entry.status === 'loading') }))
    ),
    h(
      'div',
      { className: 'ah-side-pv-bar' },
      h(
        'div',
        { className: 'ah-seg', role: 'tablist' },
        [
          ['diff', 'Changes', 'diff'],
          ['content', 'Content', 'file-code'],
          isMd ? ['preview', 'Preview', 'open-preview'] : null
        ].filter(Boolean).map(([id, label, icon]) =>
          h('button', { key: id, type: 'button', role: 'tab', 'aria-selected': view === id ? 'true' : 'false', className: cx('ah-seg-btn ah-state', view === id && 'is-on'), onClick: () => setUi({ sideView: id }) }, h(Icon, { name: icon, size: 14 }), h('span', null, label))
        )
      ),
      h('span', { className: 'ah-spacer' }),
      f ? h(Delta, { a: f.additions, d: f.deletions }) : null,
      h('button', { type: 'button', className: cx('ah-icon-btn ah-icon-btn-sm ah-state', wrap && 'is-on'), 'aria-pressed': wrap ? 'true' : 'false', title: 'Wrap lines', 'aria-label': 'Wrap lines', onClick: () => setUi({ wrap: !wrap }) }, h(Icon, { name: 'word-wrap', size: 14 }))
    ),
    d && !d.hidden
      ? h(
          'p',
          { className: 'ah-side-pv-meta' },
          `${d.ops.length} edits this session`,
          d.ops.length ? ` · latest ${relTime(d.ops[d.ops.length - 1].at, s.now)}` : '',
          view === 'diff' && DIFF_SOURCE[d.diff_source] ? ` · ${DIFF_SOURCE[d.diff_source]}` : '',
          (view === 'diff' ? d.diff_truncated : d.content_truncated) ? ' · truncated (too large)' : ''
        )
      : null,
    h('div', { className: 'ah-side-pv-body' }, body)
  )
}

function ChatSide({ s, agent }) {
  const entry = s.ws[agent]
  const data = entry && entry.data

  if (s.ui.sideFile) {
    return h('aside', { className: 'ah-side', 'aria-label': 'File viewer' }, h(FilePreview, { s, agent, path: s.ui.sideFile }))
  }

  const activeGoals = ((s.goals[agent] && s.goals[agent].data && s.goals[agent].data.goals) || []).filter(g => g.status === 'active').length
  const goalsSec = h(SideSection, { key: 'goals', id: 'goals', title: 'Goal', icon: 'target', count: activeGoals }, h(GoalsSection, { s, agent }))
  const cmdsSec = h(SideSection, { key: 'cmds', id: 'cmds', title: 'Running commands', icon: 'terminal', count: cmdCount(s, agent) }, h(CommandsSection, { s, agent }))
  const toolCount = ((s.tools[agent] && s.tools[agent].data && s.tools[agent].data.tools) || []).length
  const toolsSec = h(SideSection, { key: 'tools', id: 'tools', title: 'Saved tools', icon: 'tools', count: toolCount }, h(ToolsSection, { s, agent }))
  let content

  if (!entry || (entry.status === 'loading' && !data)) {
    content = h(Skeleton, { rows: 6, className: 'ah-inset' })
  } else if (entry.status === 'error' && !data) {
    content = h(ErrorState, { message: 'Could not load the session', detail: entry.error, onRetry: () => void fetchWorkspace(agent), compactMode: true })
  } else {
    content = [
      h(SideSection, { key: 'files', id: 'files', title: 'Changed files', icon: 'git-compare', count: data.files_total || 0 }, h(FilesSection, { s, agent, data })),
      h(SideSection, { key: 'peers', id: 'peers', title: 'Working with', icon: 'organization', count: (data.peers || []).length }, h(PeersSection, { s, agent, data })),
      h(SideSection, { key: 'ctx', id: 'ctx', title: 'Folders accessed', icon: 'folder-library', count: (data.context || []).length }, h(ContextSection, { data }))
    ]
  }

  return h(
    'aside',
    { className: 'ah-side', 'aria-label': 'Session' },
    h(
      'header',
      { className: 'ah-side-head' },
      h('h2', { className: 'ah-side-title' }, 'Session'),
      h('span', { className: 'ah-spacer' }),
      h('button', { type: 'button', className: 'ah-icon-btn ah-icon-btn-sm ah-state', title: 'Reload', 'aria-label': 'Reload', onClick: () => { void fetchWorkspace(agent); void fetchTools(agent) } }, h(Icon, { name: 'sync', size: 14, spinning: !!(entry && entry.status === 'loading') })),
      h('button', { type: 'button', className: 'ah-icon-btn ah-icon-btn-sm ah-state', title: 'Hide panel', 'aria-label': 'Hide panel', onClick: () => setUi({ side: false }) }, h(Icon, { name: 'close', size: 14 }))
    ),
    h('div', { className: 'ah-side-body' }, goalsSec, cmdsSec, toolsSec, content)
  )
}

/* ───────────────────────── works ───────────────────────── */

const SCHEDULE_PRESETS = [
  { value: 'daily', label: 'Daily at 9:00', expr: '0 9 * * *' },
  { value: 'weekdays', label: 'Weekdays at 9:00', expr: '0 9 * * 1-5' },
  { value: 'weekly', label: 'Mondays at 9:00', expr: '0 9 * * 1' },
  { value: 'monthly', label: '1st of each month at 9:00', expr: '0 9 1 * *' },
  { value: 'hourly', label: 'Hourly', expr: '0 * * * *' },
  { value: 'every-15-minutes', label: 'Every 15 minutes', expr: '*/15 * * * *' },
  { value: 'custom', label: 'Custom' }
]

function ScheduleForm({ s, onClose }) {
  const agents = list('agents', 'agents')
  const [agent, setAgent] = useState(s.ui.agent || (agents[0] && agents[0].id) || 'default')
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [preset, setPreset] = useState('daily')
  const [custom, setCustom] = useState('')
  const [deliver, setDeliver] = useState('local')
  const [repeat, setRepeat] = useState('')
  const [targets, setTargets] = useState([{ id: 'local', name: 'Local (save only)' }])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const schedule = preset === 'custom' ? custom.trim() : (SCHEDULE_PRESETS.find(p => p.value === preset) || {}).expr || ''

  useEffect(() => {
    let off = false

    C.rest(`/schedules/targets?agent=${enc(agent)}`)
      .then(d => !off && Array.isArray(d.targets) && d.targets.length && setTargets(d.targets))
      .catch(() => {})

    return () => {
      off = true
    }
  }, [agent])

  const submit = async e => {
    e.preventDefault()

    if (busy) {
      return
    }

    if (!prompt.trim() || !schedule) {
      setErr(!prompt.trim() ? 'Enter what the agent should do.' : 'Enter a schedule.')

      return
    }

    setBusy(true)
    setErr(null)

    try {
      const n = parseInt(repeat, 10)

      await C.rest('/schedules', { method: 'POST', body: { agent, name: name.trim(), prompt: prompt.trim(), schedule, deliver, ...(n > 0 ? { repeat: n } : {}) } })
      onClose(name.trim() || prompt.trim().slice(0, 40))
    } catch (e2) {
      setErr(errText(e2))
      setBusy(false)
    }
  }

  const field = (label, control, hint) => h('label', { className: 'ah-field' }, h('span', { className: 'ah-field-label' }, label), control, hint ? h('span', { className: 'ah-field-hint' }, hint) : null)

  return h(
    'form',
    { className: 'ah-sched-form', onSubmit: submit, 'aria-label': 'New scheduled job' },
    h('div', { className: 'ah-sched-head' }, h(Icon, { name: 'history', size: 16 }), h('h3', null, 'New scheduled job'), h('span', { className: 'ah-spacer' }), h('button', { type: 'button', className: 'ah-icon-btn ah-icon-btn-sm ah-state', 'aria-label': 'Close', onClick: () => onClose(null) }, h(Icon, { name: 'close', size: 14 }))),
    h(
      'div',
      { className: 'ah-sched-grid' },
      field('Agent', h('select', { className: 'ah-input', value: agent, onChange: e => setAgent(e.target.value) }, agents.map(a => h('option', { key: a.id, value: a.id }, a.name || a.id)))),
      field('Name (optional)', h('input', { className: 'ah-input', value: name, placeholder: 'e.g. Morning report', onChange: e => setName(e.target.value) }))
    ),
    field('Prompt for the agent', h('textarea', { className: 'ah-input ah-sched-prompt', rows: 4, value: prompt, placeholder: 'What should the agent do on each run?', onChange: e => setPrompt(e.target.value) })),
    h(
      'div',
      { className: 'ah-sched-grid' },
      field('Frequency', h('select', { className: 'ah-input', value: preset, onChange: e => setPreset(e.target.value) }, SCHEDULE_PRESETS.map(p => h('option', { key: p.value, value: p.value }, p.label)))),
      field('Deliver to', h('select', { className: 'ah-input', value: deliver, onChange: e => setDeliver(e.target.value) }, targets.map(t => h('option', { key: t.id, value: t.id, disabled: t.home_target_set === false }, `${t.name || t.id}${t.home_target_set === false ? ' (not configured)' : ''}`))))
    ),
    h(
      'div',
      { className: 'ah-sched-grid' },
      preset === 'custom'
        ? field('Custom schedule', h('input', { className: 'ah-input ah-mono', value: custom, placeholder: '0 9 * * * or every 2h or 30m', onChange: e => setCustom(e.target.value) }), '5-field cron, "every 2h", "30m" or an ISO timestamp.')
        : h('div', { className: 'ah-field' }, h('span', { className: 'ah-field-label' }, 'Cron expression'), h('span', { className: 'ah-sched-expr ah-mono' }, schedule)),
      field('Repeat', h('input', { className: 'ah-input', type: 'number', min: 1, value: repeat, placeholder: 'Empty = forever', onChange: e => setRepeat(e.target.value) }))
    ),
    err ? h('p', { className: 'ah-live-error', role: 'alert' }, err) : null,
    h(
      'div',
      { className: 'ah-edit-actions' },
      h('span', { className: 'ah-spacer' }),
      h('button', { type: 'button', className: 'ah-btn ah-btn-text ah-btn-sm ah-state', disabled: busy, onClick: () => onClose(null) }, 'Cancel'),
      h('button', { type: 'submit', className: 'ah-btn ah-btn-tonal ah-btn-sm ah-state', disabled: busy }, busy ? h(Icon, { name: 'loading', size: 14, spinning: true }) : h(Icon, { name: 'add', size: 14 }), 'New scheduled job')
    )
  )
}

function Works({ s, v }) {
  const [form, setForm] = useState(false)
  const [made, setMade] = useState(null)
  const toolbar = h(
    'div',
    { className: 'ah-works-bar' },
    made ? h('span', { className: 'ah-row-sub', role: 'status' }, h(Icon, { name: 'pass', size: 12 }), ` Created scheduled job "${made}".`) : null,
    h('span', { className: 'ah-spacer' }),
    form ? null : h('button', { type: 'button', className: 'ah-btn ah-btn-tonal ah-btn-sm ah-state', disabled: !C, onClick: () => { setForm(true); setMade(null) } }, h(Icon, { name: 'add', size: 14 }), 'New scheduled job')
  )
  const top = [
    h('div', { key: 'bar' }, toolbar),
    form
      ? h(ScheduleForm, {
          key: 'form',
          s,
          onClose: created => {
            setForm(false)

            if (created) {
              setMade(created)
              void load()
            }
          }
        })
      : null
  ]
  const items = v.works

  if (s.works.status === 'error' && items.length === 0) {
    return h(ErrorState, { message: 'Could not load scheduled jobs', detail: s.works.error, onRetry: () => void load() })
  }

  if (s.works.status !== 'ready' && !s.works.data) {
    return h(Skeleton, { rows: 8, className: 'ah-pad' })
  }

  if (items.length === 0) {
    return h(
      'div',
      { className: 'ah-pad' },
      top,
      h(EmptyState, {
        icon: 'history',
        title: s.ui.agent || s.ui.q ? 'No scheduled job matches the filter' : 'No scheduled jobs yet',
        hint: s.ui.agent || s.ui.q ? 'Clear the agent filter or change the search.' : 'Recurring jobs, runs and active delegations show up here.'
      })
    )
  }

  return h(
    'div',
    { className: 'ah-pad' },
    top,
    h(
      'div',
      { className: 'ah-table-wrap' },
      h(
        'table',
        { className: 'ah-table' },
        h('caption', { className: 'ah-sr' }, 'Scheduled jobs of every agent'),
        h('thead', null, h('tr', null, ['Job', 'Agent', 'Schedule', 'Last run', 'Next run', 'Status'].map(t => h('th', { key: t, scope: 'col' }, t)))),
        h(
          'tbody',
          null,
          items.map(w =>
            h(
              'tr',
              { key: `${w.kind}-${w.id}` },
              h(
                'td',
                null,
                h(
                  'div',
                  { className: 'ah-work-title' },
                  h('span', { className: 'ah-kind-icon', title: KIND_LABEL[w.kind] || w.kind }, h(Icon, { name: KIND_ICON[w.kind] || 'play', size: 16 })),
                  h('span', { className: 'ah-work-body' }, h('span', { className: 'ah-row-title' }, w.title), h('span', { className: 'ah-row-sub' }, `${KIND_LABEL[w.kind] || w.kind}${w.last_result ? `: ${w.last_result}` : ''}`))
                )
              ),
              h('td', null, h('span', { className: 'ah-inline-agent' }, h(Avatar, { id: w.agent, name: agentName(s, w.agent), size: 24 }), h('span', null, agentName(s, w.agent)))),
              h('td', null, w.schedule ? h('span', { className: 'ah-mono' }, w.schedule) : 'None'),
              h('td', null, h('time', { title: absTime(w.last_run_at) }, relTime(w.last_run_at, s.now))),
              h('td', null, w.next_run_at ? h('time', { title: absTime(w.next_run_at) }, relTime(w.next_run_at, s.now)) : 'None'),
              h('td', null, h(StatusChip, { status: w.status }))
            )
          )
        )
      )
    )
  )
}

/* ───────────────────────── tasks ───────────────────────── */

// Who has to act on a blocked card: the owner, the agent that created it, or nobody yet (parents / retry).
function waitingLabel(s, w) {
  return w === 'owner' ? 'you (owner)' : w === 'parents' ? 'earlier tasks' : w === 'retry' ? 'automatic retry' : agentName(s, w)
}

function TaskBlock({ s, t }) {
  return h(
    'div',
    { className: cx('ah-task-block', t.waiting_on === 'owner' && 'is-owner') },
    h('span', { className: 'ah-task-block-head' }, h(Icon, { name: 'warning', size: 12 }), ` Waiting on ${waitingLabel(s, t.waiting_on)}`, t.blocked_at ? ` · ${relTime(t.blocked_at, s.now)}` : ''),
    t.block_reason ? h('span', { className: 'ah-task-block-why', title: t.block_reason }, t.block_reason) : null
  )
}

function TaskNote({ s, c }) {
  return h('p', { className: 'ah-task-note', title: c.text }, h('b', null, `${agentName(s, c.author)}: `), c.text, c.at ? h('time', { className: 'ah-side-time' }, ` · ${relTime(c.at, s.now)}`) : null)
}

function Tasks({ s, v }) {
  const items = v.tasks

  if (s.tasks.status === 'error' && items.length === 0 && !s.tasks.data) {
    return h(ErrorState, { message: 'Could not load tasks', detail: s.tasks.error, onRetry: () => void load() })
  }

  if (s.tasks.status !== 'ready' && !s.tasks.data) {
    return h(Skeleton, { rows: 8, className: 'ah-pad' })
  }

  const known = new Set(TASK_COLUMNS.map(c => c.id))
  const other = items.filter(t => !known.has(t.status))
  const columns = [...TASK_COLUMNS, ...(other.length ? [{ id: '__other', label: 'Other' }] : [])]

  if (items.length === 0) {
    return h(
      'div',
      { className: 'ah-pad' },
      h(EmptyState, {
        icon: 'checklist',
        title: s.ui.agent || s.ui.q ? 'No task matches the filter' : 'No tasks yet',
        hint: s.ui.agent || s.ui.q ? 'Clear the agent filter or change the search.' : 'Create tasks on the Kanban board; new ones show up here within 15 seconds.'
      })
    )
  }

  return h(
    'div',
    { className: 'ah-board', role: 'list', 'aria-label': 'Task board by status' },
    columns.map(col => {
      const cards = col.id === '__other' ? other : items.filter(t => t.status === col.id)

      return h(
        'section',
        { key: col.id, className: 'ah-col', role: 'listitem', 'aria-label': `${col.label}, ${cards.length} task` },
        h('header', { className: 'ah-col-head' }, h('h3', { className: 'ah-col-title' }, col.label), h('span', { className: 'ah-tab-count' }, String(cards.length))),
        h(
          'div',
          { className: 'ah-col-body' },
          cards.length === 0
            ? h('p', { className: 'ah-col-empty' }, 'No tasks')
            : cards.map(t =>
                h(
                  'article',
                  { key: t.id, className: 'ah-task' },
                  h('h4', { className: 'ah-task-title' }, t.title),
                  h(
                    'div',
                    { className: 'ah-task-chips' },
                    t.priority !== null && t.priority !== undefined && t.priority !== '' ? h(Chip, { tone: 'flat', icon: 'flag' }, `Priority ${t.priority}`) : null,
                    t.branch_name ? h(Chip, { tone: 'flat', icon: 'git-branch', title: t.workspace_path || undefined }, t.branch_name) : null,
                    num(t.comments) > 0 ? h(Chip, { tone: 'flat', icon: 'comment' }, `${t.comments} comments`) : null
                  ),
                  t.status === 'blocked' ? h(TaskBlock, { s, t }) : null,
                  t.status === 'running' && t.progress ? h('p', { className: 'ah-task-note is-progress', title: t.progress.text }, h(Icon, { name: 'pulse', size: 12 }), ` ${t.progress.text}`) : null,
                  t.last_comment ? h(TaskNote, { s, c: t.last_comment }) : null,
                  h(
                    'footer',
                    { className: 'ah-task-foot' },
                    t.assignee ? h('span', { className: 'ah-inline-agent' }, h(Avatar, { id: t.assignee, name: agentName(s, t.assignee), size: 24 }), h('span', null, agentName(s, t.assignee))) : h('span', { className: 'ah-row-sub' }, 'Unassigned'),
                    h('time', { className: 'ah-row-sub', title: absTime(t.updated_at || t.created_at) }, t.status === 'running' && t.updated_at ? `updated ${relTime(t.updated_at, s.now)}` : relTime(t.completed_at || t.started_at || t.created_at, s.now))
                  )
                )
              )
        )
      )
    })
  )
}

/* ───────────────────────── changes + diff viewer ───────────────────────── */

function FileBadge({ status }) {
  if (status === 'hidden') {
    return h('span', { className: 'ah-file-badge is-hidden', title: 'Hidden for security' }, h(Icon, { name: 'lock', size: 14 }), h('span', { className: 'ah-sr' }, 'Hidden for security'))
  }

  const st = FILE_STATUS[status] || { label: status || 'Unknown', tone: 'neutral' }

  return h('span', { className: cx('ah-file-badge', `is-${st.tone}`), title: st.label }, h('span', { 'aria-hidden': 'true' }, status || '?'), h('span', { className: 'ah-sr' }, st.label))
}

function Delta({ a, d }) {
  return h('span', { className: 'ah-delta' }, h('span', { className: 'ah-add-n' }, `+${num(a)}`), h('span', { className: 'ah-del-n' }, `\u2212${num(d)}`))
}

function parseDiff(text) {
  const out = []
  let o = 0
  let n = 0
  let inHunk = false
  const lines = String(text || '').split('\n')

  if (lines.length && lines[lines.length - 1] === '') {
    lines.pop()
  }

  for (const raw of lines) {
    if (raw.startsWith('diff --git')) {
      inHunk = false
      out.push({ t: 'meta', text: raw })
    } else if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(raw)

      o = m ? Number(m[1]) : 0
      n = m ? Number(m[2]) : 0
      inHunk = true
      out.push({ t: 'hunk', text: raw })
    } else if (!inHunk) {
      out.push({ t: 'meta', text: raw })
    } else if (raw.startsWith('+')) {
      out.push({ t: 'add', n, text: raw.slice(1) })
      n += 1
    } else if (raw.startsWith('-')) {
      out.push({ t: 'del', o, text: raw.slice(1) })
      o += 1
    } else if (raw.startsWith('\\')) {
      out.push({ t: 'note', text: raw })
    } else {
      out.push({ t: 'ctx', o, n, text: raw.startsWith(' ') ? raw.slice(1) : raw })
      o += 1
      n += 1
    }
  }

  return out
}

const MAX_DIFF_LINES = 3000

function DiffViewer({ s, repo, file }) {
  const key = diffKey(repo.id, file.path)
  const entry = s.diff[key]
  const lines = useMemo(() => (entry && entry.data ? parseDiff(entry.data.diff) : []), [entry && entry.data])
  const wrap = !!s.ui.wrap

  const head = h(
    'header',
    { className: 'ah-diff-head' },
    h(FileBadge, { status: file.status }),
    h('span', { className: 'ah-diff-path ah-mono', title: file.path }, file.path),
    h('span', { className: 'ah-spacer' }),
    h(Delta, { a: file.additions, d: file.deletions }),
    h(
      'button',
      { type: 'button', className: cx('ah-btn ah-btn-outlined ah-state', wrap && 'is-on'), 'aria-pressed': wrap ? 'true' : 'false', onClick: () => setUi({ wrap: !wrap }) },
      h(Icon, { name: 'word-wrap', size: 16 }),
      h('span', null, 'Wrap lines')
    )
  )

  let body

  if (!entry || (entry.status === 'loading' && !entry.data)) {
    body = h(Skeleton, { rows: 9, className: 'ah-inset' })
  } else if (entry.status === 'error' && !entry.data) {
    body = h(ErrorState, { message: 'Could not load the diff', detail: entry.error, onRetry: () => void fetchDiff(repo.id, file.path), compactMode: true })
  } else if (lines.length === 0) {
    body = h(EmptyState, { icon: 'diff', title: 'This file has no changes to show', hint: 'Binary files and permission-only changes have no text diff.' })
  } else {
    const shown = lines.slice(0, MAX_DIFF_LINES)

    body = h(
      'div',
      { className: cx('ah-diff', wrap && 'is-wrap'), role: 'region', 'aria-label': `Diff of ${file.path}`, tabIndex: 0 },
      h(
        'div',
        { className: 'ah-diff-body' },
        shown.map((ln, i) => {
          if (ln.t === 'hunk') {
            return h('div', { key: i, className: 'ah-dl is-hunk' }, h('span', { className: 'ah-dl-code' }, ln.text))
          }

          if (ln.t === 'meta' || ln.t === 'note') {
            return h('div', { key: i, className: 'ah-dl is-meta' }, h('span', { className: 'ah-dl-code' }, ln.text))
          }

          const sign = ln.t === 'add' ? '+' : ln.t === 'del' ? '\u2212' : ' '

          return h(
            'div',
            { key: i, className: cx('ah-dl', `is-${ln.t}`) },
            h('span', { className: 'ah-dl-no', 'aria-hidden': 'true' }, ln.o ?? ''),
            h('span', { className: 'ah-dl-no', 'aria-hidden': 'true' }, ln.n ?? ''),
            h('span', { className: 'ah-dl-sign', 'aria-hidden': 'true' }, sign),
            h('span', { className: 'ah-dl-code' }, ln.text === '' ? '\u00a0' : ln.text)
          )
        })
      ),
      lines.length > MAX_DIFF_LINES ? h('p', { className: 'ah-diff-note' }, `Showing the first ${MAX_DIFF_LINES} of ${lines.length} lines.`) : null,
      entry.data && entry.data.truncated ? h('p', { className: 'ah-diff-note' }, 'The diff was too large and was truncated by the backend.') : null
    )
  }

  return h('div', { className: 'ah-diff-wrap' }, head, body)
}

function fileGroups(files) {
  const groups = new Map()

  for (const f of files) {
    const d = dirOf(f.path)

    if (!groups.has(d)) {
      groups.set(d, [])
    }

    groups.get(d).push(f)
  }

  return Array.from(groups.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dir, items]) => ({ dir, items: items.sort((a, b) => baseOf(a.path).localeCompare(baseOf(b.path))) }))
}

function Changes({ s, v }) {
  const repos = v.repos

  if (s.changes.status === 'error' && repos.length === 0) {
    return h(ErrorState, { message: 'Could not load changes', detail: s.changes.error, onRetry: () => void load() })
  }

  if (s.changes.status !== 'ready' && !s.changes.data) {
    return h(Skeleton, { rows: 8, className: 'ah-inset' })
  }

  if (repos.length === 0) {
    return h(
      'div',
      { className: 'ah-inset' },
      h(EmptyState, { icon: 'repo', title: 'No repositories tracked yet', hint: 'Add paths to agents-hub.json in the Hermes folder, or open a project, to list repositories here.' })
    )
  }

  return h(ChangesView, { s, repos })
}

function ChangesView({ s, repos }) {
  const repo = repos.find(r => r.id === s.ui.repo) || repos.find(r => (r.files || []).length > 0) || repos[0]
  const files = (repo.files || []).filter(f => matches(s.ui.q, f.path))
  const groups = fileGroups(files)
  const file = (repo.files || []).find(f => f.path === s.ui.file && f.status !== 'hidden')

  useEffect(() => {
    if (file && !S.diff[diffKey(repo.id, file.path)]) {
      void fetchDiff(repo.id, file.path)
    }
  }, [repo.id, file && file.path])

  return h(
    'div',
    { className: 'ah-split is-changes' },
    h(
      'div',
      { className: 'ah-master' },
      h(
        'div',
        { className: 'ah-repo-head' },
        h('label', { className: 'ah-field-label', htmlFor: 'ah-repo-select' }, 'Repositories'),
        h(
          'select',
          { id: 'ah-repo-select', className: 'ah-select', value: repo.id, onChange: e => setUi({ repo: e.target.value, file: null }) },
          repos.map(r => h('option', { key: r.id, value: r.id }, r.label || r.path))
        ),
        h(
          'div',
          { className: 'ah-repo-meta' },
          repo.branch ? h(Chip, { tone: 'flat', icon: 'git-branch' }, repo.branch) : null,
          num(repo.ahead) > 0 ? h(Chip, { tone: 'flat', icon: 'arrow-up', title: 'Unpushed commits' }, String(repo.ahead)) : null,
          num(repo.behind) > 0 ? h(Chip, { tone: 'flat', icon: 'arrow-down', title: 'Commits to pull' }, String(repo.behind)) : null,
          h(Chip, { tone: repo.clean ? 'ok' : 'warn', icon: repo.clean ? 'check' : 'circle-filled' }, repo.clean ? 'Clean' : `${(repo.files || []).length} changed files`)
        ),
        s.ui.agent ? h('p', { className: 'ah-repo-note' }, 'Changes by repository, not filtered by agent.') : null
      ),
      groups.length === 0
        ? h(EmptyState, { icon: 'check', title: s.ui.q ? 'No file matches' : 'This repository has no changes', hint: s.ui.q ? 'Change or clear the search.' : 'Every file matches the latest commit.' })
        : h(
            'div',
            { className: 'ah-files', onKeyDown: navKeys },
            groups.map(g =>
              h(
                'div',
                { key: g.dir || '.', className: 'ah-file-group' },
                h('div', { className: 'ah-file-dir ah-mono' }, g.dir ? `${g.dir}/` : '(root)'),
                g.items.map(f => {
                  if (f.status === 'hidden') {
                    return h(
                      'div',
                      { key: f.path, className: 'ah-file is-locked' },
                      h(FileBadge, { status: 'hidden' }),
                      h('span', { className: 'ah-file-name ah-mono' }, baseOf(f.path)),
                      h('span', { className: 'ah-file-lock' }, 'Hidden for security')
                    )
                  }

                  const on = file && file.path === f.path

                  return h(
                    'button',
                    {
                      key: f.path,
                      type: 'button',
                      'data-nav': '',
                      className: cx('ah-file ah-state', on && 'is-selected'),
                      'aria-current': on ? 'true' : undefined,
                      onClick: () => setUi({ repo: repo.id, file: f.path })
                    },
                    h(FileBadge, { status: f.status }),
                    h('span', { className: 'ah-file-name ah-mono', title: f.path }, baseOf(f.path)),
                    h(Delta, { a: f.additions, d: f.deletions })
                  )
                })
              )
            )
          )
    ),
    h('section', { className: 'ah-detail', 'aria-label': 'Diff' }, file ? h(DiffViewer, { s, repo, file }) : h(EmptyState, { icon: 'diff', title: 'Pick a file to see its changes', hint: 'Diffs are against the latest commit. Files hidden for security show no content.' }))
  )
}

/* ───────────────────────── page ───────────────────────── */

function HubPage() {
  const s = useHub()
  const v = useViews(s)

  useEffect(() => {
    void load()
    void fetchCommands()
    // Refresh only while the Hub is on screen; a hidden window keeps the gateway quiet.
    const stop = C
      ? C.setInterval(() => {
          if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
            void load()
          }
        }, POLL_MS)
      : null
    // Running commands of every agent: one shared, cheap poll (rail badges + the right bar).
    const stopCmds = C
      ? C.setInterval(() => {
          if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
            void fetchCommands()
          }
        }, COMMANDS_POLL_MS)
      : null

    return () => {
      if (stop) {
        stop()
      }

      if (typeof stopCmds === 'function') {
        stopCmds()
      }
    }
  }, [])

  const backendOff = s.agents.status === 'error' && !s.agents.data
  const tab = effectiveTab(s.ui)

  let body

  if (backendOff) {
    const pb = backendProblem(s.agents.error)
    body = h(
      'div',
      { className: 'ah-pad' },
      h(ErrorState, { message: pb.title, detail: `${pb.hint}\n\nDetails: ${s.agents.error || 'unknown error'}`, onRetry: () => void load() })
    )
  } else if (tab === 'chat') {
    body = h(ChatView, { key: s.ui.agent, s })
  } else if (tab === 'overview') {
    body = h(Overview, { s, v })
  } else if (tab === 'conversations') {
    body = h(Conversations, { s, v })
  } else if (tab === 'works') {
    body = h(Works, { s, v })
  } else if (tab === 'tasks') {
    body = h(Tasks, { s, v })
  } else if (tab === 'config') {
    body = h(ConfigTab, { s })
  } else {
    body = h(Changes, { s, v })
  }

  const stale = backendStale(s)
  const split = !backendOff && (tab === 'conversations' || tab === 'changes')
  const board = !backendOff && tab === 'tasks'
  const chat = !backendOff && tab === 'chat'

  return h(
    'div',
    { className: 'ah-root', 'data-ah-state': backendOff ? 'error' : 'ready' },
    h(AppBar, { s }),
    h(
      'div',
      { className: 'ah-main' },
      h(Rail, { s }),
      h(
        'div',
        { className: 'ah-content' },
        h(Tabs, { s }),
        stale && !backendOff
          ? h(
              'div',
              { className: 'ah-banner is-warn', role: 'status' },
              h(Icon, { name: 'warning', size: 16 }),
              h('span', null, `${stale} Restart the gateway to finish the update (Ctrl+K, "Restart gateway").`)
            )
          : null,
        h('div', { key: tab, role: 'tabpanel', id: `ah-panel-${tab}`, 'aria-labelledby': `ah-tab-${tab}`, className: cx('ah-panel', (split || chat) && 'is-split', board && 'is-board', chat && 'is-chat'), tabIndex: -1 }, body)
      )
    )
  )
}

/* ───────────────────────── accounts, usage, team (Settings tab) ───────────────────────── */

// Usage is cached by the gateway for 10 minutes; the bar asks every 5 and never blanks: the last
// good numbers stay on screen while a refresh runs or if one fails.
const USAGE_POLL_MS = 60 * 1000  // the server caches 2 min, so this is cheap; numbers lag at most ~3 min
const USAGE_RETRY_MS = 6000
const LOGIN_POLL_MS = 3000
const HUB_PROVIDER_IDS = ['openai-codex', 'anthropic']

function avatarSeed(id) {
  const a = list('agents', 'agents').find(x => x.id === id)

  return (a && a.avatar) || id || ''
}

function fmtClock(sec) {
  if (!sec) {
    return '—'
  }

  const d = new Date(sec * 1000)
  const same = new Date().toDateString() === d.toDateString()
  const hm = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

  return same ? hm : `${hm} ${d.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: '2-digit' })}`
}

function untilText(sec, now) {
  if (!sec) {
    return ''
  }

  const left = sec - (now || Date.now()) / 1000

  if (left <= 0) {
    return 'due now'
  }

  const d = Math.floor(left / 86400)
  const hh = Math.floor((left % 86400) / 3600)
  const mm = Math.max(1, Math.floor((left % 3600) / 60))

  return d ? `${d} days ${hh} hr` : hh ? `${hh} hr ${mm} min` : `${mm} min`
}

const WINDOW_SHORT = { session: '5h', 'current session': '5h', weekly: 'wk', 'current week': 'wk', week: 'wk' }

function windowShort(label) {
  const k = String(label || '').toLowerCase()

  if (WINDOW_SHORT[k]) {
    return WINDOW_SHORT[k]
  }

  if (/week/.test(k)) {
    return /opus/.test(k) ? 'wk·Opus' : /sonnet/.test(k) ? 'wk·Sonnet' : 'wk'
  }

  return /session|5h|hour/.test(k) ? '5h' : String(label || '')
}

function windowLong(label) {
  const k = String(label || '').toLowerCase()

  if (/session|5h/.test(k)) {
    return '5-hour session'
  }

  if (/week/.test(k)) {
    return /opus/.test(k) ? 'Weekly (Opus)' : /sonnet/.test(k) ? 'Weekly (Sonnet)' : 'Weekly'
  }

  return String(label || '')
}

// Compact time left until a reset: "2h05m", "45m", "<1m"; null when unknown.
function untilShort(sec, now) {
  if (!sec) {
    return null
  }

  const left = Math.floor(sec - (now || Date.now()) / 1000)

  if (left <= 0) {
    return 'resetting'
  }

  if (left < 60) {
    return '<1m'
  }

  const d = Math.floor(left / 86400)
  const hh = Math.floor((left % 86400) / 3600)
  const mm = Math.floor((left % 3600) / 60)

  return d ? `${d}d${hh ? `${hh}h` : ''}` : hh ? `${hh}h${String(mm).padStart(2, '0')}m` : `${mm}m`
}

const isSessionWindow = label => windowShort(label) === '5h'
const windowsPassed = (p, now) => ((p && p.usage && p.usage.windows) || []).some(w => w.reset_at && w.reset_at * 1000 <= now)

const usageTone = pct => (pct >= 90 ? 'err' : pct >= 70 ? 'warn' : 'ok')

async function fetchUsage(agent, wait = 0) {
  if (!C || !agent) {
    return
  }

  const prev = S.usage[agent]

  try {
    const data = await C.rest(`/usage?agent=${enc(agent)}&wait=${wait}`)

    S.usage = { ...S.usage, [agent]: res('ready', data) }
  } catch (err) {
    S.usage = { ...S.usage, [agent]: res('error', prev ? prev.data : null, errText(err)) }
  }

  emit()
}

function UsageBar({ s, agent }) {
  const u = s.usage[agent]
  const rows = (u && u.data && u.data.providers) || []
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!C) {
      return undefined
    }

    let stop = false
    let timer = null
    const tick = async (wait = 0) => {
      await fetchUsage(agent, wait)

      if (stop) {
        return
      }

      const cur = S.usage[agent]
      const busy = cur && cur.data && (cur.data.providers || []).some(p => p.loading)

      // still loading: ask again soon; failed (offline / older gateway): back off to a minute
      timer = setTimeout(() => void tick(0), busy ? USAGE_RETRY_MS : !cur || cur.status === 'error' ? 60000 : USAGE_POLL_MS)
      setNow(Date.now())
    }

    void tick(8)

    // countdowns tick every 30s; a window whose reset time has passed is re-fetched right away
    const clock = setInterval(() => {
      const t = Date.now()

      setNow(t)

      const cur = S.usage[agent]

      if (cur && cur.data && (cur.data.providers || []).some(p => windowsPassed(p, t)) && !stop) {
        clearTimeout(timer)
        timer = setTimeout(() => void tick(8), 1500)
      }
    }, 30000)

    return () => {
      stop = true
      clearTimeout(timer)
      clearInterval(clock)
    }
  }, [agent])

  if (!u) {
    return h('div', { className: 'ah-usage', 'aria-busy': 'true' }, h('span', { className: 'ah-usage-muted' }, h(Icon, { name: 'loading', size: 12, spinning: true }), ' Fetching usage…'))
  }

  if (!rows.length) {
    return u.status === 'error'
      ? h('div', { className: 'ah-usage' }, h('span', { className: 'ah-usage-muted', title: u.error || '' }, 'Usage unavailable, retrying.'))
      : null
  }

  return h(
    'div',
    { className: 'ah-usage', role: 'group', 'aria-label': 'Model account usage' },
    rows.map(p => h(UsageChip, { key: p.id, p, now })),
    u.status === 'error' ? h('span', { className: 'ah-usage-muted', title: u.error || '' }, h(Icon, { name: 'warning', size: 12 })) : null
  )
}

function UsageChip({ p, now }) {
  const st = p.status || {}
  const wins = (p.usage && p.usage.windows) || []
  const openConfig = () => setUi({ tab: 'config' })

  if (!st.logged_in) {
    if (p.loading) {
      return h('span', { className: 'ah-usage-chip is-muted' }, h('b', null, p.label), h(Icon, { name: 'loading', size: 12, spinning: true }))
    }

    return h('button', { type: 'button', className: 'ah-usage-chip is-muted ah-state', onClick: openConfig, title: 'Not logged in: open Settings' }, h('b', null, p.label), 'not logged in')
  }

  const main = wins.slice(0, 2)
  const worst = wins.reduce((m, w) => Math.max(m, Number(w.used_percent) || 0), 0)
  const stale = p.updated_at && now / 1000 - p.updated_at > 10 * 60

  return h(
    'span',
    { className: cx('ah-usage-chip', `is-${usageTone(worst)}`), tabIndex: 0, 'aria-label': `${p.label}: ${main.map(w => `${windowLong(w.label)} ${Math.round(w.used_percent)}%`).join(', ')}` },
    h('b', null, p.label),
    main.length
      ? main.map((w, i) =>
          h(
            'span',
            { key: i, className: 'ah-usage-win' },
            h('span', { className: 'ah-usage-meter', 'aria-hidden': 'true' }, h('span', { className: `is-${usageTone(w.used_percent)}`, style: { width: `${Math.min(100, Math.max(2, w.used_percent))}%` } })),
            `${Math.round(w.used_percent)}%`,
            // session window: time left until it resets (the default view); other windows keep their short name
            isSessionWindow(w.label) && w.reset_at
              ? h('small', { className: 'ah-usage-left', title: `Session resets ${fmtClock(w.reset_at)}` }, h(Icon, { name: 'history', size: 11 }), untilShort(w.reset_at, now))
              : h('small', null, windowShort(w.label))
          )
        )
      : h('small', null, p.loading ? '…' : (p.usage && p.usage.unavailable) || 'no data'),
    stale || p.error ? h(Icon, { name: 'warning', size: 12, className: 'ah-usage-stale' }) : null,
    h(UsagePop, { p, now })
  )
}

function UsagePop({ p, now }) {
  const st = p.status || {}
  const us = p.usage || {}
  const line = (k, v) => h('div', { className: 'ah-usage-line' }, h('span', null, k), h('span', null, v))

  return h(
    'span',
    { className: 'ah-usage-pop', role: 'tooltip' },
    h('strong', null, `${p.label}${us.plan ? ` · ${us.plan}` : ''}`),
    (us.windows || []).map((w, i) =>
      h(
        'div',
        { key: i, className: 'ah-usage-wrow' },
        h('div', { className: 'ah-usage-line' }, h('span', null, windowLong(w.label)), h('b', null, `${Math.round(w.used_percent)}% used`)),
        h('span', { className: 'ah-usage-meter is-wide' }, h('span', { className: `is-${usageTone(w.used_percent)}`, style: { width: `${Math.min(100, Math.max(2, w.used_percent))}%` } })),
        w.reset_at ? h('small', { className: 'ah-usage-reset' }, h('b', null, `Resets ${fmtClock(w.reset_at)}`), ` · in ${untilText(w.reset_at, now)}`) : null,
        w.detail ? h('small', null, w.detail) : null
      )
    ),
    (us.details || []).map((d, i) => h('small', { key: `d${i}` }, d)),
    h('hr'),
    h('small', { className: 'ah-usage-sub' }, 'Login (not usage limits)'),
    line('Signed in via', st.via === 'claude-code' ? 'Claude Code' : st.source_label || st.source || '—'),
    // Claude's OAuth token rotates every few hours and says nothing about usage limits; only Codex shows it.
    st.expires_at_s && p.id !== 'anthropic' ? line(st.has_refresh_token ? 'Login token renews' : 'Login token expires', `${fmtClock(st.expires_at_s)} (in ${untilText(st.expires_at_s, now)})`) : null,
    line('Token auto-refresh', st.has_refresh_token ? 'Yes' : st.source && /pool|chatgpt|codex/.test(String(st.source)) ? 'Managed by Hermes' : 'No'),
    st.last_refresh_s ? line('Last refreshed', relTime(st.last_refresh_s, now)) : null,
    line('Usage updated', p.updated_at ? relTime(p.updated_at, now) : '—'),
    p.error ? h('small', { className: 'ah-usage-err' }, p.error) : null
  )
}

/* ── accounts (login + status) ── */

async function fetchProviders(agent) {
  try {
    const data = await C.rest(`/providers?agent=${enc(agent)}`)

    S.providers = { ...S.providers, [agent]: res('ready', data) }
  } catch (err) {
    const prev = S.providers[agent]

    S.providers = { ...S.providers, [agent]: res('error', prev ? prev.data : null, errText(err)) }
  }

  emit()
}

async function fetchTeam() {
  try {
    const data = await C.rest('/team')

    S.team = res('ready', data)
  } catch (err) {
    S.team = res('error', S.team ? S.team.data : null, errText(err))
  }

  emit()
}

// The Desktop denies window.open / target=_blank from plugin pages, so links go through the OS bridge.
// Only http(s) leaves the app; false means the caller shows the link to copy by hand.
async function openUrl(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) {
    return false
  }

  const bridges = [C && C.os, typeof window !== 'undefined' ? window.hermesDesktop : null]

  for (const b of bridges) {
    if (b && typeof b.openExternal === 'function') {
      try {
        const ok = await b.openExternal(url)

        if (ok !== false) {
          return true
        }
      } catch {
        /* try the next bridge */
      }
    }
  }

  return false
}

async function copyText(text) {
  try {
    if (C && C.os && typeof C.os.writeClipboard === 'function' && (await C.os.writeClipboard(text))) {
      return true
    }
  } catch {
    /* fall back to the web clipboard */
  }

  try {
    await navigator.clipboard.writeText(text)

    return true
  } catch {
    return false
  }
}

function LoginPanel({ agent, provider, onDone }) {
  const [sess, setSess] = useState(null)
  const [err, setErr] = useState(null)
  const [linkNote, setLinkNote] = useState(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let off = false

    C.rest(`/providers/${enc(provider)}/login?agent=${enc(agent)}`, { method: 'POST', body: {} })
      .then(d => !off && setSess(d))
      .catch(e => !off && setErr(errText(e)))

    return () => {
      off = true
    }
  }, [agent, provider])

  useEffect(() => {
    if (!sess || sess.status !== 'pending') {
      return undefined
    }

    const stop = C.setInterval(async () => {
      try {
        const d = await C.rest(`/providers/login/${enc(sess.id)}`)

        setSess(d)

        if (d.status === 'approved') {
          onDone(true)
        }
      } catch (e) {
        setErr(errText(e))
      }
    }, LOGIN_POLL_MS)

    return stop
  }, [sess && sess.id, sess && sess.status])

  const cancel = () => {
    if (sess && sess.status === 'pending') {
      void C.rest(`/providers/login/${enc(sess.id)}`, { method: 'DELETE' }).catch(() => {})
    }

    onDone(false)
  }

  const sendCode = async e => {
    e.preventDefault()

    if (!code.trim()) {
      return
    }

    setBusy(true)

    try {
      setSess(await C.rest(`/providers/login/${enc(sess.id)}/code`, { method: 'POST', body: { code: code.trim() } }))
      setCode('')
    } catch (e2) {
      setErr(errText(e2))
    }

    setBusy(false)
  }

  const link = sess && (sess.verification_url || sess.url)

  return h(
    'div',
    { className: 'ah-login' },
    !sess && !err ? h('p', { className: 'ah-row-sub' }, h(Icon, { name: 'loading', size: 12, spinning: true }), ' Starting Hermes’s login flow…') : null,
    sess && sess.user_code
      ? h(
          'div',
          { className: 'ah-login-step' },
          h('span', null, '1. Open the verification page and enter the code:'),
          h('code', { className: 'ah-login-code' }, sess.user_code),
          h('button', { type: 'button', className: 'ah-btn ah-btn-text ah-btn-sm ah-state', onClick: async () => setLinkNote((await copyText(sess.user_code)) ? 'Code copied.' : null) }, h(Icon, { name: 'copy', size: 14 }), ' Copy code')
        )
      : null,
    link
      ? h(
          'div',
          { className: 'ah-login-step' },
          h(
            'button',
            {
              type: 'button',
              className: 'ah-btn ah-btn-tonal ah-btn-sm ah-state',
              onClick: async () => {
                const ok = await openUrl(link)

                setLinkNote(ok ? 'Opened in your browser.' : 'Could not open the browser: copy the link below and open it yourself.')
              }
            },
            h(Icon, { name: 'link-external', size: 14 }),
            sess.user_code ? ' Open verification page' : ' Open authorize page'
          ),
          h('button', { type: 'button', className: 'ah-btn ah-btn-text ah-btn-sm ah-state', onClick: async () => setLinkNote((await copyText(link)) ? 'Link copied.' : 'Select the link below and copy it.') }, h(Icon, { name: 'copy', size: 14 }), ' Copy link'),
          h('code', { className: 'ah-login-link ah-mono', title: link }, link),
          linkNote ? h('span', { className: 'ah-row-sub' }, linkNote) : null
        )
      : null,
    sess && sess.kind === 'cli' && sess.status === 'pending'
      ? h(
          'form',
          { className: 'ah-login-step', onSubmit: sendCode },
          h('span', null, sess.needs_code ? '2. After authorizing, paste the code (code#state) here:' : 'Waiting for Hermes to confirm the code…'),
          sess.needs_code ? h('input', { className: 'ah-input ah-mono', type: 'password', autoComplete: 'off', value: code, placeholder: 'Authorization code', onChange: e => setCode(e.target.value) }) : null,
          sess.needs_code ? h('button', { type: 'submit', className: 'ah-btn ah-btn-tonal ah-btn-sm ah-state', disabled: busy || !code.trim() }, 'Confirm') : null
        )
      : null,
    sess && sess.status === 'pending' && sess.kind !== 'cli' ? h('p', { className: 'ah-row-sub' }, h(Icon, { name: 'loading', size: 12, spinning: true }), ' Waiting for confirmation in the browser…') : null,
    sess && sess.status === 'approved' ? h('p', { className: 'ah-row-sub' }, h(Icon, { name: 'pass', size: 12 }), ' Logged in.') : null,
    sess && ['error', 'expired', 'denied'].includes(sess.status) ? h('p', { className: 'ah-live-error', role: 'alert' }, sess.error || `Login failed (${sess.status}).`) : null,
    sess && sess.log && sess.log.length && sess.status !== 'approved' ? h('details', { className: 'ah-login-log' }, h('summary', null, 'Command log'), h('pre', null, sess.log.join('\n'))) : null,
    err ? h('p', { className: 'ah-live-error', role: 'alert' }, err) : null,
    h('div', { className: 'ah-edit-actions' }, h('span', { className: 'ah-spacer' }), h('button', { type: 'button', className: 'ah-btn ah-btn-text ah-btn-sm ah-state', onClick: cancel }, sess && sess.status === 'approved' ? 'Close' : 'Cancel'))
  )
}

function ProviderRow({ agent, p, usage, now }) {
  const [login, setLogin] = useState(false)
  const st = p.status || {}
  const viaCC = usage && usage.status && usage.status.via === 'claude-code'
  const ok = st.logged_in || viaCC
  const shown = viaCC && !st.logged_in ? usage.status : st
  const canLogin = p.id === 'openai-codex' || p.id === 'anthropic' || p.flow === 'device_code'
  const done = changed => {
    setLogin(false)

    if (changed) {
      void fetchProviders(agent)
      void fetchUsage(agent, 8)
    }
  }

  return h(
    'div',
    { className: 'ah-acct' },
    h(
      'div',
      { className: 'ah-acct-head' },
      h('span', { className: cx('ah-acct-dot', ok ? 'is-ok' : 'is-off') }),
      h('div', { className: 'ah-acct-main' }, h('b', null, p.label || p.name), h('span', { className: 'ah-row-sub' }, ok ? `Logged in · ${viaCC && !st.logged_in ? 'via Claude Code' : shown.source_label || shown.source || ''}` : 'Not logged in')),
      ok && shown.expires_at_s ? h('span', { className: 'ah-row-sub', title: fmtClock(shown.expires_at_s) }, `Token valid for ${untilText(shown.expires_at_s, now)}${shown.has_refresh_token ? ' · auto-refresh' : ''}`) : null,
      h('span', { className: 'ah-spacer' }),
      canLogin && !login ? h('button', { type: 'button', className: cx('ah-btn ah-btn-sm ah-state', ok ? 'ah-btn-text' : 'ah-btn-tonal'), onClick: () => setLogin(true) }, h(Icon, { name: 'key', size: 14 }), ok ? ' Log in again' : ' Log in') : null,
      !canLogin && p.cli_command ? h('code', { className: 'ah-row-sub ah-mono' }, p.cli_command) : null
    ),
    login ? h(LoginPanel, { agent, provider: p.id, onDone: done }) : null
  )
}

function Accounts({ s, agent }) {
  const pv = s.providers[agent]
  const rows = (pv && pv.data && pv.data.providers) || []
  const usageRows = (s.usage[agent] && s.usage[agent].data && s.usage[agent].data.providers) || []
  const [more, setMore] = useState(false)
  const now = Date.now()

  useEffect(() => {
    void fetchProviders(agent)

    if (!s.usage[agent]) {
      void fetchUsage(agent, 8)
    }
  }, [agent])

  const main = rows.filter(r => HUB_PROVIDER_IDS.includes(r.id))
  const other = rows.filter(r => !HUB_PROVIDER_IDS.includes(r.id) && r.id !== 'claude-code')

  return h(
    SectionCard,
    { title: 'Model accounts', icon: 'account' },
    h(
      'div',
      { className: 'ah-acct-list' },
      !pv ? h('p', { className: 'ah-row-sub' }, h(Icon, { name: 'loading', size: 12, spinning: true }), ' Checking logins…') : null,
      pv && pv.status === 'error' && !rows.length ? h(ErrorState, { message: 'Could not read login status.', detail: pv.error, onRetry: () => void fetchProviders(agent) }) : null,
      main.map(p => h(ProviderRow, { key: p.id, agent, p, usage: usageRows.find(u => u.id === p.id), now })),
      other.length
        ? h(
            'details',
            { className: 'ah-acct-more', open: more, onToggle: e => setMore(e.target.open) },
            h('summary', null, `Other providers (${other.filter(p => p.status && p.status.logged_in).length}/${other.length} logged in)`),
            more ? other.map(p => h(ProviderRow, { key: p.id, agent, p, now })) : null
          )
        : null,
      h('p', { className: 'ah-field-hint' }, 'Logins use Hermes’s own flows (as in Settings > Accounts). Hermes stores the tokens; Agents Hub only reads status and usage.')
    )
  )
}

/* ── team roster ── */

function TeamEditor({ s }) {
  const t = s.team
  const rows = ((t && t.data && t.data.agents) || []).filter(a => a && !String(a.id || '').startsWith('.'))
  const [edit, setEdit] = useState(null)
  const [form, setForm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  useEffect(() => {
    void fetchTeam()
  }, [])

  const save = async (id, body) => {
    setBusy(true)

    try {
      await C.rest(`/team/${enc(id)}`, { method: 'PUT', body })
      setEdit(null)
      await fetchTeam()
      void load()
    } catch (err) {
      setMsg(errText(err))
    }

    setBusy(false)
  }

  const rerun = async () => {
    setBusy(true)

    try {
      await C.rest('/setup', { method: 'POST', body: {} })
      await fetchTeam()
      setMsg('Setup re-run: team roster and TEAM.md updated.')
    } catch (err) {
      setMsg(errText(err))
    }

    setBusy(false)
  }

  return h(
    SectionCard,
    { title: 'Team', icon: 'organization' },
    h(
      'div',
      { className: 'ah-team' },
      h(
        'div',
        { className: 'ah-works-bar' },
        h('span', { className: 'ah-row-sub' }, `${rows.length} members · agents read TEAM.md to coordinate`),
        h('span', { className: 'ah-spacer' }),
        h('button', { type: 'button', className: 'ah-btn ah-btn-text ah-btn-sm ah-state', disabled: busy, onClick: () => void rerun() }, h(Icon, { name: 'refresh', size: 14 }), ' Re-run setup'),
        form ? null : h('button', { type: 'button', className: 'ah-btn ah-btn-tonal ah-btn-sm ah-state', onClick: () => setForm(true) }, h(Icon, { name: 'person-add', size: 14 }), ' New agent')
      ),
      msg ? h('p', { className: 'ah-row-sub', role: 'status' }, msg) : null,
      form ? h(NewAgentForm, { rows, onClose: made => { setForm(false); if (made) { setMsg(`Created agent "${made}".`); void fetchTeam(); void load() } } }) : null,
      !t ? h('p', { className: 'ah-row-sub' }, h(Icon, { name: 'loading', size: 12, spinning: true }), ' Loading team…') : null,
      t && t.status === 'error' && !rows.length ? h(ErrorState, { message: 'Could not load the team (restart the gateway after updating the plugin).', detail: t.error, onRetry: () => void fetchTeam() }) : null,
      rows.map(r =>
        edit === r.id
          ? h(TeamRowEdit, { key: r.id, r, rows, busy, onSave: body => void save(r.id, body), onCancel: () => setEdit(null) })
          : h(
              'div',
              { key: r.id, className: 'ah-team-row' },
              h(Avatar, { id: r.id, name: r.name, size: 36 }),
              h('div', { className: 'ah-team-main' }, h('b', null, r.name || r.id, h('span', { className: 'ah-row-sub ah-mono' }, ` ${r.id}`)), h('span', { className: 'ah-row-sub' }, `${r.role || 'Agent'} · reports to ${agentLabel(rows, r.reports_to)}`), r.capabilities ? h('span', { className: 'ah-row-sub ah-team-cap' }, r.capabilities) : null),
              h('button', { type: 'button', className: 'ah-btn ah-btn-text ah-btn-sm ah-state', title: 'Generate a new random face', disabled: busy, onClick: () => void save(r.id, { avatar: 'random' }) }, h(Icon, { name: 'refresh', size: 14 }), ' New avatar'),
              h('button', { type: 'button', className: 'ah-btn ah-btn-text ah-btn-sm ah-state', disabled: busy, onClick: () => setEdit(r.id) }, h(Icon, { name: 'edit', size: 14 }), ' Edit')
            )
      ),
      t && t.data && t.data.skills && t.data.skills.length
        ? h('p', { className: 'ah-field-hint' }, 'Agents read the guides: ', t.data.skills.map((k, i) => h('code', { key: k.name, title: k.description }, `${i ? ', ' : ''}${k.name}`)))
        : null
    )
  )
}

function agentLabel(rows, id) {
  const r = rows.find(x => x.id === id)

  return r ? r.name || r.id : id || '—'
}

function TeamRowEdit({ r, rows, busy, onSave, onCancel }) {
  const [v, setV] = useState({ name: r.name || '', role: r.role || '', reports_to: r.reports_to || '', capabilities: r.capabilities || '' })
  const set = k => e => setV({ ...v, [k]: e.target.value })
  const field = (label, control) => h('label', { className: 'ah-field' }, h('span', { className: 'ah-field-label' }, label), control)

  return h(
    'form',
    { className: 'ah-team-edit', onSubmit: e => { e.preventDefault(); onSave(v) } },
    h('div', { className: 'ah-sched-grid' }, field('Display name', h('input', { className: 'ah-input', value: v.name, onChange: set('name') })), field('Role', h('input', { className: 'ah-input', value: v.role, onChange: set('role') }))),
    field('Reports to', h('select', { className: 'ah-input', value: v.reports_to, onChange: set('reports_to') }, h('option', { value: 'Owner' }, 'Owner'), rows.filter(x => x.id !== r.id).map(x => h('option', { key: x.id, value: x.id }, x.name || x.id)), v.reports_to && v.reports_to !== 'Owner' && !rows.some(x => x.id === v.reports_to) ? h('option', { value: v.reports_to }, v.reports_to) : null)),
    field('Duties / strengths (agents use this to pick who gets work)', h('textarea', { className: 'ah-input', rows: 3, value: v.capabilities, onChange: set('capabilities') })),
    h('div', { className: 'ah-edit-actions' }, h('span', { className: 'ah-spacer' }), h('button', { type: 'button', className: 'ah-btn ah-btn-text ah-btn-sm ah-state', onClick: onCancel }, 'Cancel'), h('button', { type: 'submit', className: 'ah-btn ah-btn-tonal ah-btn-sm ah-state', disabled: busy }, 'Save'))
  )
}

function NewAgentForm({ rows, onClose }) {
  const [v, setV] = useState({ id: '', name: '', role: '', capabilities: '', reports_to: 'default', clone_from: 'default' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [seed] = useState(() => Math.random().toString(16).slice(2, 10))
  const set = k => e => setV({ ...v, [k]: k === 'id' ? e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-') : e.target.value })
  const field = (label, control, hint) => h('label', { className: 'ah-field' }, h('span', { className: 'ah-field-label' }, label), control, hint ? h('span', { className: 'ah-field-hint' }, hint) : null)
  const submit = async e => {
    e.preventDefault()

    if (!v.id || !v.role.trim()) {
      setErr('Id and role are required.')

      return
    }

    setBusy(true)
    setErr(null)

    try {
      const made = await C.rest('/team', { method: 'POST', body: v })

      onClose(made.name || made.id)
    } catch (err2) {
      setErr(errText(err2))
      setBusy(false)
    }
  }

  return h(
    'form',
    { className: 'ah-sched-form', onSubmit: submit },
    h('div', { className: 'ah-team-new-head' }, h('span', { className: 'ah-avatar is-face mood-happy', style: { '--ah-ac': agentColor(seed), '--ah-size': '44px' } }, h(Face, { id: seed, seed, mood: 'happy' })), h('span', { className: 'ah-row-sub' }, 'The avatar is random; you can change it later.')),
    h('div', { className: 'ah-sched-grid' }, field('Id (profile name)', h('input', { className: 'ah-input ah-mono', value: v.id, placeholder: 'vd: qa-tester', onChange: set('id') })), field('Display name', h('input', { className: 'ah-input', value: v.name, placeholder: 'vd: QA Tester', onChange: set('name') }))),
    field('Role', h('input', { className: 'ah-input', value: v.role, placeholder: 'e.g. Quality assurance', onChange: set('role') })),
    field('Duties / strengths', h('textarea', { className: 'ah-input', rows: 3, value: v.capabilities, placeholder: 'What this agent does, is good at, and does not do', onChange: set('capabilities') }), 'Written to SOUL.md and TEAM.md so other agents know when to hand it work.'),
    h(
      'div',
      { className: 'ah-sched-grid' },
      field('Reports to', h('select', { className: 'ah-input', value: v.reports_to, onChange: set('reports_to') }, rows.map(x => h('option', { key: x.id, value: x.id }, x.name || x.id)))),
      field('Copy config from', h('select', { className: 'ah-input', value: v.clone_from, onChange: set('clone_from') }, rows.map(x => h('option', { key: x.id, value: x.id }, x.name || x.id))), 'Shares model and logins.')
    ),
    err ? h('p', { className: 'ah-live-error', role: 'alert' }, err) : null,
    h('div', { className: 'ah-edit-actions' }, h('span', { className: 'ah-spacer' }), h('button', { type: 'button', className: 'ah-btn ah-btn-text ah-btn-sm ah-state', disabled: busy, onClick: () => onClose(null) }, 'Cancel'), h('button', { type: 'submit', className: 'ah-btn ah-btn-tonal ah-btn-sm ah-state', disabled: busy }, busy ? h(Icon, { name: 'loading', size: 14, spinning: true }) : h(Icon, { name: 'person-add', size: 14 }), ' New agent'))
  )
}

function ConfigTab({ s }) {
  const agents = list('agents', 'agents')
  const [agent, setAgent] = useState(s.ui.agent || 'default')

  return h(
    'div',
    { className: 'ah-config' },
    h(
      'div',
      { className: 'ah-works-bar' },
      h('label', { className: 'ah-config-pick' }, h('span', { className: 'ah-field-label' }, 'Agent'), h('select', { className: 'ah-input', value: agent, onChange: e => setAgent(e.target.value) }, agents.map(a => h('option', { key: a.id, value: a.id }, a.name || a.id)))),
      h('span', { className: 'ah-spacer' }),
      h(UsageBar, { s, agent })
    ),
    h(Accounts, { key: agent, s, agent }),
    h(TeamEditor, { s })
  )
}

/* ───────────────────────── settings page ───────────────────────── */

function SettingsGeneral() {
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: 4, maxWidth: '64ch', lineHeight: 1.55 } },
    h('p', { style: { margin: 0, fontWeight: 500 } }, 'Opening Agents Hub'),
    h('p', { style: { margin: 0, opacity: 0.8 } }, 'Pick Agents Hub in the sidebar, use the command palette (Open Agents Hub) or press Ctrl+Alt+H. The plugin never switches pages on startup, so chats reopen where you left them.')
  )
}

/* ───────────────────────── theme: Hermes Material ───────────────────────── */

const SANS = '"Roboto Flex", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif'
const MONO = '"Cascadia Code", "JetBrains Mono", Consolas, monospace'

// M3 baseline tonal palette seeded from #4F5BD5.
const MATERIAL_LIGHT = {
  background: '#FBF8FF',
  foreground: '#1B1B21',
  card: '#F5F2FA',
  cardForeground: '#1B1B21',
  muted: '#E9E7F0',
  mutedForeground: '#46464F',
  popover: '#FFFFFF',
  popoverForeground: '#1B1B21',
  primary: '#4F5BD5',
  primaryForeground: '#FFFFFF',
  secondary: '#E0E0F9',
  secondaryForeground: '#1B1D36',
  accent: '#DEE0FF',
  accentForeground: '#0E1668',
  border: '#C7C5D0',
  input: '#9C9BA7',
  ring: '#4F5BD5',
  midground: '#4F5BD5',
  midgroundForeground: '#FFFFFF',
  composerRing: '#4F5BD5',
  destructive: '#BA1A1A',
  destructiveForeground: '#FFFFFF',
  sidebarBackground: '#F0EDF6',
  sidebarBorder: '#C7C5D0',
  userBubble: '#E0E0F9',
  userBubbleBorder: '#C5C7F0'
}

const MATERIAL_DARK = {
  background: '#121318',
  foreground: '#E4E1E9',
  card: '#1B1B21',
  cardForeground: '#E4E1E9',
  muted: '#2A292F',
  mutedForeground: '#C7C5D0',
  popover: '#1F1F25',
  popoverForeground: '#E4E1E9',
  primary: '#BCC2FF',
  primaryForeground: '#1A2380',
  secondary: '#444559',
  secondaryForeground: '#E0E0F9',
  accent: '#343EB7',
  accentForeground: '#DEE0FF',
  border: '#46464F',
  input: '#5F5E69',
  ring: '#BCC2FF',
  midground: '#BCC2FF',
  midgroundForeground: '#1A2380',
  composerRing: '#BCC2FF',
  destructive: '#FFB4AB',
  destructiveForeground: '#690005',
  sidebarBackground: '#1F1F25',
  sidebarBorder: '#46464F',
  userBubble: '#2C2E55',
  userBubbleBorder: '#43456F'
}

const MATERIAL_THEME = {
  name: 'hermes-material',
  label: 'Hermes Material',
  description: 'Material 3, indigo tones, layered surfaces',
  colors: MATERIAL_LIGHT,
  darkColors: MATERIAL_DARK,
  typography: { fontSans: SANS, fontMono: MONO }
}

/* ───────────────────────── styles ───────────────────────── */

const CSS = `
.ah-root{
  --ah-surface:var(--background);
  --ah-on-surface:var(--foreground);
  --ah-on-surface-variant:color-mix(in srgb,var(--foreground) 74%,var(--background));
  --ah-outline:color-mix(in srgb,var(--foreground) 46%,var(--background));
  --ah-outline-variant:color-mix(in srgb,var(--foreground) 15%,var(--background));
  --ah-surface-low:color-mix(in srgb,var(--ah-primary) 4%,var(--background));
  --ah-surface-container:color-mix(in srgb,var(--ah-primary) 7%,var(--background));
  --ah-surface-high:color-mix(in srgb,var(--ah-primary) 10%,var(--background));
  --ah-surface-highest:color-mix(in srgb,var(--ah-primary) 14%,var(--background));
  --ah-primary:var(--primary,var(--dt-primary,var(--theme-primary,#0053fd)));
  --ah-on-primary:var(--primary-foreground,var(--dt-primary-foreground,#ffffff));
  --ah-primary-container:color-mix(in srgb,var(--ah-primary) 20%,var(--background));
  --ah-on-primary-container:color-mix(in srgb,var(--ah-primary) 70%,var(--foreground));
  --ah-secondary-container:color-mix(in srgb,var(--ah-primary) 13%,var(--ah-surface-high));
  --ah-ok:#2e9e5b;
  --ah-warn:#c77700;
  --ah-err:var(--destructive,var(--dt-destructive,#ba1a1a));
  --ah-ok-c:color-mix(in srgb,var(--ah-ok) 17%,var(--background));
  --ah-on-ok:color-mix(in srgb,var(--ah-ok) 58%,var(--foreground));
  --ah-warn-c:color-mix(in srgb,var(--ah-warn) 17%,var(--background));
  --ah-on-warn:color-mix(in srgb,var(--ah-warn) 58%,var(--foreground));
  --ah-err-c:color-mix(in srgb,var(--ah-err) 15%,var(--background));
  --ah-on-err:color-mix(in srgb,var(--ah-err) 62%,var(--foreground));
  --ah-r-sm:8px;--ah-r-md:12px;--ah-r-lg:16px;--ah-r-xl:28px;
  --ah-mono:var(--font-mono,var(--dt-font-mono,ui-monospace,"Cascadia Code","JetBrains Mono",Consolas,monospace));
  container-type:inline-size;
  display:flex;flex-direction:column;height:100%;width:100%;min-height:0;min-width:0;overflow:hidden;position:relative;
  background:var(--ah-surface);color:var(--ah-on-surface);
  font-size:14px;line-height:20px;letter-spacing:.01em;
}
.ah-root *,.ah-root *::before,.ah-root *::after{box-sizing:border-box}
.ah-root *{scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--foreground) 28%,transparent) transparent}
.ah-root button,.ah-root input,.ah-root select,.ah-root textarea{font:inherit;color:inherit}
.ah-root h1,.ah-root h2,.ah-root h3,.ah-root h4,.ah-root p,.ah-root ul,.ah-root ol{margin:0;padding:0}
.ah-root ul,.ah-root ol{list-style:none}
.ah-root button{cursor:pointer}
.ah-root button:disabled{cursor:default;opacity:.6}
.ah-root .ah-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}
.ah-root .ah-spacer{flex:1}
.ah-root .ah-mono{font-family:var(--ah-mono);font-size:12.5px}
.ah-root .ah-icon{flex:none;line-height:1}
.ah-root :focus-visible{outline:2px solid var(--ah-primary);outline-offset:2px}

/* state layers (8% hover, 12% focus/press) */
.ah-root .ah-state{position:relative;isolation:isolate}
.ah-root .ah-state::before{content:"";position:absolute;inset:0;border-radius:inherit;background:currentColor;opacity:0;transition:opacity 150ms ease;pointer-events:none;z-index:-1}
.ah-root .ah-state:hover:not(:disabled)::before{opacity:.08}
.ah-root .ah-state:focus-visible::before,.ah-root .ah-state:active:not(:disabled)::before{opacity:.12}

/* app bar */
.ah-root .ah-appbar{display:flex;align-items:center;gap:16px;height:64px;padding:0 16px 0 20px;background:var(--ah-surface-container);border-bottom:1px solid var(--ah-outline-variant);flex:none}
.ah-root .ah-title{font-size:22px;line-height:28px;font-weight:500;letter-spacing:0}
.ah-root .ah-live{display:inline-flex;align-items:center;gap:8px;font-size:12px;line-height:16px;font-weight:500;color:var(--ah-on-surface-variant);padding:4px 12px;border-radius:var(--ah-r-xl);background:var(--ah-surface-high)}
.ah-root .ah-live-dot{width:8px;height:8px;border-radius:50%;background:var(--ah-outline)}
.ah-root .ah-live-dot.is-ok{background:var(--ah-ok)}
.ah-root .ah-live-dot.is-err{background:var(--ah-err)}
.ah-root .ah-search{display:flex;align-items:center;gap:8px;height:40px;width:min(280px,34vw);padding:0 12px;border-radius:var(--ah-r-xl);background:var(--ah-surface-highest);color:var(--ah-on-surface-variant);cursor:text}
.ah-root .ah-search:focus-within{outline:2px solid var(--ah-primary);outline-offset:2px}
.ah-root .ah-search input{flex:1;min-width:0;height:100%;border:0;background:transparent;outline:0;color:var(--ah-on-surface)}
.ah-root .ah-search input::placeholder{color:var(--ah-on-surface-variant)}
.ah-root .ah-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border:0;border-radius:50%;background:transparent;color:var(--ah-on-surface-variant)}

/* layout */
.ah-root .ah-main{display:grid;grid-template-columns:300px minmax(0,1fr);grid-template-rows:minmax(0,1fr);flex:1;min-height:0;min-width:0;overflow:hidden}
/* every item of a column-flex scroll list keeps its content height (never shrinks) */
.ah-root .ah-rail>*,.ah-root .ah-rail-list>*,.ah-root .ah-rail-group>*,.ah-root .ah-master>*,.ah-root .ah-conv-list>*,.ah-root .ah-files>*,.ah-root .ah-file-group>*,.ah-root .ah-rows>*,.ah-root .ah-overview>*,.ah-root .ah-bubbles>*,.ah-root .ah-transcript>*,.ah-root .ah-stream>*,.ah-root .ah-chat-col>*,.ah-root .ah-tg>*,.ah-root .ah-tg-list>*,.ah-root .ah-tc>*,.ah-root .ah-tc-body>*,.ah-root .ah-convbody>*,.ah-root .ah-handoff>*,.ah-root .ah-hpanel-body>*,.ah-root .ah-md-quote>*,.ah-root .ah-col-body>*,.ah-root .ah-task>*,.ah-root .ah-skel-wrap>*,.ah-root .ah-md>*,.ah-root .ah-repo-head>*{flex-shrink:0}
.ah-root .ah-rail{display:flex;flex-direction:column;min-height:0;overflow:hidden;background:var(--ah-surface-low);border-right:1px solid var(--ah-outline-variant);padding:8px 8px 12px}
.ah-root .ah-rail-head{display:flex;align-items:center;justify-content:space-between;padding:8px 12px 4px}
.ah-root .ah-rail-title{font-size:14px;line-height:20px;font-weight:500;color:var(--ah-on-surface-variant)}
.ah-root .ah-rail-count{font-size:12px;line-height:16px;font-weight:500;color:var(--ah-on-surface-variant)}
.ah-root .ah-rail-list{display:flex;flex-direction:column;gap:2px;overflow-y:auto;overflow-x:hidden;min-height:0;flex:1 1 0;padding-top:2px}
.ah-root .ah-rail-group{display:flex;flex-direction:column;gap:2px}
.ah-root .ah-rail-section{padding:12px 12px 4px;font-size:12px;line-height:16px;font-weight:500;letter-spacing:.02em;color:var(--ah-on-surface-variant)}
.ah-root .ah-rail-note{padding:12px;color:var(--ah-on-surface-variant)}
.ah-root .ah-rail-skel{padding:8px}
.ah-root .ah-agent{display:flex;flex:none;flex-direction:row;align-items:center;gap:12px;width:100%;height:auto;min-height:64px;margin:0;padding:8px 12px;border:0;border-radius:var(--ah-r-xl);background:transparent;text-align:left;font:inherit;line-height:20px}
.ah-root .ah-agent.is-selected{background:var(--ah-secondary-container);color:var(--ah-on-primary-container)}
.ah-root .ah-agent-body{display:flex;flex-direction:column;min-width:0;flex:1}
.ah-root .ah-agent-name{display:block;font-size:14px;line-height:20px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ah-root .ah-agent-role{display:block;font-size:12px;line-height:16px;color:var(--ah-on-surface-variant);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ah-root .ah-agent-meta{display:block;font-size:12px;line-height:16px;color:var(--ah-on-surface-variant);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ah-root .ah-agent.is-selected .ah-agent-role,.ah-root .ah-agent.is-selected .ah-agent-meta{color:inherit}
.ah-root .ah-content{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}

/* avatar */
.ah-root .ah-avatar{position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center;width:var(--ah-size,40px);height:var(--ah-size,40px);border-radius:50%;
  background:color-mix(in srgb,var(--ah-ac,#5B6CE0) 22%,var(--background));
  color:color-mix(in srgb,var(--ah-ac,#5B6CE0) 38%,var(--foreground));
  font-size:calc(var(--ah-size,40px) * .36);font-weight:500;line-height:1;letter-spacing:0}
.ah-root .ah-avatar.is-all{background:var(--ah-primary-container);color:var(--ah-on-primary-container)}
.ah-root .ah-avatar-dot{position:absolute;right:-2px;bottom:-2px;width:12px;height:12px;border-radius:50%;border:2px solid var(--ah-surface-low);background:var(--ah-outline)}
.ah-root .ah-avatar-dot.is-ok{background:var(--ah-ok)}
.ah-root .ah-avatar-dot.is-neutral{background:var(--ah-warn)}

/* chips */
.ah-root .ah-chip{display:inline-flex;align-items:center;gap:4px;max-width:100%;height:24px;padding:0 8px;border-radius:var(--ah-r-sm);font-size:12px;line-height:16px;font-weight:500;letter-spacing:.02em;white-space:nowrap;border:1px solid transparent;background:var(--ah-surface-high);color:var(--ah-on-surface-variant)}
.ah-root .ah-chip>span{overflow:hidden;text-overflow:ellipsis}
.ah-root .ah-chip.is-flat{background:transparent;border-color:var(--ah-outline-variant)}
.ah-root .ah-chip.is-info{background:var(--ah-primary-container);color:var(--ah-on-primary-container)}
.ah-root .ah-chip.is-ok{background:var(--ah-ok-c);color:var(--ah-on-ok)}
.ah-root .ah-chip.is-warn{background:var(--ah-warn-c);color:var(--ah-on-warn)}
.ah-root .ah-chip.is-err{background:var(--ah-err-c);color:var(--ah-on-err)}
.ah-root .ah-chip.is-filter{height:32px;padding:0 12px;border-radius:var(--ah-r-sm);background:var(--ah-secondary-container);color:var(--ah-on-primary-container);cursor:pointer;border:0}

/* tabs */
.ah-root .ah-tabs{display:flex;align-items:flex-end;gap:4px;padding:0 12px;border-bottom:1px solid var(--ah-outline-variant);background:var(--ah-surface);overflow-x:auto;flex:none}
.ah-root .ah-tab{display:inline-flex;align-items:center;gap:8px;height:48px;padding:0 16px;border:0;background:transparent;font-size:14px;line-height:20px;font-weight:500;color:var(--ah-on-surface-variant);border-radius:var(--ah-r-sm) var(--ah-r-sm) 0 0;white-space:nowrap}
.ah-root .ah-tab.is-selected{color:var(--ah-primary)}
.ah-root .ah-tab.is-selected::after{content:"";position:absolute;left:12px;right:12px;bottom:0;height:3px;border-radius:3px 3px 0 0;background:var(--ah-primary)}
.ah-root .ah-tab-count{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 6px;border-radius:10px;font-size:11px;line-height:16px;font-weight:500;background:var(--ah-surface-highest);color:var(--ah-on-surface-variant)}
.ah-root .ah-filter{margin-left:auto;align-self:center;padding:0 4px}

/* panels */
.ah-root .ah-panel{flex:1;min-height:0;overflow:auto;padding:20px 24px 24px;outline:0}
.ah-root .ah-panel.is-split{padding:0;overflow:hidden}
.ah-root .ah-panel.is-board{padding:16px 16px 20px;overflow:auto}
.ah-root .ah-pad{padding:0}
.ah-root .ah-inset{padding:16px 24px}

/* skeleton */
.ah-root .ah-skel-wrap{display:flex;flex-direction:column;gap:12px}
.ah-root .ah-skel{height:16px;border-radius:var(--ah-r-sm);background:linear-gradient(90deg,var(--ah-surface-high) 25%,var(--ah-surface-highest) 50%,var(--ah-surface-high) 75%);background-size:200% 100%;animation:ah-shimmer 1.4s ease-in-out infinite}
@keyframes ah-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}

/* empty and error */
.ah-root .ah-state-box{display:flex;flex-direction:column;align-items:center;gap:8px;max-width:440px;margin:40px auto;padding:24px;text-align:center}
.ah-root .ah-state-box.is-compact{margin:24px auto}
.ah-root .ah-state-icon{display:inline-flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:50%;background:var(--ah-surface-highest);color:var(--ah-on-surface-variant)}
.ah-root .ah-state-icon.is-err{background:var(--ah-err-c);color:var(--ah-on-err)}
.ah-root .ah-state-title{font-size:16px;line-height:24px;font-weight:500}
.ah-root .ah-state-detail{font-size:14px;line-height:20px;color:var(--ah-on-surface-variant);overflow-wrap:anywhere}

/* buttons */
.ah-root .ah-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:40px;padding:0 16px;border:0;border-radius:var(--ah-r-xl);font-size:14px;line-height:20px;font-weight:500;letter-spacing:.01em;background:transparent}
.ah-root .ah-btn-text{padding:0 12px;color:var(--ah-primary);min-height:36px}
.ah-root .ah-btn-tonal{background:var(--ah-secondary-container);color:var(--ah-on-primary-container);margin-top:8px}
.ah-root .ah-btn-outlined{border:1px solid var(--ah-outline);color:var(--ah-on-surface);min-height:36px;padding:0 12px}
.ah-root .ah-btn-outlined.is-on{background:var(--ah-secondary-container);color:var(--ah-on-primary-container);border-color:transparent}

/* overview */
.ah-root .ah-overview{display:flex;flex-direction:column;gap:20px}
.ah-root .ah-tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
@container (max-width:760px){.ah-root .ah-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}}
.ah-root .ah-tile{display:flex;height:auto;align-items:center;gap:16px;min-height:88px;padding:16px;border:0;border-radius:var(--ah-r-lg);background:var(--ah-surface-container);text-align:left;color:var(--ah-on-surface)}
.ah-root .ah-tile-icon{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:var(--ah-r-md);background:var(--ah-primary-container);color:var(--ah-on-primary-container);flex:none}
.ah-root .ah-tile-body{display:flex;flex-direction:column;min-width:0}
.ah-root .ah-tile-label{font-size:14px;line-height:20px;font-weight:500;color:var(--ah-on-surface-variant)}
.ah-root .ah-tile-value{font-size:28px;line-height:36px;font-weight:400;letter-spacing:0}
.ah-root .ah-tile-hint{font-size:12px;line-height:16px;color:var(--ah-on-surface-variant)}
.ah-root .ah-grid-3{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;align-items:start}
.ah-root .ah-card{border:1px solid var(--ah-outline-variant);border-radius:var(--ah-r-md);background:var(--ah-surface);overflow:hidden;min-width:0}
.ah-root .ah-card-head{display:flex;align-items:center;gap:8px;padding:8px 8px 8px 16px;color:var(--ah-on-surface-variant)}
.ah-root .ah-card-title{font-size:16px;line-height:24px;font-weight:500;color:var(--ah-on-surface)}
.ah-root .ah-card .ah-state-box{margin:12px auto 20px;padding:12px}
.ah-root .ah-rows{display:flex;flex-direction:column;padding:0 8px 8px}
.ah-root .ah-row{display:flex;flex:none;align-items:center;gap:12px;width:100%;height:auto;min-height:56px;padding:8px;border:0;border-radius:var(--ah-r-sm);background:transparent;text-align:left}
.ah-root .ah-row-body{display:flex;flex-direction:column;min-width:0;flex:1}
.ah-root .ah-row-title{font-size:14px;line-height:20px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ah-root .ah-row-sub{font-size:12px;line-height:16px;color:var(--ah-on-surface-variant);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ah-root .ah-kind-icon{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:var(--ah-secondary-container);color:var(--ah-on-primary-container);flex:none}

/* master / detail */
.ah-root .ah-split{display:grid;grid-template-columns:360px minmax(0,1fr);height:100%;min-height:0;min-width:0;overflow:hidden}
.ah-root .ah-split.is-changes{grid-template-columns:340px minmax(0,1fr)}
.ah-root .ah-master{display:flex;flex-direction:column;min-height:0;min-width:0;overflow-y:auto;overflow-x:hidden;border-right:1px solid var(--ah-outline-variant);padding:8px;gap:2px;background:var(--ah-surface)}
.ah-root .ah-detail{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:auto;background:var(--ah-surface)}

.ah-root .ah-conv{display:flex;flex:none;flex-direction:column;gap:4px;width:100%;height:auto;padding:12px;border:0;border-radius:var(--ah-r-md);background:transparent;text-align:left}
.ah-root .ah-conv.is-selected{background:var(--ah-secondary-container);color:var(--ah-on-primary-container)}
.ah-root .ah-conv-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;font-size:14px;line-height:20px;font-weight:500}
.ah-root .ah-conv-line{display:flex;align-items:center;justify-content:space-between;gap:8px}
.ah-root .ah-conv-names{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:16px;color:var(--ah-on-surface-variant)}
.ah-root .ah-conv-time{flex:none;font-size:12px;line-height:16px;color:var(--ah-on-surface-variant);white-space:nowrap}
.ah-root .ah-conv.is-selected .ah-conv-time,.ah-root .ah-conv.is-selected .ah-conv-names,.ah-root .ah-conv.is-selected .ah-conv-count{color:inherit}
.ah-root .ah-conv-chips{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:2px}
.ah-root .ah-conv-count{font-size:12px;line-height:16px;color:var(--ah-on-surface-variant)}

/* transcript */
.ah-root .ah-transcript{display:flex;flex-direction:column;gap:16px;padding:16px 24px 24px;max-width:860px;width:100%;min-width:0}
.ah-root .ah-transcript-head{display:flex;flex-direction:column;gap:6px;padding-bottom:12px;border-bottom:1px solid var(--ah-outline-variant)}
.ah-root .ah-transcript-title{font-size:22px;line-height:28px;font-weight:500;letter-spacing:0}
.ah-root .ah-transcript-sub{color:var(--ah-on-surface-variant)}
.ah-root .ah-bubbles{display:flex;flex-direction:column;gap:12px;min-width:0}
.ah-root .ah-bubble-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:4px}
.ah-root .ah-bubble-name{font-size:12px;line-height:16px;font-weight:500}
.ah-root .ah-bubble-time{font-size:12px;line-height:16px;opacity:.78}
/* markdown + tool results */
.ah-root .ah-md{display:flex;flex-direction:column;gap:8px;min-width:0;overflow-wrap:anywhere;line-height:1.55}
.ah-root .ah-md-p{margin:0}
.ah-root .ah-md-h{font-weight:600}
.ah-root .ah-md-h.is-lg{font-size:16px;line-height:24px}
.ah-root .ah-md-h.is-sm{font-size:14.5px}
.ah-root .ah-md-quote{display:flex;flex-direction:column;gap:6px;margin:0;padding:2px 0 2px 12px;border-left:3px solid color-mix(in srgb,var(--ah-primary) 45%,transparent);color:var(--ah-on-surface-variant)}
.ah-root .ah-md-tablewrap{max-width:100%;overflow:auto}
.ah-root .ah-md-table{border-collapse:collapse;font-size:13px;line-height:20px}
.ah-root .ah-md-table th,.ah-root .ah-md-table td{padding:4px 10px;border:1px solid var(--ah-outline-variant);text-align:left;vertical-align:top}
.ah-root .ah-md-table th{background:var(--ah-surface-high);font-weight:500}
.ah-root .ah-md-link{color:var(--ah-primary)}
.ah-root .ah-md-url{font-family:var(--ah-mono);font-size:12px;color:var(--ah-on-surface-variant);overflow-wrap:anywhere}
.ah-root .ah-md-hr{width:100%;height:1px;margin:4px 0;border:0;background:var(--ah-outline-variant)}
.ah-root .ah-md-list{margin:0;padding-left:20px;list-style:revert}
.ah-root .ah-md ul.ah-md-list{list-style:disc}
.ah-root .ah-md ol.ah-md-list{list-style:decimal}
.ah-root .ah-md-code{font-family:var(--ah-mono);font-size:12.5px;padding:1px 5px;border-radius:4px;background:color-mix(in srgb,var(--ah-on-surface) 9%,transparent)}
.ah-root .ah-md-pre{margin:0;padding:10px 12px;border-radius:var(--ah-r-sm);background:color-mix(in srgb,var(--ah-on-surface) 7%,transparent);font-family:var(--ah-mono);font-size:12.5px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%;overflow:auto}
.ah-root .ah-end{height:1px}

/* table */
.ah-root .ah-table-wrap{overflow:auto;border:1px solid var(--ah-outline-variant);border-radius:var(--ah-r-md)}
.ah-root .ah-table{width:100%;border-collapse:collapse;min-width:820px}
.ah-root .ah-table th{position:sticky;top:0;text-align:left;font-size:12px;line-height:16px;font-weight:500;letter-spacing:.02em;color:var(--ah-on-surface-variant);background:var(--ah-surface-container);padding:12px 16px;white-space:nowrap}
.ah-root .ah-table td{padding:10px 16px;border-top:1px solid var(--ah-outline-variant);vertical-align:middle}
.ah-root .ah-table tbody tr:hover td{background:color-mix(in srgb,var(--ah-on-surface) 4%,transparent)}
.ah-root .ah-work-title{display:flex;align-items:center;gap:12px;min-width:240px}
.ah-root .ah-work-body{display:flex;flex-direction:column;min-width:0;max-width:420px}
.ah-root .ah-inline-agent{display:inline-flex;align-items:center;gap:8px;min-width:0}
.ah-root .ah-inline-agent span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* tasks board */
.ah-root .ah-board{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(220px,1fr);gap:12px;height:100%;min-height:0;padding:0}
.ah-root .ah-col{display:flex;flex-direction:column;min-height:0;border-radius:var(--ah-r-lg);background:var(--ah-surface-low)}
.ah-root .ah-col-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px 8px}
.ah-root .ah-col-title{font-size:14px;line-height:20px;font-weight:500}
.ah-root .ah-col-body{display:flex;flex-direction:column;gap:8px;padding:4px 8px 12px;overflow:auto;min-height:0}
.ah-root .ah-col-empty{padding:12px 8px;font-size:13px;color:var(--ah-on-surface-variant)}
.ah-root .ah-task{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--ah-outline-variant);border-radius:var(--ah-r-md);background:var(--ah-surface)}
.ah-root .ah-task-title{font-size:14px;line-height:20px;font-weight:500;overflow-wrap:anywhere}
.ah-root .ah-task-chips{display:flex;flex-wrap:wrap;gap:6px}
.ah-root .ah-task-foot{display:flex;align-items:center;justify-content:space-between;gap:8px}

/* changes */
.ah-root .ah-repo-head{display:flex;flex-direction:column;gap:6px;padding:8px 8px 12px}
.ah-root .ah-field-label{font-size:12px;line-height:16px;font-weight:500;color:var(--ah-on-surface-variant)}
.ah-root .ah-select{height:40px;padding:0 12px;border:1px solid var(--ah-outline);border-radius:var(--ah-r-sm);background:var(--ah-surface);color:var(--ah-on-surface);min-width:0;width:100%}
.ah-root .ah-repo-meta{display:flex;flex-wrap:wrap;gap:6px}
.ah-root .ah-repo-note{font-size:12px;line-height:16px;color:var(--ah-on-surface-variant)}
.ah-root .ah-files{display:flex;flex-direction:column;gap:8px;padding-bottom:8px}
.ah-root .ah-file-group{display:flex;flex-direction:column}
.ah-root .ah-file-dir{padding:4px 12px;color:var(--ah-on-surface-variant);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ah-root .ah-file{display:flex;flex:none;height:auto;align-items:center;gap:10px;width:100%;min-height:40px;padding:6px 12px;border:0;border-radius:var(--ah-r-sm);background:transparent;text-align:left}
.ah-root .ah-file.is-selected{background:var(--ah-secondary-container);color:var(--ah-on-primary-container)}
.ah-root .ah-file.is-locked{color:var(--ah-on-surface-variant)}
.ah-root .ah-file-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ah-root .ah-file-lock{font-size:12px;line-height:16px}
.ah-root .ah-file-badge{display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;border-radius:var(--ah-r-sm);font-size:12px;font-weight:600;line-height:1;font-family:var(--ah-mono);background:var(--ah-surface-high);color:var(--ah-on-surface-variant)}
.ah-root .ah-file-badge.is-info{background:var(--ah-primary-container);color:var(--ah-on-primary-container)}
.ah-root .ah-file-badge.is-ok{background:var(--ah-ok-c);color:var(--ah-on-ok)}
.ah-root .ah-file-badge.is-err{background:var(--ah-err-c);color:var(--ah-on-err)}
.ah-root .ah-file-badge.is-warn{background:var(--ah-warn-c);color:var(--ah-on-warn)}
.ah-root .ah-delta{display:inline-flex;gap:8px;font-family:var(--ah-mono);font-size:12px;line-height:16px;flex:none}
.ah-root .ah-add-n{color:var(--ah-on-ok)}
.ah-root .ah-del-n{color:var(--ah-on-err)}

/* diff viewer */
.ah-root .ah-diff-wrap{display:flex;flex-direction:column;min-height:0;height:100%}
.ah-root .ah-diff-head{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--ah-outline-variant);background:var(--ah-surface-low);flex:none}
.ah-root .ah-diff-path{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ah-root .ah-diff{flex:1;min-height:0;overflow:auto;font-family:var(--ah-mono);font-size:12.5px;line-height:20px}
.ah-root .ah-diff-body{min-width:100%;width:max-content}
.ah-root .ah-diff.is-wrap .ah-diff-body{width:auto;min-width:0}
/* The app body is user-select:none; reading areas opt back in so text can be selected and copied.
   Buttons inside them stay unselectable so clicks and drags behave as before. */
.ah-root .ah-stream,.ah-root .ah-stream *,.ah-root .ah-transcript,.ah-root .ah-transcript *,.ah-root .ah-hpanel,.ah-root .ah-hpanel *,.ah-root .ah-detail,.ah-root .ah-detail *,.ah-root .ah-side-preview,.ah-root .ah-side-preview *,.ah-root .ah-diff,.ah-root .ah-diff *,.ah-root .ah-cmd-out,.ah-root .ah-cmd-out *,.ah-root .ah-cmd-body,.ah-root .ah-cmd-body *,.ah-root .ah-approval,.ah-root .ah-approval *,.ah-root .ah-goal-title,.ah-root .ah-goal-title *,.ah-root .ah-table,.ah-root .ah-table *,.ah-root .ah-md,.ah-root .ah-md *,.ah-root .ah-tc-pre,.ah-root .ah-tc-pre *,.ah-root .ah-automsg-body,.ah-root .ah-automsg-body *,.ah-root .ah-file-view,.ah-root .ah-file-view *,.ah-root .ah-preview,.ah-root .ah-preview *{-webkit-user-select:text;user-select:text}
.ah-root .ah-stream button,.ah-root .ah-stream button *,.ah-root .ah-stream [role=button],.ah-root .ah-transcript button,.ah-root .ah-transcript button *,.ah-root .ah-transcript [role=button],.ah-root .ah-hpanel button,.ah-root .ah-hpanel button *,.ah-root .ah-hpanel [role=button],.ah-root .ah-detail button,.ah-root .ah-detail button *,.ah-root .ah-detail [role=button],.ah-root .ah-side-preview button,.ah-root .ah-side-preview button *,.ah-root .ah-side-preview [role=button],.ah-root .ah-diff button,.ah-root .ah-diff button *,.ah-root .ah-diff [role=button],.ah-root .ah-cmd-out button,.ah-root .ah-cmd-out button *,.ah-root .ah-cmd-out [role=button],.ah-root .ah-cmd-body button,.ah-root .ah-cmd-body button *,.ah-root .ah-cmd-body [role=button],.ah-root .ah-approval button,.ah-root .ah-approval button *,.ah-root .ah-approval [role=button],.ah-root .ah-goal-title button,.ah-root .ah-goal-title button *,.ah-root .ah-goal-title [role=button],.ah-root .ah-table button,.ah-root .ah-table button *,.ah-root .ah-table [role=button],.ah-root .ah-md button,.ah-root .ah-md button *,.ah-root .ah-md [role=button],.ah-root .ah-tc-pre button,.ah-root .ah-tc-pre button *,.ah-root .ah-tc-pre [role=button],.ah-root .ah-automsg-body button,.ah-root .ah-automsg-body button *,.ah-root .ah-automsg-body [role=button],.ah-root .ah-file-view button,.ah-root .ah-file-view button *,.ah-root .ah-file-view [role=button],.ah-root .ah-preview button,.ah-root .ah-preview button *,.ah-root .ah-preview [role=button],.ah-root .ah-dl-no,.ah-root .ah-dl-sign{-webkit-user-select:none;user-select:none}
.ah-root .ah-banner{display:flex;align-items:center;gap:8px;margin:8px 16px 0;padding:8px 12px;border-radius:10px;font-size:13px;line-height:1.4}
.ah-root .ah-banner.is-warn{background:color-mix(in srgb,#f59e0b 14%,transparent);color:var(--foreground);border:1px solid color-mix(in srgb,#f59e0b 45%,transparent)}
.ah-root .ah-dl{display:grid;grid-template-columns:48px 48px 20px minmax(0,1fr)}
.ah-root .ah-dl.is-hunk,.ah-root .ah-dl.is-meta{grid-template-columns:minmax(0,1fr)}
.ah-root .ah-dl-no{padding:0 8px;text-align:right;color:var(--ah-on-surface-variant);user-select:none;border-right:1px solid color-mix(in srgb,var(--ah-outline-variant) 60%,transparent)}
.ah-root .ah-dl-sign{text-align:center;user-select:none;font-weight:600}
.ah-root .ah-dl-code{white-space:pre;padding:0 12px 0 4px}
.ah-root .ah-diff.is-wrap .ah-dl-code{white-space:pre-wrap;overflow-wrap:anywhere}
.ah-root .ah-dl.is-add{background:var(--ah-ok-c)}
.ah-root .ah-dl.is-add .ah-dl-sign{color:var(--ah-on-ok)}
.ah-root .ah-dl.is-del{background:var(--ah-err-c)}
.ah-root .ah-dl.is-del .ah-dl-sign{color:var(--ah-on-err)}
.ah-root .ah-dl.is-hunk{background:var(--ah-primary-container);color:var(--ah-on-primary-container);padding:2px 12px;margin-top:0}
.ah-root .ah-dl.is-meta{color:var(--ah-on-surface-variant);padding:0 12px}
.ah-root .ah-dl.is-hunk .ah-dl-code,.ah-root .ah-dl.is-meta .ah-dl-code{padding:0}
.ah-root .ah-diff-note{padding:12px 16px;color:var(--ah-on-surface-variant);font-family:inherit}

/* chat tab */
.ah-root .ah-chat{display:grid;grid-template-columns:minmax(0,1fr);height:100%;min-height:0;min-width:0;overflow:hidden}
.ah-root .ah-chat.has-panel{grid-template-columns:minmax(0,1fr) 440px}
.ah-root .ah-chat-main{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}
.ah-root .ah-chat-head{display:flex;align-items:center;gap:12px;flex:none;min-height:60px;padding:10px 20px;border-bottom:1px solid var(--ah-outline-variant)}
.ah-root .ah-chat-titles{flex:1;min-width:0}
.ah-root .ah-chat-title{font-size:16px;line-height:24px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ah-root .ah-chat-sub{font-size:12px;line-height:16px;color:var(--ah-on-surface-variant);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ah-root .ah-chat-body{position:relative;display:flex;flex-direction:column;flex:1;min-height:0}
.ah-root .ah-chat-scroll{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;outline-offset:-2px}
.ah-root .ah-chat-col{display:flex;flex-direction:column;gap:12px;width:100%;max-width:880px;margin:0 auto;padding:20px 24px 12px;min-width:0}
.ah-root .ah-chat-skel{padding:8px 0}
.ah-root .ah-more{display:flex;align-items:center;justify-content:center;gap:12px}
.ah-root .ah-stream{display:flex;flex-direction:column;gap:12px;min-width:0}
.ah-root .ah-stream-item{display:flex;align-items:flex-start;gap:10px;min-width:0}
.ah-root .ah-stream-item.is-user{flex-direction:column;align-items:flex-end;gap:2px}
.ah-root .ah-stream-item.is-user.is-pending .ah-bub{opacity:.72}
.ah-root .ah-stream-item.is-divider,.ah-root .ah-stream-item.is-handoff{justify-content:center}
.ah-root .ah-stream-item.is-handoff{padding:2px 0}
.ah-root .ah-bub-col{display:flex;flex-direction:column;gap:2px;min-width:0;max-width:min(72ch,100%)}
.ah-root .ah-bub{min-width:0;max-width:min(72ch,100%);line-height:1.55;overflow-wrap:anywhere;padding:10px 14px 12px;border-radius:4px var(--ah-r-lg) var(--ah-r-lg) var(--ah-r-lg);background:var(--ah-surface-container)}
.ah-root .ah-bub.role-user{background:var(--ah-primary-container);color:var(--ah-on-primary-container)}
.ah-root .ah-stream.is-chat .ah-bub.role-user{max-width:min(72ch,88%);border-radius:var(--ah-r-lg) var(--ah-r-lg) 4px var(--ah-r-lg)}
.ah-root .ah-msg-time{padding:0 4px;font-size:11px;line-height:16px;color:var(--ah-on-surface-variant)}
.ah-root .ah-av-gap{flex:none;width:32px}

/* tool calls */
.ah-root .ah-tg{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0;max-width:min(84ch,100%)}
.ah-root .ah-tg-head{display:flex;flex:none;align-items:center;align-self:flex-start;gap:8px;max-width:100%;height:auto;min-height:32px;padding:4px 10px 4px 6px;border:0;border-radius:var(--ah-r-sm);background:transparent;color:var(--ah-on-surface-variant);font-size:13px;line-height:20px;text-align:left}
.ah-root .ah-tg-title{flex:none;font-weight:500}
.ah-root .ah-tg-names{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ah-mono);font-size:12px}
.ah-root .ah-tg-list{display:flex;flex-direction:column;gap:4px;margin-left:10px;padding-left:10px;border-left:2px solid var(--ah-outline-variant)}
.ah-root .ah-tc{display:flex;flex-direction:column;min-width:0;border:1px solid var(--ah-outline-variant);border-radius:var(--ah-r-md);background:var(--ah-surface-low);overflow:hidden}
.ah-root .ah-tc-row{display:flex;flex:none;align-items:center;gap:8px;width:100%;height:auto;min-height:36px;padding:6px 10px 6px 8px;border:0;background:transparent;text-align:left;color:var(--ah-on-surface)}
.ah-root .ah-tc-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:22px;height:22px;border-radius:50%;background:var(--ah-secondary-container);color:var(--ah-on-primary-container)}
.ah-root .ah-tc-name{flex:none;font-size:12px;line-height:16px;font-weight:500;letter-spacing:.02em}
.ah-root .ah-tc-sum{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ah-on-surface-variant)}
.ah-root .ah-tc-body{display:flex;flex-direction:column;gap:6px;padding:8px 10px 10px;border-top:1px solid var(--ah-outline-variant)}
.ah-root .ah-tc-label{font-size:12px;line-height:16px;font-weight:500;color:var(--ah-on-surface-variant)}
.ah-root .ah-tc-pre{margin:0;padding:8px 10px;border-radius:var(--ah-r-sm);background:color-mix(in srgb,var(--ah-on-surface) 7%,transparent);white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5;max-height:320px;overflow:auto}
.ah-root .ah-tc-none{font-size:12px;line-height:16px;color:var(--ah-on-surface-variant)}

/* handoff pill + session divider */
.ah-root .ah-handoff{display:flex;flex-direction:column;align-items:center;gap:8px;width:100%;min-width:0}
.ah-root .ah-handoff-pill{display:inline-flex;flex:none;align-items:center;gap:8px;max-width:100%;height:auto;min-height:36px;padding:4px 12px 4px 6px;border:1px solid color-mix(in srgb,var(--ah-ac) 30%,transparent);border-radius:var(--ah-r-xl);background:color-mix(in srgb,var(--ah-ac) 12%,var(--background));color:color-mix(in srgb,var(--ah-ac) 38%,var(--foreground));font-size:13px;line-height:20px;font-weight:500}
.ah-root .ah-handoff-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ah-root .ah-handoff-time{flex:none;font-size:12px;line-height:16px;font-weight:400}
.ah-root .ah-handoff-card{display:flex;flex-direction:column;gap:6px;width:100%;max-width:560px;padding:12px 16px;border:1px solid color-mix(in srgb,var(--ah-ac) 30%,transparent);border-radius:var(--ah-r-md);background:var(--ah-surface)}
.ah-root .ah-handoff-title{font-weight:500}
.ah-root .ah-handoff-sum{color:var(--ah-on-surface-variant);overflow-wrap:anywhere}
.ah-root .ah-handoff-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px}
.ah-root .ah-handoff-card>*{flex-shrink:0}
.ah-root .ah-btn-sm{min-height:32px;padding:0 12px;margin:0}
.ah-root .ah-btn-tonal.is-on{outline:2px solid var(--ah-primary)}
.ah-root .ah-divider{display:flex;align-items:center;gap:12px;width:100%;min-width:0;color:var(--ah-on-surface-variant);font-size:12px;line-height:16px}
.ah-root .ah-divider-line{flex:1;height:1px;background:var(--ah-outline-variant)}
.ah-root .ah-divider-label{flex:0 1 auto;max-width:76%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* composer */
.ah-root .ah-composer-wrap{flex:none;padding:8px 24px 16px;background:var(--ah-surface)}
.ah-root .ah-composer-col{display:flex;flex-direction:column;gap:8px;width:100%;max-width:880px;margin:0 auto}
.ah-root .ah-composer-col>*{flex-shrink:0}
.ah-root .ah-composer{display:flex;align-items:flex-end;gap:8px;padding:6px 6px 6px 18px;border:1px solid var(--ah-outline-variant);border-radius:var(--ah-r-xl);background:var(--ah-surface-container)}
.ah-root .ah-composer:focus-within{border-color:var(--ah-primary);box-shadow:0 0 0 1px var(--ah-primary)}
.ah-root .ah-composer.is-disabled{opacity:.6}
.ah-root .ah-composer-input{flex:1;min-width:0;min-height:40px;max-height:200px;padding:8px 0;border:0;outline:0;resize:none;background:transparent;color:var(--ah-on-surface);line-height:24px}
.ah-root .ah-composer-input::placeholder{color:var(--ah-on-surface-variant)}
.ah-root .ah-send{display:inline-flex;align-items:center;justify-content:center;flex:none;width:40px;height:40px;border:0;border-radius:50%;background:var(--ah-primary);color:var(--ah-on-primary)}
.ah-root .ah-send:disabled{opacity:1;background:color-mix(in srgb,var(--ah-on-surface) 12%,transparent);color:color-mix(in srgb,var(--ah-on-surface) 45%,var(--background))}
.ah-root .ah-busy{display:flex;align-items:center;gap:8px;padding:0 0 0 12px;color:var(--ah-on-surface-variant);font-size:13px;line-height:20px}
.ah-root .ah-composer-note{padding:0 12px;font-size:12px;line-height:16px;color:var(--ah-on-surface-variant)}
.ah-root .ah-composer-error{display:flex;align-items:center;gap:8px;padding:6px 6px 6px 12px;border-radius:var(--ah-r-md);background:var(--ah-err-c);color:var(--ah-on-err)}
.ah-root .ah-composer-error-text{flex:1;min-width:0;overflow-wrap:anywhere}
.ah-root .ah-newpill{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);z-index:1;display:inline-flex;align-items:center;gap:6px;height:auto;min-height:36px;padding:0 16px 0 12px;border:0;border-radius:var(--ah-r-xl);background:var(--ah-primary);color:var(--ah-on-primary);font-size:13px;line-height:20px;font-weight:500;box-shadow:0 1px 3px color-mix(in srgb,var(--foreground) 30%,transparent)}

/* handoff detail panel */
.ah-root .ah-hpanel{display:flex;flex-direction:column;min-width:0;min-height:0;border-left:1px solid var(--ah-outline-variant);background:var(--ah-surface-low)}
.ah-root .ah-hpanel-head{display:flex;align-items:center;gap:8px;flex:none;padding:10px 12px;border-bottom:1px solid var(--ah-outline-variant)}
.ah-root .ah-hpanel-back{display:none}
.ah-root .ah-hpanel-titles{flex:1;min-width:0}
.ah-root .ah-hpanel-title{font-size:16px;line-height:24px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ah-root .ah-hpanel-sub{font-size:12px;line-height:16px;color:var(--ah-on-surface-variant)}
.ah-root .ah-hpanel-body{flex:1;min-height:0;overflow:auto;padding:16px}
.ah-root .ah-hpanel-body .ah-inset{padding:0}
.ah-root .ah-convbody{display:flex;flex-direction:column;gap:12px;min-width:0}

/* below 1280px the rail collapses to a 72px avatar-only column */
@container (max-width:1279px){
  .ah-root .ah-main{grid-template-columns:72px minmax(0,1fr)}
  .ah-root .ah-rail{padding:8px 6px;align-items:stretch}
  .ah-root .ah-rail-head,.ah-root .ah-agent-body{display:none}
  .ah-root .ah-rail-section{height:1px;padding:0;margin:6px 12px;overflow:hidden;font-size:0;background:var(--ah-outline-variant)}
  .ah-root .ah-agent{position:relative;justify-content:center;min-height:56px;padding:8px 0;gap:0;border-radius:var(--ah-r-lg)}
  /* running-commands badge: a count bubble on the avatar's corner, out of the flow so the face stays centered */
  .ah-root .ah-agent .ah-agent-cmds{position:absolute;top:4px;right:4px;z-index:1;margin:0;min-width:18px;height:18px;padding:0 4px;justify-content:center;gap:0;font-size:10px;line-height:18px;background:var(--ah-primary);color:var(--ah-on-primary);box-shadow:0 0 0 2px var(--ah-surface)}
  .ah-root .ah-agent .ah-agent-cmds .ah-icon{display:none}
  .ah-root .ah-search{width:min(220px,30cqw)}
}
@container (max-width:1099px){
  .ah-root .ah-chat.has-panel{grid-template-columns:minmax(0,1fr)}
  .ah-root .ah-chat.has-panel .ah-chat-main{display:none}
  .ah-root .ah-hpanel{border-left:0}
  .ah-root .ah-hpanel-back{display:inline-flex}
  .ah-root .ah-hpanel-close{display:none}
}
@container (max-width:900px){
  .ah-root .ah-split,.ah-root .ah-split.is-changes{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(160px,38%) minmax(0,1fr)}
  .ah-root .ah-master{border-right:0;border-bottom:1px solid var(--ah-outline-variant)}
}
@container (max-width:560px){
  .ah-root .ah-live{display:none}
  .ah-root .ah-panel{padding:16px 12px 20px}
}

/* chat: full width, left aligned */
.ah-root .ah-chat{position:relative}
.ah-root .ah-chat.has-panel{grid-template-columns:minmax(0,1fr) 380px}
.ah-root .ah-chat.has-panel.is-wide{grid-template-columns:minmax(0,1fr) minmax(420px,46%)}
.ah-root .ah-chat-col{max-width:none;margin:0;padding:20px 28px 12px}
.ah-root .ah-composer-wrap{padding:8px 28px 16px}
.ah-root .ah-composer-col{position:relative;max-width:none;margin:0}
.ah-root .ah-stream.is-chat .ah-bub.role-user{max-width:min(90ch,80%)}
.ah-root .ah-bub-col,.ah-root .ah-bub{max-width:min(110ch,100%)}
.ah-root .ah-hide-sm{display:inline}
.ah-root .ah-icon-btn.is-on{background:var(--ah-secondary-container);color:var(--ah-on-primary-container)}
.ah-root .ah-icon-btn-sm{width:32px;height:32px}
.ah-root .ah-head-model{color:var(--ah-on-surface-variant);font-size:11.5px}
.ah-root .ah-head-live{display:inline-flex;align-items:center;gap:6px;color:var(--ah-primary);font-weight:500}

/* composer */
.ah-root .ah-composer{flex-direction:column;align-items:stretch;gap:4px;padding:8px 8px 6px 16px;transition:border-color .15s ease,box-shadow .15s ease}
.ah-root .ah-composer.is-drag{border-style:dashed;border-color:var(--ah-primary);background:color-mix(in srgb,var(--ah-primary) 6%,var(--ah-surface-container))}
.ah-root .ah-composer.is-running{border-color:color-mix(in srgb,var(--ah-primary) 55%,var(--ah-outline-variant))}
.ah-root .ah-composer-input{flex:none;min-height:32px;max-height:368px;padding:4px 0;line-height:24px;overflow-y:hidden}
.ah-root .ah-composer-bar{display:flex;align-items:center;gap:4px;min-height:40px;flex-wrap:wrap}
.ah-root .ah-bar-sep{width:1px;height:20px;margin:0 4px;background:var(--ah-outline-variant)}
.ah-root .ah-tool-btn{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 10px;border:0;border-radius:var(--ah-r-xl);background:transparent;color:var(--ah-on-surface-variant);font-size:12.5px;line-height:16px;font-weight:500;white-space:nowrap}
.ah-root .ah-tool-btn.is-open{background:var(--ah-secondary-container);color:var(--ah-on-primary-container)}
.ah-root .ah-tool-btn.is-pending{color:var(--ah-primary)}
.ah-root .ah-tool-icon{width:32px;padding:0;justify-content:center}
.ah-root .ah-model-name{max-width:220px;overflow:hidden;text-overflow:ellipsis;font-family:var(--ah-mono);font-size:12px}
.ah-root .ah-send.is-busy{background:var(--ah-primary)}
.ah-root .ah-stop{display:inline-flex;align-items:center;justify-content:center;flex:none;width:40px;height:40px;border:0;border-radius:50%;background:var(--ah-err-c);color:var(--ah-on-err);animation:ah-breathe 1.6s ease-in-out infinite}

/* attachments */
.ah-root .ah-att-row{display:flex;flex-wrap:wrap;gap:6px;padding:2px 0 4px}
.ah-root .ah-att-tray{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:4px 0 6px;flex:none}
.ah-root .ah-thumb{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;width:56px;height:56px;border-radius:var(--ah-r-md);border:1px solid var(--ah-outline-variant);background:var(--ah-surface-high);overflow:hidden}
.ah-root .ah-thumb img{width:100%;height:100%;object-fit:cover}
.ah-root .ah-thumb-x{position:absolute;top:3px;right:3px;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:50%;background:color-mix(in srgb,#000 55%,transparent);color:#fff;opacity:0;transition:opacity .12s ease}
.ah-root .ah-thumb:hover .ah-thumb-x,.ah-root .ah-thumb-x:focus-visible{opacity:1}
.ah-root .ah-thumb-more{font-size:15px;font-weight:600;color:var(--ah-on-surface-variant);cursor:pointer}
.ah-root .ah-att-row.is-sent{padding:0 0 6px}
.ah-root .ah-att{display:inline-flex;align-items:center;gap:8px;max-width:260px;height:44px;padding:4px 4px 4px 4px;border:1px solid var(--ah-outline-variant);border-radius:var(--ah-r-md);background:var(--ah-surface);color:var(--ah-on-surface)}
.ah-root .ah-att-thumb{width:34px;height:34px;flex:none;border-radius:6px;object-fit:cover;background:var(--ah-surface-high)}
.ah-root .ah-att-icon{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;flex:none;border-radius:6px;background:var(--ah-surface-high);color:var(--ah-on-surface-variant)}
.ah-root .ah-att-body{display:flex;flex-direction:column;min-width:0}
.ah-root .ah-att-name{font-size:12.5px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ah-root .ah-att-size{font-size:11px;line-height:14px;color:var(--ah-on-surface-variant)}
.ah-root .ah-att-x{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;flex:none;border:0;border-radius:50%;background:transparent;color:var(--ah-on-surface-variant)}

/* popovers: model, reasoning, slash */
.ah-root .ah-composer{position:relative}
.ah-root .ah-automsg.is-compact{display:flex;align-items:center;gap:6px;padding:2px 10px;border:0;background:transparent;color:var(--ah-on-surface-variant);font-size:12px}
.ah-root .ah-automsg.is-compact .ah-automsg-time{margin-left:auto}
.ah-root .ah-queue{display:flex;flex-direction:column;gap:4px;margin:0 0 6px}
.ah-root .ah-queue-item{display:flex;align-items:center;gap:8px;min-height:34px;padding:4px 6px 4px 10px;border:1px solid var(--ah-outline-variant);border-radius:var(--ah-r-md);background:var(--ah-surface-low);font-size:13px}
.ah-root .ah-queue-ic{color:var(--ah-on-surface-variant);flex:none}
.ah-root .ah-queue-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ah-root .ah-queue-att{display:inline-flex;align-items:center;gap:2px;font-size:11px;color:var(--ah-on-surface-variant)}
.ah-root .ah-queue-err{color:var(--ah-err);display:inline-flex}
.ah-root .ah-queue-steer{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 10px;border:0;border-radius:999px;background:var(--ah-primary-container);color:var(--ah-on-primary-container);font:inherit;font-size:12px;font-weight:600;cursor:pointer}
.ah-root .ah-queue-steer:disabled{opacity:.45;cursor:default}
.ah-root .ah-queue-remove{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:0;border-radius:50%;background:transparent;color:var(--ah-on-surface-variant);cursor:pointer}
.ah-root .ah-queue-remove:hover{background:var(--ah-surface-highest);color:var(--ah-err)}
.ah-root .ah-queue-hint{font-size:11px;color:var(--ah-on-surface-variant);padding-left:2px}
.ah-root .ah-live-steer{display:flex;align-items:baseline;gap:6px;margin:4px 0 0;font-size:12px;color:var(--ah-on-surface-variant)}
.ah-root .ah-live-steer b{color:var(--ah-primary);font-weight:600}
.ah-root .ah-usage-left{display:inline-flex;align-items:center;gap:2px;font-variant-numeric:tabular-nums}
.ah-root .ah-usage-reset b{font-weight:600;color:var(--ah-on-surface)}
.ah-root .ah-usage-sub{font-size:11px;font-weight:600;opacity:.8}
.ah-root .ah-usage{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-height:22px;padding:2px 4px 0;font-size:11.5px;line-height:16px;color:var(--ah-on-surface-variant)}
.ah-root .ah-usage-muted{display:inline-flex;align-items:center;gap:4px;opacity:.8}
.ah-root .ah-usage-chip{position:relative;display:inline-flex;align-items:center;gap:7px;height:22px;padding:0 8px;border:1px solid var(--ah-outline-variant);border-radius:999px;background:var(--ah-surface);color:var(--ah-on-surface-variant);font:inherit;cursor:default;outline:0}
.ah-root button.ah-usage-chip{cursor:pointer}
.ah-root .ah-usage-chip b{font-weight:600;color:var(--ah-on-surface)}
.ah-root .ah-usage-chip.is-muted{opacity:.75}
.ah-root .ah-usage-chip:focus-visible{box-shadow:0 0 0 2px var(--ah-primary)}
.ah-root .ah-usage-win{display:inline-flex;align-items:center;gap:4px;font-variant-numeric:tabular-nums}
.ah-root .ah-usage-win small{opacity:.75;font-size:10.5px}
.ah-root .ah-usage-meter{display:inline-block;width:28px;height:4px;border-radius:2px;background:var(--ah-surface-highest);overflow:hidden}
.ah-root .ah-usage-meter.is-wide{display:block;width:100%;height:5px;margin:3px 0}
.ah-root .ah-usage-meter>span{display:block;height:100%;border-radius:inherit;background:var(--ah-ok)}
.ah-root .ah-usage-meter>span.is-warn{background:var(--ah-warn)}
.ah-root .ah-usage-meter>span.is-err{background:var(--ah-err)}
.ah-root .ah-usage-chip.is-err{border-color:color-mix(in srgb,var(--ah-err) 55%,transparent)}
.ah-root .ah-usage-chip.is-warn{border-color:color-mix(in srgb,var(--ah-warn) 55%,transparent)}
.ah-root .ah-usage-stale{color:var(--ah-warn)}
.ah-root .ah-usage-pop{display:none;position:absolute;left:0;bottom:calc(100% + 6px);z-index:1;width:260px;padding:10px 12px;border:1px solid var(--ah-outline-variant);border-radius:var(--ah-r-md);background:var(--ah-surface-high);color:var(--ah-on-surface);box-shadow:0 8px 24px rgba(0,0,0,.22);flex-direction:column;gap:6px;font-size:12px;line-height:16px;white-space:normal}
.ah-root .ah-usage-chip:hover .ah-usage-pop,.ah-root .ah-usage-chip:focus .ah-usage-pop{display:flex}
.ah-root .ah-usage-pop small{color:var(--ah-on-surface-variant)}
.ah-root .ah-usage-pop hr{width:100%;border:0;border-top:1px solid var(--ah-outline-variant);margin:2px 0}
.ah-root .ah-usage-line{display:flex;justify-content:space-between;gap:10px}
.ah-root .ah-usage-line>span:first-child{color:var(--ah-on-surface-variant)}
.ah-root .ah-usage-wrow{display:flex;flex-direction:column}
.ah-root .ah-usage-err{color:var(--ah-err)}
.ah-root .ah-config{display:flex;flex-direction:column;gap:16px;max-width:960px}
.ah-root .ah-config-pick{display:flex;align-items:center;gap:8px}
.ah-root .ah-config-pick .ah-input{width:auto;min-width:180px}
.ah-root .ah-acct-list,.ah-root .ah-team{display:flex;flex-direction:column;gap:10px;padding:12px 16px 16px}
.ah-root .ah-acct{border:1px solid var(--ah-outline-variant);border-radius:var(--ah-r-md);padding:10px 12px}
.ah-root .ah-acct-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ah-root .ah-acct-main{display:flex;flex-direction:column;min-width:0}
.ah-root .ah-acct-dot{width:9px;height:9px;border-radius:50%;flex:none;background:var(--ah-outline)}
.ah-root .ah-acct-dot.is-ok{background:var(--ah-ok)}
.ah-root .ah-acct-more summary{cursor:pointer;font-size:12px;color:var(--ah-on-surface-variant);padding:4px 0}
.ah-root .ah-acct-more .ah-acct{margin-top:8px}
.ah-root .ah-login{display:flex;flex-direction:column;gap:8px;margin-top:10px;padding-top:10px;border-top:1px dashed var(--ah-outline-variant)}
.ah-root .ah-login-step{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px}
.ah-root .ah-login-step .ah-input{flex:1;min-width:220px}
.ah-root .ah-task-block{display:flex;flex-direction:column;gap:2px;margin:6px 0;padding:6px 8px;border-radius:var(--ah-r-sm);background:color-mix(in srgb,var(--ah-warn,#c80) 12%,transparent);font-size:12px}
.ah-root .ah-task-block.is-owner{background:color-mix(in srgb,var(--ah-err,#c33) 14%,transparent)}
.ah-root .ah-task-block-head{font-weight:600}
.ah-root .ah-task-block-why,.ah-root .ah-task-note{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.ah-root .ah-task-note{margin:4px 0;font-size:12px;opacity:.85}
.ah-root .ah-shared-notes{margin:6px 0;padding-left:18px;font-size:12.5px}
.ah-root .ah-login-link{flex-basis:100%;font-size:12px;padding:4px 8px;border-radius:var(--ah-r-sm);background:var(--ah-surface-highest);user-select:all;word-break:break-all}
.ah-root .ah-login-code{font-family:var(--ah-mono);font-size:18px;font-weight:700;letter-spacing:.12em;padding:2px 10px;border-radius:var(--ah-r-sm);background:var(--ah-surface-highest)}
.ah-root .ah-login-log pre{max-height:160px;overflow:auto;font-size:11px;margin:4px 0 0;white-space:pre-wrap}
.ah-root .ah-team-row{display:flex;align-items:center;gap:12px;padding:8px 0;border-top:1px solid var(--ah-outline-variant)}
.ah-root .ah-team-main{display:flex;flex-direction:column;min-width:0;flex:1}
.ah-root .ah-team-cap{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.ah-root .ah-team-edit{display:flex;flex-direction:column;gap:10px;padding:10px 0;border-top:1px solid var(--ah-outline-variant)}
.ah-root .ah-team-new-head{display:flex;align-items:center;gap:12px}
.ah-root .ah-picker{display:inline-flex;align-items:center;gap:2px;min-width:0}
.ah-root .ah-pop{position:absolute;left:0;bottom:calc(100% + 6px);z-index:1;display:flex;flex-direction:column;min-width:220px;max-height:min(420px,60vh);border:1px solid var(--ah-outline-variant);border-radius:var(--ah-r-md);background:var(--popover,var(--theme-elevated-seed,var(--ah-surface-container)));color:var(--popover-foreground,var(--ah-on-surface));backdrop-filter:blur(18px);box-shadow:0 8px 28px color-mix(in srgb,#000 22%,transparent);overflow:hidden;animation:ah-pop-in .14s ease-out}
.ah-root .ah-pop-model{width:min(380px,80cqw)}
.ah-root .ah-pop-reason{padding:4px}
.ah-root .ah-pop-head{display:flex;align-items:center;gap:8px;padding:6px 6px 6px 12px;border-bottom:1px solid var(--ah-outline-variant);color:var(--ah-on-surface-variant)}
.ah-root .ah-pop-search{flex:1;min-width:0;height:32px;border:0;outline:0;background:transparent;color:var(--ah-on-surface)}
.ah-root .ah-pop-list{flex:1;min-height:0;overflow:auto;padding:4px}
.ah-root .ah-pop-group{display:flex;flex-direction:column}
.ah-root .ah-pop-group{flex-shrink:0}
.ah-root .ah-pop-group-title{display:flex;align-items:center;gap:6px;width:100%;min-height:32px;padding:4px 10px;border:0;border-radius:var(--ah-r-sm);background:transparent;text-align:left;font-size:12px;line-height:16px;font-weight:500;color:var(--ah-on-surface-variant)}
.ah-root .ah-pop-group.is-open>.ah-pop-group-title{color:var(--ah-on-surface)}
.ah-root .ah-pop-group-name{flex:none}
.ah-root .ah-pop-group-cur{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-weight:400;color:var(--ah-primary)}
.ah-root .ah-pop-group-n{margin-left:auto;font-size:11px;font-weight:400;color:var(--ah-on-surface-variant)}
.ah-root .ah-pop-group.is-open>.ah-pop-item{padding-left:26px}
.ah-root .ah-pop-item{display:flex;align-items:center;gap:8px;width:100%;min-height:32px;padding:4px 10px;border:0;border-radius:var(--ah-r-sm);background:transparent;text-align:left;font-size:13px;flex-shrink:0}
.ah-root .ah-pop-item.is-on{background:var(--ah-secondary-container);color:var(--ah-on-primary-container)}
.ah-root .ah-pop-check{display:inline-flex;width:14px;flex:none}
.ah-root .ah-pop-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ah-root .ah-pop-meta,.ah-root .ah-pop-tag{color:var(--ah-on-surface-variant);font-size:11px}
.ah-root .ah-pop-note{padding:8px 12px;font-size:12px;color:var(--ah-on-surface-variant)}
.ah-root .ah-pop-note.is-err{color:var(--ah-err)}
.ah-root .ah-pop-foot{padding:8px 12px;border-top:1px solid var(--ah-outline-variant);font-size:11.5px;line-height:16px;color:var(--ah-on-surface-variant)}
.ah-root .ah-pop-skel{padding:8px}
.ah-root .ah-slash{position:absolute;left:0;right:0;bottom:calc(100% + 4px);z-index:1;display:flex;flex-direction:column;max-height:min(340px,50vh);border:1px solid var(--ah-outline-variant);border-radius:var(--ah-r-md);background:var(--popover,var(--theme-elevated-seed,var(--ah-surface-container)));color:var(--popover-foreground,var(--ah-on-surface));backdrop-filter:blur(18px);box-shadow:0 8px 28px color-mix(in srgb,#000 22%,transparent);overflow:hidden;animation:ah-pop-in .12s ease-out}
.ah-root .ah-slash-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--ah-outline-variant);font-size:12px;font-weight:500;color:var(--ah-on-surface-variant)}
.ah-root .ah-slash-hint{font-weight:400}
.ah-root .ah-slash-list{overflow:auto;padding:4px}
.ah-root .ah-slash-item{display:flex;align-items:baseline;gap:12px;width:100%;min-height:32px;padding:6px 10px;border:0;border-radius:var(--ah-r-sm);background:transparent;text-align:left;flex-shrink:0}
.ah-root .ah-slash-item.is-on{background:var(--ah-secondary-container);color:var(--ah-on-primary-container)}
.ah-root .ah-slash-cmd{flex:none;font-weight:500}
.ah-root .ah-slash-meta{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--ah-on-surface-variant)}

/* command log */
.ah-root .ah-cmdlog{display:flex;flex-direction:column;gap:8px}
.ah-root .ah-cmdlog>*{flex-shrink:0}
.ah-root .ah-cmd{display:flex;gap:10px;align-items:flex-start;padding:8px 12px;border:1px dashed var(--ah-outline-variant);border-radius:var(--ah-r-md);background:var(--ah-surface-low)}
.ah-root .ah-cmd.is-err{border-color:var(--ah-err);background:var(--ah-err-c);color:var(--ah-on-err)}
.ah-root .ah-cmd-state{display:inline-flex;padding-top:2px;color:var(--ah-primary)}
.ah-root .ah-cmd-body{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.ah-root .ah-cmd-text{font-weight:500}
.ah-root .ah-cmd-out{margin:0;max-height:240px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;color:var(--ah-on-surface-variant)}

/* live turn */
.ah-root .ah-live-av{position:relative;display:inline-flex;flex:none;border-radius:50%}
.ah-root .ah-live-av.is-on::after{content:"";position:absolute;inset:-4px;border-radius:50%;border:2px solid var(--ah-primary);animation:ah-ring 1.6s ease-out infinite;pointer-events:none}
.ah-root .ah-live-av.is-on::before{content:"";position:absolute;inset:-3px;border-radius:50%;background:conic-gradient(from 0deg,var(--ah-primary),transparent 70%);animation:ah-spin 1.2s linear infinite;-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 2px),#000 calc(100% - 2px));mask:radial-gradient(farthest-side,transparent calc(100% - 2px),#000 calc(100% - 2px));pointer-events:none}
.ah-root .ah-live-card{flex:1;min-width:0;max-width:min(110ch,100%);display:flex;flex-direction:column;gap:8px;padding:10px 14px 12px;border-radius:4px var(--ah-r-lg) var(--ah-r-lg) var(--ah-r-lg);background:var(--ah-surface-container);border:1px solid color-mix(in srgb,var(--ah-primary) 30%,transparent)}
.ah-root .ah-stream-item.is-live:not(.is-active) .ah-live-card{border-color:var(--ah-outline-variant)}
.ah-root .ah-live-card.is-err{border-color:var(--ah-err)}
.ah-root .ah-live-head{display:flex;align-items:center;gap:8px;min-height:24px}
.ah-root .ah-live-orb{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;flex:none;border-radius:50%;background:var(--ah-primary-container);color:var(--ah-on-primary-container)}
.ah-root .ah-live-orb.is-reasoning,.ah-root .ah-live-orb.is-thinking,.ah-root .ah-live-orb.is-waiting{animation:ah-breathe 1.4s ease-in-out infinite}
.ah-root .ah-live-orb.is-tool,.ah-root .ah-live-orb.is-tool-gen{background:var(--ah-warn-c);color:var(--ah-on-warn);animation:ah-breathe 1s ease-in-out infinite}
.ah-root .ah-live-orb.is-writing{background:var(--ah-ok-c);color:var(--ah-on-ok)}
.ah-root .ah-live-orb.is-err{background:var(--ah-err-c);color:var(--ah-on-err)}
.ah-root .ah-live-orb.is-done{background:var(--ah-ok-c);color:var(--ah-on-ok)}
.ah-root .ah-live-label{font-size:13px;line-height:20px;font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ah-root .ah-live-label.is-shimmer{background:linear-gradient(90deg,var(--ah-on-surface-variant) 0%,var(--ah-on-surface) 40%,var(--ah-primary) 50%,var(--ah-on-surface) 60%,var(--ah-on-surface-variant) 100%);background-size:250% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:ah-text-shimmer 2.2s linear infinite}
.ah-root .ah-live-meta{font-size:11.5px;line-height:16px;color:var(--ah-on-surface-variant);white-space:nowrap}
.ah-root .ah-dots{display:inline-flex;gap:3px;align-items:center}
.ah-root .ah-dots i{width:5px;height:5px;border-radius:50%;background:var(--ah-primary);animation:ah-dot 1.2s ease-in-out infinite}
.ah-root .ah-dots i:nth-child(2){animation-delay:.15s}
.ah-root .ah-dots i:nth-child(3){animation-delay:.3s}
.ah-root .ah-live-status{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--ah-on-surface-variant)}
.ah-root .ah-live-reason{display:flex;flex-direction:column;border-left:2px solid color-mix(in srgb,var(--ah-primary) 45%,transparent);padding-left:10px}
.ah-root .ah-live-reason.is-streaming{border-left-color:var(--ah-primary)}
.ah-root .ah-live-reason-toggle{display:inline-flex;align-items:center;gap:6px;align-self:flex-start;height:24px;padding:0 6px 0 2px;border:0;border-radius:var(--ah-r-sm);background:transparent;font-size:12px;font-weight:500;color:var(--ah-on-surface-variant)}
.ah-root .ah-live-reason-body{margin:4px 0 0;max-height:160px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-family:inherit;font-size:12.5px;line-height:1.5;font-style:italic;color:var(--ah-on-surface-variant);-webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 24px);mask-image:linear-gradient(to bottom,transparent 0,#000 24px)}
.ah-root .ah-live-tools-wrap{display:flex;flex-direction:column;gap:4px;align-items:flex-start}
.ah-root .ah-live-tools{display:flex;flex-direction:column;gap:2px;width:100%}
.ah-root .ah-live-tools>*{flex-shrink:0}
.ah-root .ah-lt{position:relative;display:flex;align-items:center;gap:8px;min-height:28px;padding:2px 8px;border-radius:var(--ah-r-sm);background:var(--ah-surface-low);overflow:hidden;animation:ah-slide-in .2s ease-out}
.ah-root .ah-lt.is-run{background:color-mix(in srgb,var(--ah-primary) 8%,var(--ah-surface-low))}
.ah-root .ah-lt-state{display:inline-flex;flex:none;color:var(--ah-primary)}
.ah-root .ah-lt.is-done .ah-lt-state{color:var(--ah-ok)}
.ah-root .ah-lt.is-err .ah-lt-state{color:var(--ah-err)}
.ah-root .ah-lt-icon{display:inline-flex;flex:none;color:var(--ah-on-surface-variant)}
.ah-root .ah-lt-name{flex:none;font-size:12.5px;font-weight:500}
.ah-root .ah-lt-ctx{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--ah-on-surface-variant)}
.ah-root .ah-lt-pct,.ah-root .ah-lt-dur{flex:none;font-size:11.5px;color:var(--ah-on-surface-variant);font-variant-numeric:tabular-nums}
.ah-root .ah-lt-bar{position:absolute;left:0;bottom:0;height:2px;width:40%;background:var(--ah-primary);animation:ah-indet 1.3s ease-in-out infinite}
.ah-root .ah-live-text{line-height:1.55;overflow-wrap:anywhere}
.ah-root .ah-live-text.is-typing>.ah-md>*:last-child::after{content:"";display:inline-block;width:7px;height:1.05em;margin-left:2px;vertical-align:-2px;border-radius:1px;background:var(--ah-primary);animation:ah-caret 1s steps(2) infinite}
.ah-root .ah-live-error{font-size:12.5px;color:var(--ah-err)}
.ah-root .ah-auto-tag{flex:none;display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:9px;font-size:10.5px;line-height:14px;font-weight:600;letter-spacing:.02em;background:color-mix(in srgb,var(--ah-warn) 16%,transparent);color:var(--ah-on-warn);border:1px solid color-mix(in srgb,var(--ah-warn) 35%,transparent)}
.ah-root .ah-tg.is-auto{border-left:2px dashed color-mix(in srgb,var(--ah-outline) 60%,transparent);padding-left:6px}
.ah-root .ah-stream-item.is-auto{align-items:flex-start}
.ah-root .ah-automsg{flex:1;min-width:0;max-width:min(110ch,100%);border:1px dashed var(--ah-outline-variant);border-radius:var(--ah-r-md);background:var(--ah-surface-low);color:var(--ah-on-surface-variant)}
.ah-root .ah-automsg-head{display:flex;align-items:center;gap:8px;width:100%;min-height:36px;padding:6px 10px;border:0;border-radius:inherit;background:transparent;text-align:left;font-size:12.5px;line-height:18px}
.ah-root .ah-automsg-label{flex:none;font-weight:500;color:var(--ah-on-surface)}
.ah-root .ah-automsg-sum{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ah-root .ah-automsg-time{flex:none;font-size:11px}
.ah-root .ah-automsg-body{padding:0 10px 10px}
.ah-root .ah-automsg-body .ah-tc-pre{max-height:320px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.ah-root .ah-live-spin{font-size:12px;color:var(--ah-on-surface-variant);animation:ah-breathe 1.6s ease-in-out infinite;transform-origin:left center}
.ah-root .ah-pulse{display:inline-block;width:8px;height:8px;flex:none;border-radius:50%;background:var(--ah-primary);box-shadow:0 0 0 0 color-mix(in srgb,var(--ah-primary) 60%,transparent);animation:ah-pulse 1.4s ease-out infinite}
.ah-root .ah-agent-meta.is-live{color:var(--ah-primary);font-weight:500}

/* side panel */
.ah-root .ah-side{display:flex;flex-direction:column;min-width:0;min-height:0;border-left:1px solid var(--ah-outline-variant);background:var(--ah-surface-low);animation:ah-fade-in .18s ease-out}
.ah-root .ah-side-head{display:flex;align-items:center;gap:4px;min-height:60px;padding:10px 8px 10px 16px;border-bottom:1px solid var(--ah-outline-variant);flex:none}
.ah-root .ah-side-title{font-size:14px;line-height:20px;font-weight:500}
.ah-root .ah-side-body{flex:1;min-height:0;overflow:auto;padding:4px 0 16px}
.ah-root .ah-side-body>*,.ah-root .ah-side-files>*,.ah-root .ah-side-flist>*,.ah-root .ah-side-peers>*,.ah-root .ah-side-ctx>*,.ah-root .ah-side-sec-body>*{flex-shrink:0}
.ah-root .ah-side-sec{display:flex;flex-direction:column;border-bottom:1px solid var(--ah-outline-variant)}
.ah-root .ah-side-sec-head{display:flex;align-items:center;padding:4px 8px}
.ah-root .ah-side-sec-toggle{display:flex;align-items:center;gap:8px;flex:1;height:36px;padding:0 8px;border:0;border-radius:var(--ah-r-sm);background:transparent;color:var(--ah-on-surface);text-align:left}
.ah-root .ah-side-sec-title{flex:1;font-size:13px;font-weight:500}
.ah-root .ah-side-sec-body{display:flex;flex-direction:column;padding:0 8px 10px}
.ah-root .ah-side-empty{padding:4px 12px 8px;font-size:12.5px;color:var(--ah-on-surface-variant)}
.ah-root .ah-side-files{display:flex;flex-direction:column;gap:2px;align-items:stretch;max-height:min(420px,45vh);overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;margin-right:-4px;padding-right:4px}
.ah-root .ah-side-files-wrap{display:flex;flex-direction:column;gap:4px}
.ah-root .ah-approve-bar{display:flex;align-items:center;gap:6px;padding:2px 4px 4px}
.ah-root .ah-side-fitem{display:flex;align-items:center;gap:2px}
.ah-root .ah-side-fitem>.ah-side-file{flex:1;min-width:0}
.ah-root .ah-side-fcheck,.ah-root .ah-approve-all-box{flex:none;margin:0 4px;accent-color:var(--ah-primary)}
.ah-root .ah-approved-note{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ah-root .ah-link{padding:0;border:0;background:none;color:var(--ah-primary);font:inherit;text-decoration:underline;cursor:pointer}
.ah-root .ah-goals{display:flex;flex-direction:column;gap:6px}
.ah-root .ah-sess-bar{display:flex;gap:6px;flex:none;overflow-x:auto;padding:8px 20px;border-bottom:1px solid var(--ah-outline-variant);scrollbar-width:thin}
.ah-root .ah-sess-chip{display:inline-flex;align-items:center;gap:6px;flex:none;max-width:280px;height:30px;padding:0 10px;border:1px solid var(--ah-outline-variant);border-radius:999px;background:transparent;color:inherit;font:inherit;font-size:12.5px;cursor:pointer}
.ah-root .ah-sess-chip.is-on{background:color-mix(in srgb,var(--ah-primary) 14%,transparent);border-color:color-mix(in srgb,var(--ah-primary) 55%,transparent);color:var(--ah-primary)}
.ah-root .ah-sess-chip:disabled{opacity:.5;cursor:default}
.ah-root .ah-sess-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.ah-root .ah-sess-sub{flex:none;font-size:11px;color:var(--ah-on-surface-variant)}
.ah-root .ah-goal-stale{color:var(--ah-warn,#b26a00)}
.ah-root .ah-tool-target{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.ah-root .ah-md-preview{padding:12px 16px;overflow:auto;height:100%;user-select:text;-webkit-user-select:text}
.ah-root .ah-goal-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.ah-root .ah-goal{position:relative;display:flex;align-items:flex-start;gap:4px;border-radius:var(--ah-r-md);padding:2px}
.ah-root .ah-goal.is-current{background:color-mix(in srgb,var(--ah-primary) 10%,transparent);outline:1px solid color-mix(in srgb,var(--ah-primary) 35%,transparent)}
.ah-root .ah-goal-main{flex:1;min-width:0;display:flex;align-items:flex-start;gap:8px;padding:6px;border:0;background:transparent;color:inherit;text-align:left;border-radius:var(--ah-r-md);cursor:pointer}
.ah-root .ah-goal-main:disabled{cursor:default}
.ah-root .ah-goal-ico{flex:none;margin-top:3px}
.ah-root .ah-goal.is-current .ah-goal-ico{color:var(--ah-primary)}
.ah-root .ah-goal.is-done .ah-goal-ico{color:var(--ah-ok,#2e7d32)}
.ah-root .ah-goal.is-done .ah-goal-title,.ah-root .ah-goal.is-dropped .ah-goal-title{text-decoration:line-through;opacity:.7}
.ah-root .ah-goal-body{display:flex;flex-direction:column;min-width:0;gap:1px}
.ah-root .ah-goal-tag{align-self:flex-start;font-size:11px;font-weight:600;color:var(--ah-primary)}
.ah-root .ah-goal-title{font-size:13px;line-height:18px;overflow-wrap:anywhere}
.ah-root .ah-goal-meta{font-size:11px;color:var(--ah-on-surface-variant)}
.ah-root .ah-goal-acts{display:flex;gap:0;opacity:0;transition:opacity .12s ease;padding-top:2px}
.ah-root .ah-goal:hover .ah-goal-acts,.ah-root .ah-goal:focus-within .ah-goal-acts{opacity:1}
.ah-root .ah-goal.is-editing{align-items:center;padding:4px}
.ah-root .ah-goal-input{flex:1;min-width:0;padding:6px 8px;border:1px solid var(--ah-outline-variant);border-radius:var(--ah-r-md);background:var(--ah-surface);color:inherit;font:inherit;font-size:13px}
.ah-root .ah-goal-add{display:flex;align-items:center;gap:6px;padding:0 4px;color:var(--ah-on-surface-variant)}
.ah-root .ah-goal-closed{display:flex;flex-direction:column;gap:2px}
.ah-root .ah-grid-2{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
.ah-root .ah-goal-hist{max-height:360px;overflow-y:auto}
.ah-root .ah-kind-icon.is-goal-done{color:var(--ah-ok,#2e7d32)}
.ah-root .ah-kind-icon.is-goal-delete,.ah-root .ah-kind-icon.is-goal-drop{color:var(--ah-on-surface-variant)}
.ah-root .ah-works-bar{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.ah-root .ah-sched-form{display:flex;flex-direction:column;gap:12px;margin-bottom:16px;padding:16px;border:1px solid var(--ah-outline-variant);border-radius:var(--ah-r-lg);background:var(--ah-surface-container)}
.ah-root .ah-sched-head{display:flex;align-items:center;gap:8px}
.ah-root .ah-sched-head h3{margin:0;font-size:15px;font-weight:600}
.ah-root .ah-sched-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.ah-root .ah-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.ah-root .ah-field-label{font-size:12px;font-weight:600;color:var(--ah-on-surface-variant)}
.ah-root .ah-field-hint{font-size:11px;color:var(--ah-on-surface-variant)}
.ah-root .ah-input{width:100%;box-sizing:border-box;padding:7px 10px;border:1px solid var(--ah-outline-variant);border-radius:var(--ah-r-md);background:var(--ah-surface);color:var(--ah-on-surface);font:inherit;font-size:13px}
.ah-root .ah-input:focus{outline:2px solid color-mix(in srgb,var(--ah-primary) 55%,transparent);outline-offset:-1px}
.ah-root .ah-sched-prompt{resize:vertical;min-height:84px;line-height:20px}
.ah-root .ah-sched-expr{padding:7px 10px;border-radius:var(--ah-r-md);background:var(--ah-surface-high);font-size:13px}
.ah-root .ah-steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.ah-root .ah-step-head{display:flex;align-items:center;gap:6px;width:100%;padding:3px 4px;border:0;background:transparent;color:inherit;text-align:left;border-radius:var(--ah-r-sm,6px);cursor:pointer;font-size:13px}
.ah-root .ah-step-n{flex:none;font-weight:600;font-size:12px;color:var(--ah-on-surface-variant)}
.ah-root .ah-step-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ah-root .ah-step-tools{flex:none;font-size:12px;color:var(--ah-on-surface-variant)}
.ah-root .ah-step-body{padding:2px 0 4px 18px}
.ah-root .ah-steps.is-done .ah-step-head{color:var(--ah-on-surface-variant)}
.ah-root .ah-live-steps{display:flex;flex-direction:column;gap:6px}
.ah-root .ah-step-cur{display:flex;flex-direction:column;gap:6px;padding:6px 8px;border-radius:var(--ah-r-md);background:var(--ah-surface-high)}
.ah-root .ah-step-cur.is-active{outline:1px solid color-mix(in srgb,var(--ah-primary) 35%,transparent)}
.ah-root .ah-step-cur-head{display:flex;align-items:center;gap:8px;min-width:0}
.ah-root .ah-step-label.is-shimmer{background:linear-gradient(90deg,var(--ah-on-surface) 0%,var(--ah-primary) 50%,var(--ah-on-surface) 100%);background-size:200% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:ah-shimmer 2.2s linear infinite}
@media (prefers-reduced-motion:reduce){.ah-root .ah-step-label.is-shimmer{animation:none;color:var(--ah-on-surface);background:none}}
.ah-root .ah-avatar.is-face{overflow:visible;background:color-mix(in srgb,var(--ah-ac) 70%,#fff 30%)}
.ah-root .ah-avatar.is-face .ah-face{width:100%;height:100%;border-radius:50%;overflow:hidden;display:block}
.ah-root .ah-face .ah-f-head{transform-origin:20px 30px}
.ah-root .ah-face .ah-f-eyes{transform-origin:20px 22px;animation:ah-blink 5.2s infinite}
.ah-root .ah-face.is-happy .ah-f-eyes,.ah-root .ah-face.is-sleep .ah-f-eyes,.ah-root .ah-face.is-working .ah-f-eyes{animation:none}
.ah-root .ah-face.is-working .ah-f-head{animation:ah-face-bob 1.1s ease-in-out infinite}
.ah-root .ah-face.is-working .ah-f-key{animation:ah-face-key .5s steps(2) infinite}
.ah-root .ah-face.is-working .ah-f-key+.ah-f-key{animation-delay:.25s}
.ah-root .ah-face.is-happy .ah-f-head{animation:ah-face-nod 2.4s ease-in-out infinite}
.ah-root .ah-face.is-thinking .ah-f-head{animation:ah-face-tilt 3s ease-in-out infinite}
.ah-root .ah-face .ah-f-dot{fill:#fff;stroke:#2B2B33;stroke-width:.6;animation:ah-face-dot 1.5s ease-in-out infinite;opacity:.2}
.ah-root .ah-face .ah-f-dot:nth-child(2){animation-delay:.25s}
.ah-root .ah-face .ah-f-dot:nth-child(3){animation-delay:.5s}
.ah-root .ah-face .ah-f-q{transform-origin:33px 7px;animation:ah-face-pop 1.6s ease-in-out infinite}
.ah-root .ah-face .ah-f-z{animation:ah-face-z 2.6s ease-in-out infinite}
.ah-root .ah-avatar.mood-sleep{filter:grayscale(.6);opacity:.8}
@keyframes ah-blink{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(.12)}}
@keyframes ah-face-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(.8px) rotate(-1.5deg)}}
@keyframes ah-face-key{from{opacity:1}to{opacity:.25}}
@keyframes ah-face-nod{0%,100%{transform:rotate(0)}30%{transform:rotate(-4deg)}60%{transform:rotate(3deg)}}
@keyframes ah-face-tilt{0%,100%{transform:rotate(0)}50%{transform:rotate(6deg)}}
@keyframes ah-face-dot{0%,100%{opacity:.2}50%{opacity:1}}
@keyframes ah-face-pop{0%,100%{transform:scale(1)}50%{transform:scale(1.18)}}
@keyframes ah-face-z{0%{opacity:0;transform:translate(0,2px)}50%{opacity:1}100%{opacity:0;transform:translate(2px,-3px)}}
@media (prefers-reduced-motion:reduce){.ah-root .ah-face *{animation:none!important}}
.ah-root .ah-work-row{display:flex;align-items:flex-start;gap:inherit;flex:1;min-width:0;gap:12px}
.ah-root .ah-agent-cmds{display:inline-flex;align-items:center;gap:3px;margin-left:auto;padding:1px 6px;border-radius:999px;font-size:11px;font-weight:600;background:color-mix(in srgb,var(--ah-primary) 14%,transparent);color:var(--ah-primary)}
.ah-root .ah-cmds{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;max-height:min(320px,40vh);overflow-y:auto}
.ah-root .ah-cmd-row{display:flex;align-items:center;gap:6px;width:100%;padding:5px 6px;border:0;background:transparent;color:inherit;text-align:left;border-radius:var(--ah-r-md);cursor:pointer;font-size:12px}
.ah-root .ah-cmd-item.is-open .ah-cmd-row{background:var(--ah-surface-high)}
.ah-root .ah-cmd-live{flex:none;width:7px;height:7px;border-radius:50%;background:var(--ah-ok,#2e7d32);animation:ah-face-dot 1.4s ease-in-out infinite}
.ah-root .ah-cmd-vis{flex:none;color:var(--ah-on-surface-variant)}
.ah-root .ah-cmd-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ah-root .ah-cmd-detail{display:flex;flex-direction:column;gap:6px;padding:4px 6px 8px 26px}
.ah-root .ah-cmd-full,.ah-root .ah-cmd-out{margin:0;padding:6px 8px;border-radius:var(--ah-r-sm,6px);background:var(--ah-surface-high);font-size:12px;line-height:17px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto}
.ah-root .ah-cmd-out{background:#15161b;color:#d8dbe2}
.ah-root .ah-cmd-meta{margin:0;font-size:11px;color:var(--ah-on-surface-variant);overflow-wrap:anywhere}
.ah-root .ah-approvals{display:flex;flex-direction:column;gap:8px;margin:8px 0 4px 44px;max-width:min(110ch,calc(100% - 44px))}
.ah-root .ah-approval{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:var(--ah-r-lg);border:1px solid color-mix(in srgb,#FFB020 60%,transparent);background:color-mix(in srgb,#FFB020 9%,var(--ah-surface-container))}
.ah-root .ah-approval-head{display:flex;align-items:center;gap:8px;font-size:13px}
.ah-root .ah-approval-cmd{margin:0;padding:6px 8px;border-radius:var(--ah-r-sm,6px);background:var(--ah-surface-high);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto}
.ah-root .ah-approval-why{margin:0;font-size:13px;color:var(--ah-on-surface-variant)}
.ah-root .ah-approval-acts{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ah-root .ah-btn-danger{color:var(--ah-error,#b3261e)}
.ah-root .ah-allow-chip{display:flex;align-items:center;gap:6px;margin:0;font-size:12px;color:var(--ah-on-surface-variant)}
.ah-root .ah-more{display:flex;align-items:center;justify-content:center;gap:6px;padding:6px 0}
.ah-root .ah-peer-go{flex:none;align-self:center;color:var(--ah-on-surface-variant);opacity:.6}
.ah-root .ah-peer:hover .ah-peer-go{opacity:1}
.ah-root .ah-user-foot{display:flex;align-items:center;gap:4px}
.ah-root .ah-user-edit{opacity:0;transition:opacity .12s ease}
.ah-root .ah-stream-item.is-user:hover .ah-user-edit,.ah-root .ah-user-edit:focus-visible{opacity:1}
.ah-root .ah-stream-item.is-user.is-editing{align-items:stretch}
.ah-root .ah-edit{display:flex;flex-direction:column;gap:8px;width:min(90ch,100%);align-self:flex-end;padding:10px 12px;border-radius:var(--ah-r-lg);border:1px solid color-mix(in srgb,var(--ah-primary) 45%,transparent);background:var(--ah-surface-container)}
.ah-root .ah-edit-input{flex:none;width:100%;min-height:48px;max-height:368px;resize:none;border:0;outline:0;background:transparent;color:inherit;font:inherit;line-height:24px;overflow-y:auto}
.ah-root .ah-edit-warn{display:flex;align-items:center;gap:6px;margin:0;font-size:12px;color:var(--ah-on-surface-variant)}
.ah-root .ah-edit-files{display:flex;flex-direction:column;gap:4px;padding-top:6px;border-top:1px solid var(--ah-outline-variant)}
.ah-root .ah-edit-files-head{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600}
.ah-root .ah-edit-flist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;max-height:200px;overflow-y:auto}
.ah-root .ah-edit-file{display:flex;align-items:center;gap:8px;padding:3px 4px;border-radius:var(--ah-r-sm,6px);font-size:13px;cursor:pointer}
.ah-root .ah-edit-file.is-off{opacity:.65;cursor:default}
.ah-root .ah-edit-method{margin-left:auto;font-size:12px;color:var(--ah-on-surface-variant);white-space:nowrap}
.ah-root .ah-edit-method.is-warn{color:var(--ah-error,#b3261e)}
.ah-root .ah-edit-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ah-root .ah-stream-item.is-work{align-items:flex-start}
.ah-root .ah-work-col{flex:1;min-width:0;max-width:min(110ch,100%);display:flex;flex-direction:column;gap:8px}
.ah-root .ah-work{display:flex;flex-direction:column;gap:6px;padding:8px 12px;border-radius:4px var(--ah-r-lg) var(--ah-r-lg) var(--ah-r-lg);background:var(--ah-surface-container);border:1px dashed var(--ah-outline-variant)}
.ah-root .ah-work.is-active{border-style:solid;border-color:color-mix(in srgb,var(--ah-primary) 30%,transparent)}
.ah-root .ah-work-head{display:flex;align-items:center;gap:8px;width:100%;padding:0;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer}
.ah-root .ah-work-titles{display:flex;flex-direction:column;min-width:0;flex:1}
.ah-root .ah-work-label{font-size:12px;font-weight:600;color:var(--ah-on-surface-variant)}
.ah-root .ah-work-title{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ah-root .ah-work-steps{max-height:280px;overflow-y:auto}
.ah-root .ah-work-say{display:flex;gap:6px;align-items:flex-start;padding:2px 0;font-size:13px;color:var(--ah-on-surface)}
.ah-root .ah-work-say.is-ask{color:var(--ah-on-surface-variant)}
.ah-root .ah-work-say>span{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.ah-root .ah-side-files>.ah-btn{align-self:flex-start}
.ah-root .ah-side-dir{display:flex;flex-direction:column}
.ah-root .ah-side-dir-head{display:flex;align-items:center;gap:6px;width:100%;height:30px;padding:0 8px;border:0;border-radius:var(--ah-r-sm);background:transparent;color:var(--ah-on-surface-variant);text-align:left}
.ah-root .ah-side-dir-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.ah-root .ah-side-dir-n{font-size:11px;color:var(--ah-on-surface-variant)}
.ah-root .ah-side-flist{display:flex;flex-direction:column;gap:1px;padding-left:18px}
.ah-root .ah-side-file{display:flex;align-items:center;gap:8px;width:100%;height:30px;padding:0 8px;border:0;border-radius:var(--ah-r-sm);background:transparent;text-align:left;font-size:12.5px}
.ah-root .ah-side-file.is-selected{background:var(--ah-secondary-container);color:var(--ah-on-primary-container)}
.ah-root .ah-side-file-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ah-root .ah-side-file-warn{display:inline-flex;color:var(--ah-warn)}
.ah-root .ah-side-time{font-size:11px;color:var(--ah-on-surface-variant);white-space:nowrap}
.ah-root .ah-side-peers,.ah-root .ah-side-ctx{display:flex;flex-direction:column;gap:2px}
.ah-root .ah-peer{display:flex;align-items:center;gap:4px;border-radius:var(--ah-r-md)}
.ah-root .ah-peer.is-live{background:color-mix(in srgb,var(--ah-primary) 7%,transparent)}
.ah-root .ah-peer>.ah-peer-av{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;margin:6px 4px 6px 8px;border-radius:50%;background:var(--ah-primary-container);color:var(--ah-on-primary-container)}
.ah-root .ah-peer>.ah-peer-body{padding:6px 0}
.ah-root .ah-peer-main{display:flex;align-items:flex-start;gap:10px;flex:1;min-width:0;padding:8px;border:0;border-radius:var(--ah-r-md);background:transparent;text-align:left}
.ah-root .ah-peer-body{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.ah-root .ah-peer-name{display:flex;align-items:baseline;flex-wrap:wrap;gap:6px;font-size:13px;font-weight:500}
.ah-root .ah-peer-dir{font-size:11px;font-weight:400;color:var(--ah-on-surface-variant)}
.ah-root .ah-peer-dir.is-out{color:var(--ah-primary)}
.ah-root .ah-peer-count{font-size:11px;font-weight:400;color:var(--ah-on-surface-variant)}
.ah-root .ah-peer-task{font-size:12.5px;line-height:18px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.ah-root .ah-peer-doing{display:flex;align-items:center;gap:6px;font-size:12px;line-height:16px;color:var(--ah-on-surface-variant);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ah-root .ah-peer-doing.is-active{color:var(--ah-primary)}
.ah-root .ah-ctx{display:flex;align-items:center;gap:10px;padding:6px 4px 6px 10px;border-radius:var(--ah-r-sm)}
.ah-root .ah-ctx.is-missing{opacity:.6}
.ah-root .ah-ctx-icon{display:inline-flex;flex:none;color:var(--ah-on-surface-variant)}
.ah-root .ah-ctx-body{display:flex;flex-direction:column;min-width:0;flex:1}
.ah-root .ah-ctx-label{font-size:12px;line-height:16px;color:var(--ah-on-surface-variant)}
.ah-root .ah-ctx-path{font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.ah-root .ah-side-preview{display:flex;flex-direction:column;min-height:0;height:100%}
.ah-root .ah-side-pv-head{display:flex;align-items:center;gap:8px;min-height:60px;padding:8px 8px;border-bottom:1px solid var(--ah-outline-variant);flex:none}
.ah-root .ah-side-pv-titles{display:flex;flex-direction:column;min-width:0;flex:1}
.ah-root .ah-side-pv-name{font-size:14px;line-height:20px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ah-root .ah-side-pv-path{font-size:11.5px;line-height:16px;color:var(--ah-on-surface-variant);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.ah-root .ah-side-pv-bar{display:flex;align-items:center;gap:8px;padding:8px 8px 4px 12px;flex:none}
.ah-root .ah-side-pv-meta{padding:0 12px 8px;font-size:11.5px;color:var(--ah-on-surface-variant);flex:none}
.ah-root .ah-side-pv-body{display:flex;flex-direction:column;flex:1;min-height:0;border-top:1px solid var(--ah-outline-variant);background:var(--ah-surface)}
.ah-root .ah-seg{display:inline-flex;padding:2px;border-radius:var(--ah-r-xl);background:var(--ah-surface-high)}
.ah-root .ah-seg-btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border:0;border-radius:var(--ah-r-xl);background:transparent;font-size:12.5px;font-weight:500;color:var(--ah-on-surface-variant)}
.ah-root .ah-seg-btn.is-on{background:var(--ah-surface);color:var(--ah-on-surface);box-shadow:0 1px 2px color-mix(in srgb,#000 18%,transparent)}
.ah-root .ah-code .ah-dl{grid-template-columns:48px minmax(0,1fr)}

@keyframes ah-spin{to{transform:rotate(360deg)}}
@keyframes ah-ring{0%{transform:scale(.92);opacity:.9}100%{transform:scale(1.35);opacity:0}}
@keyframes ah-breathe{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.12);opacity:.75}}
@keyframes ah-dot{0%,80%,100%{transform:translateY(0);opacity:.35}40%{transform:translateY(-4px);opacity:1}}
@keyframes ah-text-shimmer{from{background-position:100% 0}to{background-position:-150% 0}}
@keyframes ah-caret{0%{opacity:1}100%{opacity:0}}
@keyframes ah-indet{0%{transform:translateX(-100%)}100%{transform:translateX(260%)}}
@keyframes ah-pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--ah-primary) 55%,transparent)}100%{box-shadow:0 0 0 8px transparent}}
@keyframes ah-slide-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes ah-pop-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes ah-fade-in{from{opacity:0}to{opacity:1}}

@container (max-width:1099px){
  .ah-root .ah-chat.has-panel.has-side{grid-template-columns:minmax(0,1fr) 300px}
  .ah-root .ah-chat.has-panel.has-side .ah-chat-main{display:flex}
  .ah-root .ah-chat.has-side.is-wide{grid-template-columns:minmax(0,1fr)}
  .ah-root .ah-chat.has-side.is-wide .ah-side{position:absolute;top:0;right:0;bottom:0;z-index:1;width:min(640px,96%);box-shadow:-8px 0 24px color-mix(in srgb,#000 20%,transparent)}
  .ah-root .ah-hide-sm{display:none}
}
@container (max-width:760px){
  .ah-root .ah-chat.has-panel.has-side{grid-template-columns:minmax(0,1fr)}
  .ah-root .ah-chat.has-side .ah-side{position:absolute;top:0;right:0;bottom:0;z-index:1;width:min(400px,92%);box-shadow:-8px 0 24px color-mix(in srgb,#000 20%,transparent)}
}
@container (max-width:700px){
  .ah-root .ah-chat-col{padding:16px 14px 10px}
  .ah-root .ah-composer-wrap{padding:8px 12px 12px}
  .ah-root .ah-model-name{max-width:110px}
}

@media (prefers-reduced-motion:reduce){
  .ah-root *,.ah-root *::before,.ah-root *::after{animation:none !important;transition-duration:.01ms !important;scroll-behavior:auto !important}
}
`

/* ───────────────────────── plugin entry ───────────────────────── */

export default {
  id: PLUGIN_ID,
  name: 'Agents Hub',
  register(ctx) {
    // Every Hub request is pinned to the profile the plugin is enabled in. Desktop otherwise scopes
    // plugin REST calls to whichever profile is active in the sidebar; when that is another agent
    // (marketing, process, ...) the gateway's consent gate answers 404 "Plugin not found" and the Hub
    // looked disconnected. The Hub reads the whole team from the root home, so 'default' is right.
    C = Object.create(ctx)
    C.rest = (path, opts) => ctx.rest(withHubProfile(path), opts)
    S = initialState(ctx.storage.get('ui', null))
    inflight = null
    listeners.clear()

    // Scoped styles, injected once and removed on dispose.
    if (typeof document !== 'undefined' && document.head) {
      const old = document.getElementById(STYLE_ID)

      if (old) {
        old.remove()
      }

      const style = document.createElement('style')

      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.onDispose(() => style.remove())
    }

    ctx.onDispose(() => {
      C = null
      inflight = null
      listeners.clear()
    })

    // Live turn events for the agents' chat sessions (deduped against the replay poll by seq).
    try {
      const off = typeof ctx.onEvent === 'function' ? ctx.onEvent('*', onGatewayEvent) : typeof host.onEvent === 'function' ? host.onEvent('*', onGatewayEvent) : null

      if (typeof off === 'function') {
        ctx.onDispose(off)
      }
    } catch {
      /* older desktop: the replay poll alone drives the live view */
    }

    // Notification clicks for the Hub's agent chats come back to the Hub.
    try {
      const desk = typeof window !== 'undefined' ? window.hermesDesktop : null
      const offFocus = desk && typeof desk.onFocusSession === 'function' ? desk.onFocusSession(id => focusHubChat(id, host.navigate)) : null

      if (typeof offFocus === 'function') {
        ctx.onDispose(offFocus)
      }
    } catch {
      /* no desktop bridge (web dashboard): nothing to route */
    }

    const open = () => host.navigate(HUB_PATH)

    ctx.registerMany([
      { id: 'page', area: ROUTES_AREA, title: 'Agents Hub', data: { path: HUB_PATH }, render: () => jsx(HubPage, {}) },
      { id: 'nav', area: SIDEBAR_NAV_AREA, order: 5, data: { path: HUB_PATH, label: 'Agents Hub', codicon: 'organization' } },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: { id: 'agents-hub.open', label: 'Open Agents Hub', keywords: ['agents', 'hub', 'agent', 'conversations', 'schedules', 'schedule', 'tasks', 'changes'], run: open }
      },
      {
        id: 'open-key',
        area: KEYBINDS_AREA,
        data: { id: 'agents-hub.open', label: 'Open Agents Hub', category: 'Agents Hub', defaults: ['mod+alt+h'], run: open }
      },
      { id: 'theme-hermes-material', area: THEMES_AREA, data: MATERIAL_THEME }
    ])

    if (typeof ctx.registerSettingsPage === 'function') {
      ctx.registerSettingsPage({ id: 'settings', title: 'Agents Hub', icon: 'organization', render: () => jsx(SettingsGeneral, {}) })
    }

    // Warm the cache so the page paints instantly, then restore the last selections.
    void load().then(() => {
      const { conv, repo, file } = S.ui

      if (conv && !S.detail[convKey(conv)] && S.ui.tab === 'conversations') {
        void fetchDetail(conv)
      }

      if (repo && file && S.ui.tab === 'changes' && !S.diff[diffKey(repo, file)]) {
        void fetchDiff(repo, file)
      }
    })
  }
}
