import {
  agent as agentApp,
  type AgentConnection,
  type AgentSideConnection,
  type Stream
} from '@agentclientprotocol/sdk'
import { PiAcpAgent } from './agent.js'

export type AcpClient = Pick<
  AgentSideConnection,
  'signal' | 'sessionUpdate' | 'requestPermission' | 'createElicitation' | 'extNotification'
>

export function connectPiAgent(stream: Stream): { agent: PiAcpAgent; connection: AgentConnection } {
  let implementation!: PiAcpAgent
  const app = agentApp()
    .onConnect(({ client, signal }) => {
      implementation = new PiAcpAgent({
        signal,
        sessionUpdate: params => client.notify('session/update', params),
        requestPermission: params => client.request('session/request_permission', params),
        createElicitation: params => client.request('elicitation/create', params),
        extNotification: (method, params) => client.notify(method, params)
      })
    })
    .onRequest('initialize', ctx => implementation.initialize(ctx.params))
    .onRequest('authenticate', ctx => implementation.authenticate(ctx.params))
    .onRequest('providers/list', ctx => implementation.unstable_listProviders(ctx.params))
    .onRequest('session/new', ctx => implementation.newSession(ctx.params))
    .onRequest('session/load', ctx => implementation.loadSession(ctx.params))
    .onRequest('session/resume', ctx => implementation.resumeSession(ctx.params))
    .onRequest('session/close', ctx => implementation.closeSession(ctx.params))
    .onRequest('session/list', ctx => implementation.listSessions(ctx.params))
    .onRequest('session/delete', ctx => implementation.deleteSession(ctx.params))
    .onRequest('session/set_mode', ctx => implementation.setSessionMode(ctx.params))
    .onRequest('session/set_config_option', ctx => implementation.setSessionConfigOption(ctx.params))
    .onRequest('session/prompt', ctx => implementation.prompt(ctx.params, ctx.signal))
    .onNotification('session/cancel', ctx => implementation.cancel(ctx.params))
  const connection = app.connect(stream)
  return { agent: implementation, connection }
}
