import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Logical, Physical, Topic } from '../types'

const topics = atom({ plugin: 'chatmap', key: 'topics' } as const, {} as Record<string, Topic>)
const topicCount = atom({ plugin: 'chatmap', key: 'topicCount' } as const, 0)
const primary = atom({ plugin: 'chatmap', key: 'primary' } as const, '')
const physical = atom({ plugin: 'chatmap', key: 'physical' } as const, [] as Physical[])
const logical = atom({ plugin: 'chatmap', key: 'logical' } as const, [] as Logical[])
const passes = atom({ plugin: 'chatmap', key: 'passes' } as const, 0)

const CLASSIFIER = 'haiku'
const REORGANISER = 'sonnet'
const EVERY = 10
const RECENT = 4
const REVISABLE = 2
const CHUNK = 30
const SHORT_CHARS = 20
const PROMPT_TEXT = 1500
const ANSWER_EDGE = 600
const TICK_MS = 1000
const PERSON = ['composer', 'bridge', 'sdk']
const PORT_BASE = 41000
const PORT_RANGE = 8000

type ClassifierReply = { assign: string[]; newSubject?: boolean }
type ReorganiserReply = {
  logical: { physical: number[]; label: string; prompt: string; outcome: string; topics: string[]; block: string }[]
  topics: { id: string; title: string; description: string }[]
  merge?: { from: string; into: string }[]
  primary: string
}

function edges(answer: string): string {
  if (answer.length <= 2 * ANSWER_EDGE) return answer
  return `${answer.slice(0, ANSWER_EDGE)}\n[...]\n${answer.slice(-ANSWER_EDGE)}`
}

async function ask($: EngineInterface, model: string, file: string, payload: unknown, maxTokens: number): Promise<unknown> {
  const system = await $.fs.read(`${$.plugin.root}/prompts/${file}`)
  const reply = await $.model.complete({ model, system, prompt: JSON.stringify(payload), maxTokens })
  if (!reply.isAnswered) throw new Error(`${model} did not answer: ${reply.reason}`)
  const start = reply.text.indexOf('{')
  const end = reply.text.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error(`${model} answered no JSON object`)
  return JSON.parse(reply.text.slice(start, end + 1))
}

async function classify($: EngineInterface, turn: Physical): Promise<ClassifierReply> {
  const known = await read($, topics)
  const done = await read($, logical)
  const payload = {
    topics: Object.entries(known).map(([id, topic]) => ({
      id,
      title: topic.title,
      description: topic.description,
      recent: done
        .filter(l => l.topics.includes(id))
        .slice(-RECENT)
        .map(l => ({ prompt: l.prompt, outcome: l.outcome })),
    })),
    turn: { n: turn.n, prompt: turn.prompt, answer: turn.answer, tools: turn.tools },
  }
  const reply = (await ask($, CLASSIFIER, 'classifier.md', payload, 1024)) as ClassifierReply
  const unknown = reply.assign.filter(id => !(id in known))
  if (unknown.length) throw new Error(`classifier named unknown topics ${unknown.join(', ')}`)
  return reply
}

type Placed = { count: number; newSubject: boolean }

async function place($: EngineInterface): Promise<Placed> {
  const queued = (await read($, physical)).filter(p => p.state === 'queued')
  let newSubject = false
  for (const turn of queued) {
    const turns = await read($, physical)
    const previous = turns.find(p => p.n === turn.n - 1)
    let haiku: string[] = []
    let state: Physical['state'] = 'placed'
    if (turn.short && previous) {
      haiku = previous.haiku
      state = previous.state === 'queued' ? 'unclassified' : previous.state
    } else if (Object.keys(await read($, topics)).length === 0) {
      state = 'unclassified'
      newSubject = true
    } else {
      try {
        const reply = await classify($, turn)
        haiku = reply.assign
        state = haiku.length ? 'placed' : 'unclassified'
        newSubject = newSubject || Boolean(reply.newSubject)
      } catch (error) {
        state = 'unclassified'
        $.ui.toast(`turn ${turn.n}: ${(error as Error).message}`)
      }
    }
    await update($, physical, list => list.map(p => (p.n === turn.n ? { ...p, haiku, state } : p)))
  }
  return { count: queued.length, newSubject }
}

async function reorganise($: EngineInterface, full: boolean): Promise<void> {
  const done = full ? [] : await read($, logical)
  const turns = await read($, physical)
  const all = await read($, topics)
  const known = full ? Object.fromEntries(Object.entries(all).filter(([, t]) => t.fixed)) : all
  const covered = done.length ? done[done.length - 1].physical[done[done.length - 1].physical.length - 1] : 0
  const fresh = turns.filter(p => p.n > covered && p.state !== 'running').slice(0, CHUNK)
  if (!fresh.length) return
  const unlabelled = done.findIndex(l => !l.label)
  const from = Math.max(0, unlabelled >= 0 ? Math.min(unlabelled, done.length - REVISABLE) : done.length - REVISABLE)
  const revisable = done.slice(from)
  const kept = done.slice(0, from)
  const span = [...revisable.flatMap(l => l.physical), ...fresh.map(p => p.n)]

  const payload = {
    topics: Object.entries(known).map(([id, t]) => ({ id, title: t.title, description: t.description, fixed: t.fixed })),
    primary: full ? null : (await read($, primary)) || null,
    revisable: revisable.map(({ physical: ns, label, prompt: p, outcome, topics: ts, block }) => ({ physical: ns, label, prompt: p, outcome, topics: ts, block })),
    new: fresh.map(p => ({ n: p.n, prompt: p.prompt, answer: p.answer, tools: p.tools, haiku: p.haiku.length ? p.haiku : null })),
    next_topic_id: `t${(full ? 0 : await read($, topicCount)) + 1}`,
  }
  const reply = (await ask($, REORGANISER, 'reorganizer.md', payload, 16000)) as ReorganiserReply

  const got = reply.logical.flatMap(l => l.physical)
  if (got.join(',') !== span.join(',')) throw new Error(`reorganiser covered turns ${got.join(',')}, expected ${span.join(',')}`)
  const merge = Object.fromEntries((reply.merge ?? []).map(m => [m.from, m.into]))

  const next: Record<string, Topic> = {}
  for (const t of reply.topics) next[t.id] = known[t.id]?.fixed ? known[t.id] : { title: t.title, description: t.description, fixed: false }
  const lost = Object.keys(known).filter(id => known[id].fixed && (id in merge || !(id in next)))
  if (lost.length) throw new Error(`reorganiser dropped topics you edited: ${lost.join(', ')}`)
  const pass = (await read($, passes)) + 1
  const regrouped: Logical[] = reply.logical.map(l => ({
    physical: l.physical,
    label: l.label,
    prompt: l.prompt,
    outcome: l.outcome,
    topics: [...new Set(l.topics)],
    block: l.block,
    pass,
  }))
  const remapped = kept.map(l => ({ ...l, topics: [...new Set(l.topics.map(id => merge[id] ?? id))] }))
  for (const l of [...remapped, ...regrouped]) {
    const unknown = l.topics.filter(id => !(id in next))
    if (unknown.length) throw new Error(`logical turn ${l.physical.join(',')} names unknown topics ${unknown.join(', ')}`)
  }
  if (!(reply.primary in next)) throw new Error(`primary ${reply.primary} is not a topic`)

  const highest = Math.max(full ? 0 : await read($, topicCount), ...Object.keys(next).map(id => Number(id.slice(1)) || 0))
  await update($, topics, () => next)
  await update($, topicCount, () => highest)
  await update($, primary, () => reply.primary)
  await update($, logical, () => [...remapped, ...regrouped])
  await update($, passes, () => pass)
}

async function pending($: EngineInterface): Promise<number> {
  const done = await read($, logical)
  const covered = done.length ? done[done.length - 1].physical[done[done.length - 1].physical.length - 1] : 0
  return (await read($, physical)).filter(p => p.n > covered && p.state !== 'running').length
}

async function snapshot($: EngineInterface): Promise<unknown> {
  const turns = await read($, physical)
  const done = await read($, logical)
  const final = new Map(done.flatMap(l => l.physical.map(n => [n, l.topics] as const)))
  const placed = turns.filter(p => !p.short && p.haiku.length)
  const cwd = await $.session.cwd()
  return {
    version: 2,
    live: true,
    session: await $.session.id(),
    title: cwd.split('/').pop() ?? cwd,
    models: { classifier: CLASSIFIER, reorganiser: REORGANISER },
    primary: await read($, primary),
    topics: await read($, topics),
    logical: done,
    physical: turns,
    agreement: {
      classified: turns.filter(p => !p.short).length,
      placed: placed.length,
      agree: placed.filter(p => p.haiku.every(id => (final.get(p.n) ?? []).includes(id))).length,
    },
  }
}

async function publish($: EngineInterface, lane: Lane): Promise<void> {
  if (!lane.url) return
  await $.http.fetch(`${lane.url}/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await snapshot($)),
  })
}

type Action = { kind: 'reorganise' } | { kind: 'rebuild' } | { kind: 'edit'; id: string; title: string; description: string }

type Mode = 'none' | 'step' | 'full'

async function actions($: EngineInterface, lane: Lane): Promise<Mode> {
  if (!lane.url) return 'none'
  const reply = await $.http.fetch(`${lane.url}/actions`)
  const list = JSON.parse(reply.text) as Action[]
  let mode: Mode = 'none'
  for (const action of list) {
    if (action.kind === 'rebuild') mode = 'full'
    else if (action.kind === 'reorganise') mode = mode === 'full' ? 'full' : 'step'
    else await edit($, action.id, action.title, action.description)
  }
  if (list.length) await publish($, lane)
  return mode
}

async function edit($: EngineInterface, id: string, title: string, description: string): Promise<void> {
  await update($, topics, all => {
    if (!(id in all)) throw new Error(`no topic ${id} to edit`)
    return { ...all, [id]: { title, description, fixed: true } }
  })
}

type Lane = { queue: Promise<void>; url: string; backlog: boolean }

async function step($: EngineInterface, mode: Mode, lane: Lane): Promise<void> {
  const placed = await place($)
  const due = mode !== 'none' || placed.newSubject || (await pending($)) >= EVERY
  if (due) {
    let full = mode === 'full'
    try {
      do {
        await reorganise($, full)
        full = false
        await publish($, lane)
      } while ((await pending($)) >= (mode === 'none' && !placed.newSubject ? EVERY : 1))
    } catch (error) {
      $.ui.toast(`reorganisation failed: ${(error as Error).message}`)
    }
  }
  if (placed.count || due) await publish($, lane)
}

function work($: EngineInterface, mode: Mode, lane: Lane): Promise<void> {
  lane.queue = lane.queue.then(async () => {
    const asked = await actions($, lane)
    const backlog = lane.backlog
    lane.backlog = false
    return step($, asked === 'full' || mode === 'full' ? 'full' : asked === 'step' || mode === 'step' || backlog ? 'step' : 'none', lane)
  })
  return lane.queue
}

function portOf(session: string): number {
  let hash = 0
  for (const char of session) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return PORT_BASE + (hash % PORT_RANGE)
}

async function importHistory($: EngineInterface): Promise<number> {
  if ((await read($, physical)).length) return 0
  const turns: Physical[] = []
  for (const message of await $.session.messages()) {
    const text = message.text.trim()
    if (message.role === 'user' && !message.toolResults?.length && text && !text.startsWith('<')) {
      turns.push({ n: turns.length + 1, prompt: text.slice(0, PROMPT_TEXT), answer: '', tools: [], short: false, haiku: [], state: 'unclassified' })
      continue
    }
    const turn = turns[turns.length - 1]
    if (!turn || message.role !== 'assistant') continue
    if (text) turn.answer = edges(text)
    turn.tools.push(...message.toolUses.map(use => use.tool))
  }
  for (const turn of turns) {
    turn.tools = [...new Set(turn.tools)]
    turn.short = turn.n > 1 && turn.tools.length === 0 && turn.prompt.length < SHORT_CHARS
  }
  if (turns.length) await update($, physical, () => turns)
  return turns.length
}

async function dropNotifications($: EngineInterface): Promise<void> {
  const noise = new Set((await read($, physical)).filter(p => p.prompt.startsWith('<task-notification>')).map(p => p.n))
  if (!noise.size) return
  await update($, physical, list => list.filter(p => !noise.has(p.n)))
  await update($, logical, list =>
    list.map(l => ({ ...l, physical: l.physical.filter(n => !noise.has(n)) })).filter(l => l.physical.length > 0),
  )
}

async function serve($: EngineInterface, lane: Lane): Promise<void> {
  const server = $.process.spawn({
    argv: ['python3', `${$.plugin.root}/server/chatmap_server.py`, '--root', $.plugin.root, '--port', String(portOf(await $.session.id()))],
  })
  for await (const { stream, text } of server) {
    const found = text.match(/chatmap on (http:\/\/127\.0\.0\.1:\d+)/)
    if (found) {
      lane.url = found[1]
      await publish($, lane)
    } else if (stream === 'stderr') {
      $.ui.log(text, { to: 'debug' })
    }
  }
  lane.url = ''
  $.ui.toast('chatmap server stopped')
}

export const register: Register = on => {
  let tools: string[] = []
  const lane: Lane = { queue: Promise.resolve(), url: '', backlog: false }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'chatmap', description: 'Reorganise this conversation (full: rebuild from scratch) and show the URL of its map', argumentHint: '[full]' })
    await dropNotifications($)
    lane.backlog = (await importHistory($)) > 0
    void serve($, lane)
    $.clock.every(TICK_MS, () => {
      void work($, 'none', lane)
    })
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.text.startsWith('/') || !PERSON.includes(e.origin.kind)) return next(e)
    const turns = await read($, physical)
    const running = turns.find(p => p.state === 'running')
    if (e.turnId !== undefined && running) {
      const added = `${running.prompt}\n\n[during the turn] ${e.text}`.slice(0, PROMPT_TEXT)
      await update($, physical, list => list.map(p => (p.n === running.n ? { ...p, prompt: added } : p)))
      await publish($, lane)
      return next(e)
    }
    tools = []
    const turn: Physical = {
      n: turns.length ? turns[turns.length - 1].n + 1 : 1,
      prompt: e.text.slice(0, PROMPT_TEXT),
      answer: '',
      tools: [],
      short: false,
      haiku: [],
      state: 'running',
    }
    await update($, physical, list => [...list, turn])
    await publish($, lane)
    return next(e)
  })

  on('tool.call', ($, e, next) => {
    if (e.agentId === undefined) tools.push(e.tool)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    const running = (await read($, physical)).find(p => p.state === 'running')
    if (!running) return result
    const done: Physical = {
      ...running,
      answer: edges(e.answer),
      tools: [...new Set(tools)],
      short: running.n > 1 && tools.length === 0 && running.prompt.length < SHORT_CHARS,
      state: 'queued',
    }
    await update($, physical, list => list.map(p => (p.n === done.n ? done : p)))
    await publish($, lane)
    return result
  })

  on('command.run', { command: 'chatmap' }, async ($, e) => {
    await work($, e.args.trim() === 'full' ? 'full' : 'step', lane)
    const done = await read($, logical)
    const all = await read($, topics)
    if (lane.url) {
      void $.prompt.submit({
        text: `Open ${lane.url} in the Browser pane beside the chat: it is the chatmap of this conversation. Answer with one short line.`,
      })
    }
    return { text: `${(await read($, physical)).length} physical turns, ${done.length} logical turns, ${Object.keys(all).length} topics. Map: ${lane.url || 'server not started'}` }
  })
}
