export type Topic = { title: string; description: string; fixed: boolean }

export type Physical = {
  n: number
  prompt: string
  answer: string
  tools: string[]
  short: boolean
  haiku: string[]
  state: 'running' | 'queued' | 'placed' | 'unclassified'
}

export type Spent = { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number }

export type Logical = { physical: number[]; label: string; prompt: string; outcome: string; topics: string[]; block: string; pass: number }

declare module 'claude-code' {
  interface PluginState {
    chatmap: {
      topics: Record<string, Topic>
      topicCount: number
      primary: string
      physical: Physical[]
      logical: Logical[]
      passes: number
      usage: Record<string, Spent>
      enabled: boolean
      linked: boolean
      working: boolean
    }
  }
}
