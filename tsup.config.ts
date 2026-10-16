import { copyFileSync, mkdirSync } from 'node:fs'
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  dts: false,
  splitting: false,
  minify: false,
  banner: {
    js: '#!/usr/bin/env node'
  },
  onSuccess: () => {
    // The MCP bootstrap ships as plain JS next to the bundle; pi loads it via `-e`.
    mkdirSync('dist/pi-extension', { recursive: true })
    copyFileSync('src/pi-extension/mcp-bootstrap.js', 'dist/pi-extension/mcp-bootstrap.js')
  }
})
