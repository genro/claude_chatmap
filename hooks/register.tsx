import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Logical, Physical, Spent, Topic } from '../types'

const topics = atom({ plugin: 'chatmap', key: 'topics' } as const, {} as Record<string, Topic>)
const topicCount = atom({ plugin: 'chatmap', key: 'topicCount' } as const, 0)
const primary = atom({ plugin: 'chatmap', key: 'primary' } as const, '')
const physical = atom({ plugin: 'chatmap', key: 'physical' } as const, [] as Physical[])
const logical = atom({ plugin: 'chatmap', key: 'logical' } as const, [] as Logical[])
const passes = atom({ plugin: 'chatmap', key: 'passes' } as const, 0)
const usage = atom({ plugin: 'chatmap', key: 'usage' } as const, {} as Record<string, Spent>)
const enabled = atom({ plugin: 'chatmap', key: 'enabled' } as const, false)
const linked = atom({ plugin: 'chatmap', key: 'linked' } as const, true)
const host = atom({ plugin: 'chatmap', key: 'host' } as const, '')
const working = atom({ plugin: 'chatmap', key: 'working' } as const, false)

const CLASSIFIER = 'haiku'
const REORGANISER = 'sonnet'
const EVERY = 10
const RECENT = 4
const REVISABLE = 2
const CHUNK = 30
const RETRY_MS = 300000
const SHORT_CHARS = 20
const PROMPT_TEXT = 1500
const ANSWER_EDGE = 600
const TICK_MS = 1000
const PERSON = ['composer', 'bridge', 'sdk']
const SLASH = /^\/[\w:-]+(\s|$)/
const LINK = 'http://127.0.0.1:40999'
const OWN = 'http://127.0.0.1:40998'
const HOST_RETRY_MS = 10000
const MATCH_CHARS = 200
const DURING = '[during the turn]'

type Saved = {
  topics: Record<string, Topic>
  topicCount: number
  primary: string
  physical: Physical[]
  logical: Logical[]
  passes: number
  usage?: Record<string, Spent>
  enabled?: boolean
}

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
  const used = reply.usage
  await update($, usage, all => {
    const was = all[model] ?? { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    return {
      ...all,
      [model]: {
        calls: was.calls + 1,
        input: was.input + used.input_tokens,
        output: was.output + used.output_tokens,
        cacheRead: was.cacheRead + used.cache_read_input_tokens,
        cacheWrite: was.cacheWrite + used.cache_creation_input_tokens,
      },
    }
  })
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

  for (const l of reply.logical) l.physical.sort((a, b) => a - b)
  reply.logical.sort((a, b) => a.physical[0] - b.physical[0])
  // A physical turn the reorganiser put in two logical turns stays in the first one.
  const used = new Set<number>()
  for (const l of reply.logical) {
    l.physical = l.physical.filter(n => !used.has(n))
    for (const n of l.physical) used.add(n)
  }
  reply.logical = reply.logical.filter(l => l.physical.length > 0)
  const at = new Map(span.map((n, i) => [n, i]))
  const split = reply.logical.find(l => l.physical.some((n, i) => i > 0 && at.has(n) && at.has(l.physical[i - 1]) && at.get(n) !== at.get(l.physical[i - 1])! + 1))
  if (split) throw new Error(`reorganiser grouped non-consecutive turns ${split.physical.join(',')}`)
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
    usage: await read($, usage),
    primary: await read($, primary),
    topics: await read($, topics),
    topicCount: await read($, topicCount),
    passes: await read($, passes),
    enabled: await read($, enabled),
    working: await read($, working),
    logical: done,
    physical: turns,
    agreement: {
      classified: turns.filter(p => !p.short).length,
      placed: placed.length,
      agree: placed.filter(p => p.haiku.every(id => (final.get(p.n) ?? []).includes(id))).length,
    },
  }
}

async function link($: EngineInterface, path: string, body?: unknown): Promise<unknown> {
  const init = body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  let reply
  try {
    reply = await $.http.fetch(`${await read($, host)}/sessions/${await $.session.id()}${path}`, init)
  } catch {
    reply = null
  }
  const up = reply !== null && reply.ok
  if ((await read($, linked)) !== up) await update($, linked, () => up)
  if (!reply || !reply.ok) throw new Error(`the chatmap host does not answer on ${await read($, host)}`)
  return JSON.parse(reply.text)
}

async function restore($: EngineInterface, saved: Saved | null): Promise<boolean> {
  if ((await read($, physical)).length) return true
  if (!saved) return false
  await update($, topics, () => saved.topics)
  await update($, topicCount, () => saved.topicCount)
  await update($, primary, () => saved.primary)
  await update($, physical, () => saved.physical.map(p => (p.state === 'running' ? { ...p, state: 'queued' } : p)))
  await update($, logical, () => saved.logical)
  await update($, passes, () => saved.passes)
  await update($, usage, () => saved.usage ?? {})
  return true
}

async function publish($: EngineInterface): Promise<void> {
  try {
    await link($, '/state', await snapshot($))
  } catch {
    // the footer shows `link off`; the next publish sends the whole map again
  }
}

type Action = { kind: 'reorganise' } | { kind: 'rebuild' } | { kind: 'edit'; id: string; title: string; description: string }

type Mode = 'none' | 'step' | 'full'

async function actions($: EngineInterface): Promise<Mode> {
  let list: Action[]
  try {
    list = (await link($, '/inbox')) as Action[]
  } catch {
    return 'none'
  }
  let mode: Mode = 'none'
  for (const action of list) {
    if (action.kind === 'rebuild') mode = 'full'
    else if (action.kind === 'reorganise') mode = mode === 'full' ? 'full' : 'step'
    else await edit($, action.id, action.title, action.description)
  }
  if (list.length) await publish($)
  return mode
}

async function edit($: EngineInterface, id: string, title: string, description: string): Promise<void> {
  await update($, topics, all => {
    if (!(id in all)) throw new Error(`no topic ${id} to edit`)
    return { ...all, [id]: { title, description, fixed: true } }
  })
}

type Lane = { queue: Promise<void>; url: string; backlog: boolean; failedAt: number; hostTriedAt: number; fullDue: boolean; tick?: Timer }

async function step($: EngineInterface, mode: Mode, lane: Lane): Promise<void> {
  const placed = await place($)
  const resting = mode === 'none' && (await $.clock.now()) - lane.failedAt < RETRY_MS
  const due = mode !== 'none' || (!resting && (placed.newSubject || (await pending($)) >= EVERY))
  if (due) {
    await update($, working, () => true)
    await publish($)
    let full = mode === 'full'
    try {
      do {
        await reorganise($, full)
        full = false
        await publish($)
      } while ((await pending($)) >= (mode === 'none' && !placed.newSubject ? EVERY : 1))
    } catch (error) {
      lane.failedAt = await $.clock.now()
      $.ui.toast(`reorganisation failed, next automatic try in ${RETRY_MS / 60000} minutes: ${(error as Error).message}`)
    } finally {
      await update($, working, () => false)
    }
  }
  if (placed.count || due) await publish($)
}

function work($: EngineInterface, mode: Mode, lane: Lane): Promise<void> {
  lane.queue = lane.queue.then(async () => {
    if (!(await read($, linked)) && (await $.clock.now()) - lane.hostTriedAt > HOST_RETRY_MS) {
      try {
        await findHost($, lane)
        await publish($)
      } catch {
        // tried again after HOST_RETRY_MS; the footer reads `host off` meanwhile
      }
    }
    const asked = await actions($)
    const backlog = lane.backlog
    const fullDue = lane.fullDue
    lane.backlog = false
    lane.fullDue = false
    return step($, asked === 'full' || mode === 'full' || fullDue ? 'full' : asked === 'step' || mode === 'step' || backlog ? 'step' : 'none', lane)
  })
  return lane.queue
}

type Imported = { n: number; prompt: string; answer: string; tools: string[] }

async function pastTurns($: EngineInterface): Promise<Imported[] | null> {
  const run = await $.process.run(
    ['python3', `${$.plugin.root}/tools/classify_offline.py`, '--dump-turns', await $.session.id()],
    { timeoutMs: 120000 },
  )
  if (run.exitCode !== 0) {
    $.ui.toast(`chatmap could not read past turns: ${run.stderr.trim().split('\n').pop()}`)
    return null
  }
  return JSON.parse(run.stdout) as Imported[]
}

function imported(t: Imported): Physical {
  return { ...t, short: t.n > 1 && t.tools.length === 0 && t.prompt.length < SHORT_CHARS, haiku: [], state: 'unclassified' }
}

async function reconcile($: EngineInterface, lane: Lane): Promise<void> {
  const past = await pastTurns($)
  if (!past) return
  const turns = await read($, physical)
  if (!turns.length) {
    if (past.length) {
      await update($, physical, () => past.map(imported))
      lane.backlog = true
    }
    return
  }
  // Align recorded turns with the transcript in order (longest common subsequence of the prompts' starts).
  // A recorded turn the transcript lacks (a message queued and then removed) is dropped; text typed during a turn is ignored.
  const key = (text: string) => text.split(`\n\n${DURING} `)[0].slice(0, MATCH_CHARS)
  const a = turns.map(p => key(p.prompt))
  const b = past.map(t => key(t.prompt))
  const longest = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      longest[i][j] = a[i] === b[j] ? longest[i + 1][j + 1] + 1 : Math.max(longest[i + 1][j], longest[i][j + 1])
    }
  }
  const matched = new Map<number, number>()
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) {
      matched.set(turns[i].n, j)
      i++
      j++
    } else if (longest[i + 1][j] >= longest[i][j + 1]) i++
    else j++
  }
  if (matched.size * 2 < turns.length) {
    $.ui.toast('chatmap could not match its map with the transcript: Rebuild to start the map over')
    return
  }
  const byIndex = new Map(turns.filter(p => matched.has(p.n)).map(p => [matched.get(p.n)!, p]))
  if (byIndex.size === past.length && turns.length === past.length && [...matched].every(([n, i]) => n === i + 1)) return
  await update($, physical, () => past.map((t, i) => (byIndex.has(i) ? { ...byIndex.get(i)!, n: i + 1 } : imported({ ...t, n: i + 1 }))))
  await update($, logical, list =>
    list
      .map(l => ({ ...l, physical: l.physical.filter(n => matched.has(n)).map(n => matched.get(n)! + 1) }))
      .filter(l => l.physical.length > 0),
  )
  const done = await read($, logical)
  const covered = done.length ? Math.max(...done[done.length - 1].physical) : 0
  const added = past.map((_, i) => i + 1).filter(n => !byIndex.has(n - 1))
  if (added.some(n => n <= covered)) lane.fullDue = true
  else if (added.length) lane.backlog = true
}

async function dropNotifications($: EngineInterface): Promise<void> {
  const noise = new Set((await read($, physical)).filter(p => p.prompt.startsWith('<task-notification>')).map(p => p.n))
  if (!noise.size) return
  await update($, physical, list => list.filter(p => !noise.has(p.n)))
  await update($, logical, list =>
    list.map(l => ({ ...l, physical: l.physical.filter(n => !noise.has(n)) })).filter(l => l.physical.length > 0),
  )
}

async function answers($: EngineInterface, base: string): Promise<boolean> {
  try {
    return (await $.http.fetch(`${base}/sessions`)).ok
  } catch {
    return false
  }
}

function startOwn($: EngineInterface): Promise<void> {
  return new Promise((resolve, reject) => {
    void (async () => {
      const server = $.process.spawn({ argv: ['python3', `${$.plugin.root}/server/chatmap_server.py`, 'serve'] })
      let ready = false
      for await (const { stream, text } of server) {
        if (!ready && text.includes('chatmap on http://')) {
          ready = true
          resolve()
        } else if (stream === 'stderr') {
          $.ui.log(text, { to: 'debug' })
        }
      }
      if (!ready) reject(new Error('the chatmap host stopped before it was ready'))
    })()
  })
}

async function findHost($: EngineInterface, lane: Lane): Promise<void> {
  lane.hostTriedAt = await $.clock.now()
  let base = (await answers($, LINK)) ? LINK : (await answers($, OWN)) ? OWN : ''
  if (!base) {
    try {
      await startOwn($)
    } catch (error) {
      // another chat may have bound the port a moment earlier
      if (!(await answers($, OWN))) throw error
    }
    base = OWN
  }
  await update($, host, () => base)
  const cwd = await $.session.cwd()
  await link($, '', { cwd, title: cwd.split('/').pop() ?? cwd, page: `${$.plugin.root}/tools/grid.html` })
  lane.url = `${base}/s/${await $.session.id()}/`
}

async function savedOn($: EngineInterface): Promise<boolean> {
  for (const base of [LINK, OWN]) {
    if (await answers($, base)) {
      await update($, host, () => base)
      return ((await link($, '/state')) as Saved | null)?.enabled === true
    }
  }
  const run = await $.process.run(['python3', `${$.plugin.root}/server/chatmap_server.py`, 'enabled', await $.session.id()], { timeoutMs: 10000 })
  return run.stdout.trim() === 'true'
}

async function turnOn($: EngineInterface, lane: Lane): Promise<void> {
  await findHost($, lane)
  const saved = (await link($, '/state')) as Saved | null
  await update($, enabled, () => true)
  await restore($, saved)
  await reconcile($, lane)
  await dropNotifications($)
  lane.tick ??= $.clock.every(TICK_MS, () => {
    void work($, 'none', lane)
  })
  await publish($)
}

function openPane($: EngineInterface, lane: Lane): void {
  void $.prompt.submit({
    text: `Open ${lane.url} in the Browser pane beside the chat: it is the chatmap of this conversation. Answer with one short line.`,
  })
}

async function turnOff($: EngineInterface, lane: Lane): Promise<void> {
  lane.tick?.cancel()
  lane.tick = undefined
  await update($, enabled, () => false)
  await publish($)
}

async function confirmOn($: EngineInterface): Promise<boolean> {
  try {
    return (await $.ui.ask('Turn on chatmap for this chat? It records every turn and calls Haiku and Sonnet.', ['Turn on', 'Cancel'])) === 'Turn on'
  } catch {
    return false
  }
}

async function toggle($: EngineInterface, lane: Lane): Promise<void> {
  if (await read($, enabled)) await turnOff($, lane)
  else if (await confirmOn($)) {
    try {
      await turnOn($, lane)
      openPane($, lane)
    } catch (error) {
      $.ui.toast(`chatmap stays off: ${(error as Error).message}`)
    }
  }
}

export const register: Register = on => {
  let tools: string[] = []
  const lane: Lane = { queue: Promise.resolve(), url: '', backlog: false, failedAt: 0, hostTriedAt: 0, fullDue: false }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'chatmap', description: 'Reorganise this conversation (full: rebuild from scratch) and show the URL of its map', argumentHint: '[full]' })
    try {
      if ((await read($, enabled)) || (await savedOn($))) await turnOn($, lane)
    } catch (error) {
      $.ui.toast(`chatmap: ${(error as Error).message}`)
    }
    return result
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const active = await read($, enabled)
    const up = await read($, linked)
    return (
      <Box flexDirection="row" gap={1}>
        {e.props.modes.length ? <Text dimColor>{e.props.modes.join(' & ')}</Text> : null}
        <Button key="chatmap" label={!active ? 'chatmap off' : up ? 'chatmap on' : 'chatmap on · host off'} plain onPress={() => void toggle($, lane)} />
      </Box>
    )
  })

  on('prompt.submit', async ($, e, next) => {
    if (SLASH.test(e.text) || !PERSON.includes(e.origin.kind) || !(await read($, enabled))) return next(e)
    const turns = await read($, physical)
    const running = turns.find(p => p.state === 'running')
    if (e.turnId !== undefined && running) {
      const added = `${running.prompt}\n\n${DURING} ${e.text}`.slice(0, PROMPT_TEXT)
      await update($, physical, list => list.map(p => (p.n === running.n ? { ...p, prompt: added } : p)))
      await publish($)
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
    await publish($)
    return next(e)
  })

  on('tool.call', ($, e, next) => {
    if (e.agentId === undefined) tools.push(e.tool)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || !(await read($, enabled))) return result
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
    await publish($)
    return result
  })

  on('command.run', { command: 'chatmap' }, async ($, e) => {
    if (!(await read($, enabled))) {
      if (!(await confirmOn($))) return { text: 'chatmap stays off' }
      try {
        await turnOn($, lane)
      } catch (error) {
        return { text: `chatmap stays off: ${(error as Error).message}` }
      }
    }
    await work($, e.args.trim() === 'full' ? 'full' : 'step', lane)
    const done = await read($, logical)
    const all = await read($, topics)
    openPane($, lane)
    return { text: `${(await read($, physical)).length} physical turns, ${done.length} logical turns, ${Object.keys(all).length} topics. Map: ${lane.url}` }
  })
}
