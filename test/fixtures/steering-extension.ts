export default function (pi: any) {
  let release: (() => void) | undefined
  pi.on('input', async (event: { text: string }) => {
    if (event.text !== 'EXTENSION_TRIGGER') return
    await new Promise<void>(resolve => {
      release = resolve
    })
    return { action: 'transform', text: 'Reply exactly: EXTENSION_REPLAY' }
  })
  pi.on('agent_settled', () => {
    release?.()
    release = undefined
  })
  pi.on('before_agent_start', async () => {
    await new Promise(resolve => setTimeout(resolve, 100))
  })
  pi.on('agent_before_settle', async () => {
    await new Promise(resolve => setTimeout(resolve, 100))
  })
}
