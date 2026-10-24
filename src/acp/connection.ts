import {
  agent as agentApp,
  type AgentConnection,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type Stream
} from '@agentclientprotocol/sdk/unstable'
import { PiAcpAgent } from './agent.js'

/** The client-side calls the agent makes. SDK 2.x removed `AgentSideConnection`; this is its subset we use. */
export type AcpClient = {
  readonly signal: AbortSignal
  sessionUpdate(params: SessionNotification): Promise<void>
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>
  createElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse>
  extNotification(method: string, params?: Record<string, unknown>): Promise<void>
}

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
    .onRequest('session/fork', ctx => implementation.forkSession(ctx.params))
    .onRequest('session/set_mode', ctx => implementation.setSessionMode(ctx.params))
    .onRequest('session/set_config_option', ctx => implementation.setSessionConfigOption(ctx.params))
    .onRequest('session/prompt', ctx => implementation.prompt(ctx.params, ctx.signal))
    .onRequest('_session/steering', { parse: (params: unknown) => params }, ctx => implementation.steer(ctx.params))
    .onNotification('session/cancel', ctx => implementation.cancel(ctx.params))
  const connection = app.connect(stream)
  return { agent: implementation, connection }
}
