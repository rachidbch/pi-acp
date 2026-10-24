import assert from 'node:assert/strict'
import { test } from 'node:test'
import type {
  ClientCapabilities,
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate
} from '@agentclientprotocol/sdk/unstable'
import { CreateElicitationRequest as elicitationRequestGuard } from '@agentclientprotocol/sdk/unstable'
import { handleExtensionUiRequest, type ExtensionUiHost, type ExtensionUiResponse } from '../../src/acp/extension-ui.js'

import type { AcpClient } from '../../src/acp/connection.js'
function fixture(capabilities?: ClientCapabilities) {
  const connection = new AbortController()
  const session = new AbortController()
  const permissions: RequestPermissionRequest[] = []
  const forms: CreateElicitationRequest[] = []
  const responses: ExtensionUiResponse[] = []
  const updates: SessionUpdate[] = []
  const answers = {
    permission: async (): Promise<RequestPermissionResponse> => ({ outcome: { outcome: 'cancelled' } }),
    form: async (): Promise<CreateElicitationResponse> => ({ action: 'cancel' })
  }
  const conn = {
    signal: connection.signal,
    requestPermission: async (request: RequestPermissionRequest) => {
      permissions.push(request)
      return answers.permission()
    },
    createElicitation: async (request: CreateElicitationRequest) => {
      forms.push(request)
      return answers.form()
    }
  } as unknown as AcpClient
  const host: ExtensionUiHost = {
    sessionId: 'session-1',
    conn,
    clientCapabilities: capabilities,
    signal: session.signal,
    sendResponse: async response => {
      responses.push(response)
    },
    emit: update => {
      updates.push(update)
    }
  }
  const run = (method: string, fields: Record<string, unknown> = {}) =>
    handleExtensionUiRequest({ type: 'extension_ui_request', id: 'ui-1', method, ...fields }, host)
  return { connection, session, permissions, forms, responses, updates, answers, host, run }
}

const formCapabilities: ClientCapabilities = { elicitation: { form: {} } }

for (const [optionId, confirmed] of [
  ['yes', true],
  ['no', false]
] as const) {
  test(`confirm ${optionId} uses the correct permission kinds`, async () => {
    const f = fixture(formCapabilities)
    f.answers.permission = async () => ({ outcome: { outcome: 'selected', optionId } })
    await f.run('confirm', { title: 'Clear session?', message: 'All messages will be lost.' })
    assert.deepEqual(f.responses, [{ id: 'ui-1', confirmed }])
    assert.equal(f.forms.length, 0)
    assert.deepEqual(f.permissions[0]?.options, [
      { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
      { optionId: 'no', name: 'No', kind: 'reject_once' }
    ])
    assert.equal(f.permissions[0]?.sessionId, 'session-1')
    assert.equal(f.permissions[0]?.toolCall.title, 'Clear session?')
    assert.match(JSON.stringify(f.permissions[0]?.toolCall), /All messages will be lost/)
  })
}

for (const optionId of [undefined, 'unexpected']) {
  test(`confirm cancels on ${optionId ?? 'dismissal'}`, async () => {
    const f = fixture()
    if (optionId) f.answers.permission = async () => ({ outcome: { outcome: 'selected', optionId } })
    await f.run('confirm')
    assert.deepEqual(f.responses, [{ id: 'ui-1', cancelled: true }])
  })
}

test('legacy select preserves string values without inferring permission policy from labels', async () => {
  const f = fixture()
  f.answers.permission = async () => ({ outcome: { outcome: 'selected', optionId: 'choice-1' } })
  await f.run('select', { title: 'Choose', options: ['Always allow', 'Never allow'] })
  assert.deepEqual(f.responses, [{ id: 'ui-1', value: 'Never allow' }])
  assert.deepEqual(f.permissions[0]?.options, [
    { optionId: 'choice-0', name: 'Always allow', kind: 'allow_once' },
    { optionId: 'choice-1', name: 'Never allow', kind: 'allow_once' }
  ])
})

for (const optionId of ['choice-01', 'choice--1', 'choice-2', 'other']) {
  test(`legacy select rejects invalid option ID ${optionId}`, async () => {
    const f = fixture()
    f.answers.permission = async () => ({ outcome: { outcome: 'selected', optionId } })
    await f.run('select', { options: ['A', 'B'] })
    assert.deepEqual(f.responses, [{ id: 'ui-1', cancelled: true }])
  })
}

for (const options of [undefined, [], [1], ['A', null]]) {
  test(`invalid select options ${JSON.stringify(options)} are cancelled`, async () => {
    const f = fixture(formCapabilities)
    await f.run('select', { options })
    assert.deepEqual(f.responses, [{ id: 'ui-1', cancelled: true }])
    assert.equal(f.permissions.length + f.forms.length, 0)
  })
}

test('negotiated select is an enum question, not a permission request', async () => {
  const f = fixture(formCapabilities)
  f.answers.form = async () => ({ action: 'accept', content: { value: 'Block' } })
  await f.run('select', { title: 'Choose an answer', options: ['Allow', 'Block'] })
  assert.deepEqual(f.responses, [{ id: 'ui-1', value: 'Block' }])
  assert.equal(f.permissions.length, 0)
  assert.deepEqual(f.forms[0], {
    sessionId: 'session-1',
    mode: 'form',
    message: 'Choose an answer',
    requestedSchema: {
      type: 'object',
      properties: { value: { type: 'string', title: 'Choose an answer', enum: ['Allow', 'Block'] } },
      required: ['value']
    }
  })
})

for (const capability of [undefined, { elicitation: {} }, { elicitation: { url: {} } }]) {
  test(`select without form capability uses buttons: ${JSON.stringify(capability)}`, async () => {
    const f = fixture(capability)
    await f.run('select', { options: ['A'] })
    assert.equal(f.forms.length, 0)
    assert.equal(f.permissions.length, 1)
  })
}

for (const [method, fields] of [
  ['input', { placeholder: 'e.g. project name' }],
  ['editor', { prefill: 'Line 1\nLine 2' }]
] as const) {
  test(`${method} translates a plain string form with a non-secret disclosure`, async () => {
    const f = fixture(formCapabilities)
    f.answers.form = async () => ({ action: 'accept', content: { value: 'A\nB' } })
    await f.run(method, { title: 'Project notes', ...fields })
    assert.deepEqual(f.responses, [{ id: 'ui-1', value: 'A\nB' }])
    assert.equal(f.permissions.length, 0)
    const request = f.forms[0]
    assert.equal(request?.mode, 'form')
    assert.match(request?.message ?? '', /Do not enter passwords, tokens, or other secrets/)
    if (!request || !elicitationRequestGuard.isForm(request)) assert.fail('expected form')
    assert.deepEqual(request.requestedSchema.required, ['value'])
    const field = request.requestedSchema.properties?.value
    assert.equal(field?.type, 'string')
    if (field?.type !== 'string') assert.fail('expected string field')
    assert.equal(field.default, method === 'editor' ? fields.prefill : undefined)
    assert.equal(field.description, method === 'input' ? fields.placeholder : undefined)
  })

  test(`${method} without form capability explicitly cancels`, async () => {
    const f = fixture()
    await f.run(method)
    assert.deepEqual(f.responses, [{ id: 'ui-1', cancelled: true }])
    assert.equal(f.permissions.length + f.forms.length, 0)
    assert.equal(f.updates.length, 1)
  })
}

const cancellingAnswers: CreateElicitationResponse[] = [
  { action: 'decline' },
  { action: 'cancel' },
  { action: 'accept' },
  { action: 'accept', content: { value: 1 } },
  { action: 'accept', content: { other: 'text' } }
]
for (const answer of cancellingAnswers) {
  test(`input answer ${JSON.stringify(answer)} cancels exactly once`, async () => {
    const f = fixture(formCapabilities)
    f.answers.form = async () => answer
    await f.run('input')
    assert.deepEqual(f.responses, [{ id: 'ui-1', cancelled: true }])
  })
}

test('accepted empty input remains a valid text answer', async () => {
  const f = fixture(formCapabilities)
  f.answers.form = async () => ({ action: 'accept', content: { value: '' } })
  await f.run('input')
  assert.deepEqual(f.responses, [{ id: 'ui-1', value: '' }])
})

test('enum responses must be one of the offered strings', async () => {
  const f = fixture(formCapabilities)
  f.answers.form = async () => ({ action: 'accept', content: { value: 'invented' } })
  await f.run('select', { options: ['A'] })
  assert.deepEqual(f.responses, [{ id: 'ui-1', cancelled: true }])
})

for (const method of ['confirm', 'select', 'input', 'editor']) {
  test(`${method} client errors cancel once without rejecting`, async () => {
    const f = fixture(formCapabilities)
    f.answers.permission = async () => {
      throw new Error('client disconnected')
    }
    f.answers.form = async () => {
      throw new Error('method not found')
    }
    await f.run(method, { options: ['A'] })
    assert.deepEqual(f.responses, [{ id: 'ui-1', cancelled: true }])
  })
}

for (const fields of [
  { password: true },
  { sensitive: true },
  { secret: true },
  { isPassword: true },
  { inputType: 'password' },
  { format: 'password' },
  { title: 'Enter your password' },
  { title: 'Provide API key' },
  { title: 'Authentication token' },
  { title: 'Enter API token' },
  { title: 'Enter token' },
  { placeholder: 'Paste your private key' },
  { requestedSchema: { type: 'object', properties: { password: { type: 'string' } } } }
]) {
  test(`credential or custom-schema request is refused: ${JSON.stringify(fields)}`, async () => {
    const f = fixture(formCapabilities)
    await f.run('input', fields)
    assert.deepEqual(f.responses, [{ id: 'ui-1', cancelled: true }])
    assert.equal(f.forms.length + f.permissions.length, 0)
    assert.ok(!JSON.stringify(f.updates).includes('private key'))
  })
}

test('credential refusal does not echo prefill or sensitive title in fallback messages', async () => {
  const f = fixture(formCapabilities)
  await f.run('editor', { title: 'Secret token', prefill: 'must-not-be-emitted' })
  assert.deepEqual(f.responses, [{ id: 'ui-1', cancelled: true }])
  assert.equal(f.forms.length, 0)
  assert.ok(!JSON.stringify(f.updates).includes('must-not-be-emitted'))
})

test('notify emits text and severity metadata, never a Pi response, even without id', async () => {
  const f = fixture()
  await f.run('notify', { id: undefined, message: 'A warning', notifyType: 'warning' })
  assert.deepEqual(f.responses, [])
  assert.deepEqual(f.updates, [
    {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'A warning' },
      _meta: { piAcp: { notify: { level: 'warning' } } }
    }
  ])
})

test('invalid notification severity defaults to info', async () => {
  const f = fixture()
  await f.run('notify', { message: 'Hello', notifyType: 'invented' })
  assert.deepEqual(f.updates[0]?._meta, { piAcp: { notify: { level: 'info' } } })
})

test('fire-and-forget and unknown methods do not reply or flood chat', async () => {
  const f = fixture()
  for (let i = 0; i < 50; i++) {
    for (const method of ['setStatus', 'setWidget', 'setTitle', 'set_editor_text', 'unknown']) {
      await f.run(method, { statusText: `${i} TPS` })
    }
  }
  assert.deepEqual(f.responses, [])
  assert.deepEqual(f.updates, [])
})

test('dialogs without a valid id cannot open a request or send a response', async () => {
  const f = fixture()
  await f.run('confirm', { id: undefined })
  await f.run('confirm', { id: '' })
  assert.equal(f.permissions.length, 0)
  assert.deepEqual(f.responses, [])
})

for (const trigger of ['session', 'connection'] as const) {
  for (const method of ['input', 'confirm'] as const) {
    test(`${trigger} cancellation releases pending ${method} and ignores late answers`, async () => {
      const f = fixture(formCapabilities)
      let resolveForm!: (response: CreateElicitationResponse) => void
      let resolvePermission!: (response: RequestPermissionResponse) => void
      f.answers.form = () =>
        new Promise(resolve => {
          resolveForm = resolve
        })
      f.answers.permission = () =>
        new Promise(resolve => {
          resolvePermission = resolve
        })
      const handling = f.run(method)
      f[trigger].abort()
      await handling
      assert.deepEqual(f.responses, [{ id: 'ui-1', cancelled: true }])
      if (method === 'input') resolveForm({ action: 'accept', content: { value: 'late' } })
      else resolvePermission({ outcome: { outcome: 'selected', optionId: 'yes' } })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(f.responses.length, 1)
    })
  }
}

test('cancellation queued just after a client answer still cancels rather than forwarding text', async () => {
  const f = fixture(formCapabilities)
  let resolveAnswer!: (response: CreateElicitationResponse) => void
  const answer = new Promise<CreateElicitationResponse>(resolve => {
    resolveAnswer = resolve
  })
  f.host.conn.createElicitation = () => answer
  const handling = f.run('input')
  resolveAnswer({ action: 'accept', content: { value: 'stale' } })
  queueMicrotask(() => f.session.abort())
  await handling
  assert.deepEqual(f.responses, [{ id: 'ui-1', cancelled: true }])
})

test('already aborted request cancels without opening client UI', async () => {
  const f = fixture(formCapabilities)
  f.session.abort()
  await f.run('input')
  assert.equal(f.forms.length, 0)
  assert.deepEqual(f.responses, [{ id: 'ui-1', cancelled: true }])
})

test('Pi timeout releases a pending dialog without a stale Pi response', async () => {
  const f = fixture(formCapabilities)
  let resolveAnswer!: (response: CreateElicitationResponse) => void
  f.answers.form = () =>
    new Promise(resolve => {
      resolveAnswer = resolve
    })
  await f.run('select', { options: ['A'], timeout: 5 })
  assert.deepEqual(f.responses, [])
  resolveAnswer({ action: 'accept', content: { value: 'A' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.responses, [])
})

test('Pi timeout cancels the pending client request', async () => {
  const f = fixture(formCapabilities)
  let requestSignal!: AbortSignal
  f.host.conn.createElicitation = (_request, signal) => {
    requestSignal = signal!
    return new Promise(() => {})
  }
  await f.run('input', { timeout: 5 })
  assert.equal(requestSignal.aborted, true)
})

test('session cancellation cancels the pending client request', async () => {
  const f = fixture(formCapabilities)
  let requestSignal!: AbortSignal
  f.host.conn.createElicitation = (_request, signal) => {
    requestSignal = signal!
    return new Promise(() => {})
  }
  const handling = f.run('input')
  f.session.abort()
  await handling
  assert.equal(requestSignal.aborted, true)
})

test('trusted parent permits credential-word text requests', async () => {
  const f = fixture(formCapabilities)
  f.host.trustedParent = true
  f.answers.form = async () => ({ action: 'accept', content: { value: 'secret' } })
  await f.run('input', { title: 'Enter password' })
  assert.equal(f.forms.length, 1)
  assert.deepEqual(f.responses, [{ id: 'ui-1', value: 'secret' }])
})

test('trusted parent still rejects explicitly sensitive text requests', async () => {
  const f = fixture(formCapabilities)
  f.host.trustedParent = true
  await f.run('input', { password: true })
  assert.equal(f.forms.length, 0)
  assert.deepEqual(f.responses, [{ id: 'ui-1', cancelled: true }])
})

test('a failing response write is not retried as another cancellation', async () => {
  const f = fixture()
  let writes = 0
  f.host.sendResponse = async () => {
    writes++
    throw new Error('Pi exited')
  }
  await f.run('confirm')
  assert.equal(writes, 1)
})

test('notification delivery failures do not produce fake responses', async () => {
  const f = fixture()
  f.host.emit = () => {
    throw new Error('client closed')
  }
  await f.run('notify', { message: 'Hello' })
  assert.deepEqual(f.responses, [])
})
