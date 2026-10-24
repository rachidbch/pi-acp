type Queue = { steering: string[]; followUp: string[] }
type Entry = { text: string; sent: boolean }

export class Steering {
  private phase: 'start' | 'running' | 'end' = 'start'
  private entries: Entry[] = []
  private pending = new Set<Promise<void>>()
  private failure: unknown
  private generation = 0

  get hasPending(): boolean {
    return this.entries.length > 0
  }

  constructor(private readonly send: (text: string) => Promise<string | undefined>) {}

  start(): void {
    this.generation++
    this.phase = 'start'
  }
  ended(): void {
    this.generation++
    this.phase = 'end'
  }
  clear(): void {
    this.generation++
    this.entries = []
    this.failure = undefined
    this.phase = 'end'
  }

  async inject(text: string): Promise<void> {
    const entry = { text, sent: false }
    this.entries.push(entry)
    if (this.phase === 'running') await this.deliver(entry)
  }

  private deliver(entry: Entry): Promise<void> {
    entry.sent = true
    const work = this.send(entry.text).then(
      disposition => {
        if (disposition === 'handled') this.entries = this.entries.filter(item => item !== entry)
      },
      error => {
        if (this.entries.includes(entry)) this.failure = error
        throw error
      }
    )
    this.pending.add(work)
    return work.finally(() => this.pending.delete(work))
  }

  async running(): Promise<void> {
    const generation = ++this.generation
    this.phase = 'running'
    for (const entry of this.entries) {
      if (generation !== this.generation || this.phase !== 'running') break
      if (!entry.sent) await this.deliver(entry)
    }
  }

  async leftovers(clear: () => Promise<Queue>): Promise<string[]> {
    await Promise.all(this.pending)
    if (this.failure) throw this.failure
    const queue = await clear()
    // clear_queue contains both our steers and extension steers; preserve all by text.
    const remaining = [...queue.steering]
    for (const entry of this.entries) {
      if (!entry.sent) remaining.push(entry.text)
    }
    this.entries = []
    return [...remaining, ...queue.followUp]
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.pending)
  }
}
