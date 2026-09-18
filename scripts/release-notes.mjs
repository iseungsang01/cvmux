#!/usr/bin/env node
/**
 * CHANGELOG.md에서 한 버전의 항목을 뽑아 릴리스 본문으로 쓴다.
 *
 *   node scripts/release-notes.mjs v0.1.7 [notes.md]
 *
 * 파일 이름을 주면 거기에 UTF-8로 쓴다. CI의 PowerShell이 표준 출력을 콘솔
 * 코드페이지로 풀어 한글을 깨뜨리므로, CI에서는 파일로 받는다.
 *
 * 항목이 없으면 실패한다 — 내역 없이 나간 릴리스는 나중에 아무도 채우지 않는다.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const version = (process.argv[2] ?? '').replace(/^v/, '')
if (!version) {
  console.error('사용법: node scripts/release-notes.mjs <버전>')
  process.exit(2)
}

const changelog = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md'), 'utf8')
const lines = changelog.split(/\r?\n/)
const start = lines.findIndex((line) => line.startsWith(`## ${version} `) || line === `## ${version}`)
if (start === -1) {
  console.error(`CHANGELOG.md에 ${version} 항목이 없습니다. 맨 위에 "## ${version} — 날짜"로 적어 주세요.`)
  process.exit(1)
}
const end = lines.findIndex((line, i) => i > start && line.startsWith('## '))
const body = lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim()
if (!body) {
  console.error(`CHANGELOG.md의 ${version} 항목이 비어 있습니다.`)
  process.exit(1)
}
const out = process.argv[3]
if (out) writeFileSync(out, `${body}\n`, 'utf8')
else process.stdout.write(`${body}\n`)
