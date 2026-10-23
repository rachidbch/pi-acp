#!/usr/bin/env node
// Fork build release (ADR-038 tags, subagents-redesign SPEC "Packaging and versions"):
// from a clean `main`, build, commit `dist/` on a detached commit whose package.json has
// no install-time scripts, and tag it `fork-<base>-build.N` (lightweight, next free N,
// never moved). Source stays on `main`; `fork-<base>` marks it (created if missing).
// Pushing is left to the caller: the script prints the command.
// Usage: node scripts/fork-release.mjs [--dry-run]
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const BASE = 'v0.0.36' // upstream razorbackdb/pi-acp release this fork starts from
const BUILD = ['npx', ['tsup']]
const LIFECYCLE = [
  'preinstall',
  'install',
  'postinstall',
  'prepublish',
  'preprepare',
  'prepare',
  'postprepare',
  'prepack',
  'postpack'
]

const dryRun = process.argv.includes('--dry-run')
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' })

if (git('status', '--porcelain')) throw new Error('working tree not clean')
const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
if (branch !== 'main') throw new Error(`release from main, not ${branch}`)

const source = git('rev-parse', 'HEAD')
const prefix = `fork-${BASE}-build.`
git('fetch', '--tags', '--quiet', 'origin')
const taken = git('tag', '-l', `${prefix}*`)
  .split('\n')
  .filter(Boolean)
  .map(t => Number(t.slice(prefix.length)))
  .filter(Number.isInteger)
const tag = `${prefix}${taken.length ? Math.max(...taken) + 1 : 1}`
console.log(`source ${source.slice(0, 7)} -> ${tag}${dryRun ? ' (dry run)' : ''}`)
if (dryRun) {
  process.exit(0)
}

run(BUILD[0], BUILD[1])
git('switch', '--quiet', '--detach')
try {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  for (const name of LIFECYCLE) {
    delete pkg.scripts?.[name]
  }
  writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`)
  git('add', '-f', 'dist', 'package.json')
  git('commit', '--quiet', '--no-verify', '-m', `release: ${tag} (built dist/, install scripts stripped)`)
  git('tag', tag)
} finally {
  git('switch', '--quiet', 'main')
}

const sourceTag = `fork-${BASE}`
const existing = git('tag', '-l', sourceTag)
if (!existing) {
  git('tag', sourceTag, source)
} else if (git('rev-parse', `${sourceTag}^{commit}`) !== source) {
  console.log(
    `note: ${sourceTag} points at ${git('rev-parse', '--short', sourceTag)}, not ${source.slice(0, 7)}; ADR-038 moves it with main (owner call)`
  )
}

console.log(`built ${tag} = ${git('rev-parse', tag)} (${git('cat-file', '-t', tag)})`)
console.log(`push: git push origin main ${tag}${existing ? '' : ` ${sourceTag}`}`)
