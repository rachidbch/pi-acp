import type { ToolCallContent } from '@agentclientprotocol/sdk'
import { zContentBlock } from '@agentclientprotocol/sdk/dist/schema/zod.gen.js'
import { z } from 'zod'

const outputSchema = z.object({
  stdout: z.unknown().optional(),
  stderr: z.unknown().optional(),
  output: z.unknown().optional(),
  exitCode: z.unknown().optional(),
  code: z.unknown().optional()
})
const detailsSchema = outputSchema.extend({ diff: z.unknown().optional() })
const resultSchema = outputSchema.extend({
  content: z.unknown().optional(),
  details: z.unknown().optional(),
  text: z.unknown().optional()
})
const omittedContent = '[Unsupported or malformed tool content omitted.]'

function textContent(text: string): ToolCallContent[] {
  return text ? [{ type: 'content', content: { type: 'text', text } }] : []
}

/** Project portable native blocks without turning malformed binary content into visible JSON. */
export function toolResultToContent(result: unknown, opts?: { binaryResourcesAsLinks?: boolean }): ToolCallContent[] {
  if (!result) return []
  const parsed = resultSchema.safeParse(result)
  if (!parsed.success) return textContent(boundedFallback(result))
  const value = parsed.data
  const details = detailsSchema.safeParse(value.details)
  const diff = details.success ? details.data.diff : undefined
  if (typeof diff === 'string' && diff.trim()) return textContent(diff)

  const output: z.infer<typeof outputSchema> = details.success ? details.data : {}
  const string = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
  const stdout = string(output.stdout) ?? string(value.stdout) ?? string(output.output) ?? string(value.output)
  const stderr = string(output.stderr) ?? string(value.stderr)
  const fallback =
    stdout?.trim() || stderr?.trim()
      ? toolResultToText({ ...value, details: output, content: undefined })
      : typeof value.text === 'string'
        ? value.text
        : typeof value.content === 'string'
          ? value.content
          : ''

  if (Array.isArray(value.content)) {
    let hasValidBlock = false
    const content = value.content.flatMap((block: unknown): ToolCallContent[] => {
      const parsedBlock = zContentBlock.safeParse(block)
      if (!parsedBlock.success) return textContent(omittedContent)
      hasValidBlock = true
      const content = parsedBlock.data
      if (
        opts?.binaryResourcesAsLinks &&
        content.type === 'resource' &&
        'blob' in content.resource &&
        !content.resource.mimeType?.toLowerCase().startsWith('image/')
      ) {
        // Some renderers treat every embedded blob as an image; link non-image resources instead.
        const { uri, mimeType } = content.resource
        return [
          {
            type: 'content',
            content: {
              type: 'resource_link',
              uri,
              name: uri,
              ...(mimeType === undefined ? {} : { mimeType }),
              ...(content.annotations === undefined ? {} : { annotations: content.annotations }),
              ...(content._meta === undefined ? {} : { _meta: content._meta })
            }
          }
        ]
      }
      return [{ type: 'content', content }]
    })
    return hasValidBlock || !fallback ? content : textContent(boundedText(fallback))
  }
  if (fallback) return textContent(boundedText(fallback))
  if (value.content !== undefined && value.content !== null) return textContent(omittedContent)
  return textContent(boundedFallback(result))
}

function boundedFallback(result: unknown): string {
  return boundedText(toolResultToText(result))
}

function boundedText(text: string): string {
  const limit = 16_000
  return text.length > limit ? `${text.slice(0, limit)}\n[Tool result truncated.]` : text
}

export function toolResultToText(result: unknown): string {
  if (!result) return ''

  const details = (result as any)?.details

  // pi's edit tool returns a terse success message in content and the full unified diff in details.diff.
  const diff = details?.diff
  if (typeof diff === 'string' && diff.trim()) {
    return diff
  }

  // pi tool results generally look like: { content: [{type:"text", text:"..."}], details: {...} }
  const content = (result as any).content
  if (Array.isArray(content)) {
    const texts = content
      .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
    if (texts.length) return texts.join('')
  }

  // The bash tool frequently returns stdout/stderr in `details` rather than content blocks.
  const stdout =
    (typeof details?.stdout === 'string' ? details.stdout : undefined) ??
    (typeof (result as any)?.stdout === 'string' ? (result as any).stdout : undefined) ??
    (typeof details?.output === 'string' ? details.output : undefined) ??
    (typeof (result as any)?.output === 'string' ? (result as any).output : undefined)

  const stderr =
    (typeof details?.stderr === 'string' ? details.stderr : undefined) ??
    (typeof (result as any)?.stderr === 'string' ? (result as any).stderr : undefined)

  const exitCode =
    (typeof details?.exitCode === 'number' ? details.exitCode : undefined) ??
    (typeof (result as any)?.exitCode === 'number' ? (result as any).exitCode : undefined) ??
    (typeof details?.code === 'number' ? details.code : undefined) ??
    (typeof (result as any)?.code === 'number' ? (result as any).code : undefined)

  if ((typeof stdout === 'string' && stdout.trim()) || (typeof stderr === 'string' && stderr.trim())) {
    const parts: string[] = []
    if (typeof stdout === 'string' && stdout.trim()) parts.push(stdout)
    if (typeof stderr === 'string' && stderr.trim()) parts.push(`stderr:\n${stderr}`)
    if (typeof exitCode === 'number') parts.push(`exit code: ${exitCode}`)
    return parts.join('\n\n').trimEnd()
  }

  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}
