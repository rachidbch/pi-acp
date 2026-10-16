import test from 'node:test'
import assert from 'node:assert/strict'
import { toolResultToContent, toolResultToText, zToolCallContent } from '../../src/acp/translate/pi-tools.js'

test('toolResultToText: extracts text from content blocks', () => {
  const text = toolResultToText({
    content: [
      { type: 'text', text: 'hello' },
      { type: 'text', text: ' world' }
    ]
  })
  assert.equal(text, 'hello world')
})

test('toolResultToText: prefers details.diff when present', () => {
  const text = toolResultToText({
    content: [{ type: 'text', text: 'Successfully replaced 2 block(s) in a.txt.' }],
    details: { diff: '--- a\n+++ b\n' }
  })
  assert.equal(text, '--- a\n+++ b\n')
})

test('toolResultToText: falls back to JSON', () => {
  const text = toolResultToText({ a: 1 })
  assert.match(text, /"a": 1/)
})

test('toolResultToText: extracts bash stdout/stderr from details', () => {
  const text = toolResultToText({ details: { stdout: 'ok\n', stderr: 'warn\n', exitCode: 0 } })
  assert.match(text, /ok/)
  assert.match(text, /stderr:/)
  assert.match(text, /warn/)
  assert.match(text, /exit code: 0/)
})

const image = { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }
const wrap = (content: unknown) => ({ type: 'content', content })

test('toolResultToContent: image-only output is standard content, not visible base64 JSON', () => {
  const content = toolResultToContent({ content: [image] })
  assert.deepEqual(content, [wrap(image)])
  for (const block of content) assert.equal(zToolCallContent.safeParse(block).success, true)
})

test('toolResultToContent: preserves mixed text, image, embedded resources and links in native order', () => {
  const blocks = [
    { type: 'text', text: 'Before' },
    image,
    { type: 'resource', resource: { uri: 'file:///report.txt', text: 'Report', mimeType: 'text/plain' } },
    { type: 'resource', resource: { uri: 'file:///data.bin', blob: 'aGVsbG8=' } },
    { type: 'resource_link', uri: 'https://example.com/report', name: 'Report', mimeType: 'text/plain' },
    { type: 'text', text: 'After' }
  ]
  const content = toolResultToContent({ content: blocks })
  assert.deepEqual(content, blocks.map(wrap))
  for (const block of content) assert.equal(zToolCallContent.safeParse(block).success, true)
})

test('toolResultToContent: details.diff takes priority over rich content', () => {
  assert.deepEqual(
    toolResultToContent({
      content: [null, image, { type: 'image', data: 42 }, { type: 'text', text: 'Edited' }],
      details: { diff: '--- a\n+++ b\n' }
    }),
    [wrap({ type: 'text', text: '--- a\n+++ b\n' })]
  )
})

test('toolResultToContent: malformed blocks are omitted honestly without dumping encoded payloads', () => {
  const invalid = [
    null,
    { type: 'text', text: 42 },
    { type: 'image', data: 'SECRET_BASE64', mimeType: 42 },
    { type: 'resource', resource: { blob: 'SECRET_BASE64' } },
    { type: 'resource_link', uri: 'file:///report' },
    { type: 'application', data: 'SECRET_BASE64' }
  ]
  for (const block of invalid) {
    const content = toolResultToContent({ content: [block] })
    assert.equal(content.length, 1)
    assert.match(JSON.stringify(content), /omitted/i)
    assert.doesNotMatch(JSON.stringify(content), /SECRET_BASE64/)
    assert.equal(zToolCallContent.safeParse(content[0]).success, true)
  }
  const mixed = toolResultToContent({ content: [null, { type: 'text', text: 'Before' }, invalid[2], image] })
  assert.match(JSON.stringify(mixed[0]), /omitted/i)
  assert.deepEqual(mixed[1], wrap({ type: 'text', text: 'Before' }))
  assert.match(JSON.stringify(mixed[2]), /omitted/i)
  assert.deepEqual(mixed[3], wrap(image))
})

test('toolResultToContent: retains explicit stdout/stderr and text fallbacks', () => {
  const result = { details: { stdout: 'ok\n', stderr: 'warning\n', exitCode: 1 } }
  assert.deepEqual(toolResultToContent(result), [wrap({ type: 'text', text: toolResultToText(result) })])
  assert.deepEqual(toolResultToContent({ text: 'Plain result' }), [wrap({ type: 'text', text: 'Plain result' })])
  assert.deepEqual(toolResultToContent({ content: 'Plain content' }), [wrap({ type: 'text', text: 'Plain content' })])
  assert.deepEqual(toolResultToContent({ content: [{ type: 'image' }], stdout: 'Fallback' }), [
    wrap({ type: 'text', text: 'Fallback' })
  ])
})

test('toolResultToContent: non-content results retain bounded legacy JSON fallback', () => {
  assert.deepEqual(toolResultToContent({ a: 1 }), [wrap({ type: 'text', text: '{\n  "a": 1\n}' })])
  assert.deepEqual(toolResultToContent(undefined), [])
  assert.deepEqual(toolResultToContent(null), [])
  const output = toolResultToContent({ a: 'x'.repeat(100_000) })
  assert.ok(JSON.stringify(output).length < 20_000)
  assert.match(JSON.stringify(output), /truncated/i)
})

test('toolResultToContent: legacy text fallbacks are bounded without truncating actual content blocks', () => {
  const text = 'x'.repeat(100_000)
  for (const result of [
    { stdout: text },
    { details: { stderr: text, exitCode: 1 } },
    { content: [null], stdout: text },
    { text },
    { content: text }
  ]) {
    const output = toolResultToContent(result)
    assert.ok(JSON.stringify(output).length < 20_000)
    assert.match(JSON.stringify(output), /truncated/i)
  }
  assert.deepEqual(toolResultToContent({ content: [{ type: 'text', text }] }), [wrap({ type: 'text', text })])
})

test('toolResultToContent: optional binary-resource links avoid non-image blob rendering without mutating native data', () => {
  for (const mimeType of [undefined, 'application/octet-stream']) {
    const resource = {
      uri: 'file:///artifacts/report.bin',
      blob: 'SECRET_BASE64',
      ...(mimeType === undefined ? {} : { mimeType })
    }
    const result = { content: [{ type: 'resource', resource }] }
    const original = JSON.stringify(result)
    const content = toolResultToContent(result, { binaryResourcesAsLinks: true })
    assert.deepEqual(content, [
      wrap({
        type: 'resource_link',
        uri: resource.uri,
        name: resource.uri,
        ...(mimeType === undefined ? {} : { mimeType })
      })
    ])
    assert.doesNotMatch(JSON.stringify(content), /SECRET_BASE64/)
    assert.equal(zToolCallContent.safeParse(content[0]).success, true)
    assert.equal(JSON.stringify(result), original)
    assert.deepEqual(toolResultToContent(result), result.content.map(wrap))
    assert.deepEqual(toolResultToContent(result, { binaryResourcesAsLinks: false }), result.content.map(wrap))
  }
})

test('toolResultToContent: binary-resource compatibility keeps image blobs and embedded text intact', () => {
  const result = {
    content: [
      { type: 'resource', resource: { uri: 'file:///artifacts/image.png', blob: 'aGVsbG8=', mimeType: 'image/png' } },
      { type: 'resource', resource: { uri: 'file:///artifacts/text.txt', text: 'Report', mimeType: 'text/plain' } }
    ]
  }
  assert.deepEqual(toolResultToContent(result, { binaryResourcesAsLinks: true }), result.content.map(wrap))
})

test('toolResultToContent: invalid content containers never become visible payload dumps', () => {
  for (const content of [{ type: 'image', data: 'SECRET_BASE64' }, 42]) {
    const output = toolResultToContent({ content })
    assert.match(JSON.stringify(output), /omitted/i)
    assert.doesNotMatch(JSON.stringify(output), /SECRET_BASE64/)
  }
})
