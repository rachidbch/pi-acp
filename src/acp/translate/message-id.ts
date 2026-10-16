import { randomUUID } from 'node:crypto'

export function messageKey(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const record = message as Record<string, unknown>
  if (record.role !== 'assistant' && record.role !== 'user') return undefined
  if (typeof record.timestamp !== 'number' || !Number.isFinite(record.timestamp)) return undefined
  return `${record.role}:${record.timestamp}`
}

/** ACP-owned identifiers, not pi session-entry or provider response IDs. */
export class MessageIds {
  private readonly occurrences = new Map<string, number>()

  next(message: unknown): string {
    const key = messageKey(message)
    if (!key) return `pi-acp:${randomUUID()}`
    const occurrence = (this.occurrences.get(key) ?? 0) + 1
    this.occurrences.set(key, occurrence)
    return `pi-acp:${key}:${occurrence}`
  }

  seed(messages: unknown[]): void {
    this.occurrences.clear()
    for (const message of messages) {
      if (messageKey(message)) this.next(message)
    }
  }
}
