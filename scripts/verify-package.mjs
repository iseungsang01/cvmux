/*
 * 포장한 앱이 실제로 뜰 수 있는지 확인한다 (P26-6).
 *
 * 2026-08-05에 `electron-updater`가 빠진 설치본을 릴리스로 내보냈다. 타입 검사도
 * 테스트도 통과했고 CI도 초록이었다 — 아무도 **포장한 앱을 실행해 보지 않았기**
 * 때문이다. 앱은 뜨자마자 `Cannot find module 'electron-updater'`로 죽었다.
 *
 * main 번들은 npm 패키지 몇 개를 밖에 남긴다(네이티브 모듈과 CJS 전용 모듈).
 * 그것들이 asar 안에 없으면 앱은 첫 줄에서 죽는다. 여기서 그 짝을 맞춰 본다 —
 * GUI를 띄우지 않으므로 CI에서 흔들리지 않는다.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const OUT_MAIN = join('out', 'main')
const UNPACKED = join('release', 'win-unpacked', 'resources')

/** `require("x")`에서 x가 npm 패키지인 것만 — node: 내장과 electron은 런타임이 준다 */
function externalRequires(code) {
  const found = new Set()
  for (const m of code.matchAll(/require\("([^"]+)"\)/g)) {
    const name = m[1]
    if (name.startsWith('.') || name.startsWith('node:') || name === 'electron') continue
    // `foo/bar`와 `@scope/foo/bar`에서 패키지 이름만 떼어 낸다
    const parts = name.split('/')
    found.add(name.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0])
  }
  return found
}

/** asar 헤더: [uint32 4][uint32 pickleSize][uint32 4][uint32 jsonLen][json] */
function asarNodeModules(path) {
  const buf = readFileSync(path)
  const jsonLen = buf.readUInt32LE(12)
  const header = JSON.parse(buf.subarray(16, 16 + jsonLen).toString('utf8'))
  const nm = header.files?.node_modules?.files ?? {}
  return new Set(
    Object.keys(nm).flatMap((k) =>
      k.startsWith('@') ? Object.keys(nm[k].files ?? {}).map((s) => `${k}/${s}`) : [k]
    )
  )
}

const asarPath = join(UNPACKED, 'app.asar')
if (!existsSync(asarPath)) {
  console.error(`[verify] ${asarPath} 이 없습니다. electron-builder를 먼저 돌리세요.`)
  process.exit(1)
}

const packaged = asarNodeModules(asarPath)
// 네이티브 모듈은 asar 밖에 풀려 있다(asarUnpack)
const unpackedDir = join(UNPACKED, 'app.asar.unpacked', 'node_modules')
if (existsSync(unpackedDir)) for (const name of readdirSync(unpackedDir)) packaged.add(name)

const needed = new Set()
for (const file of readdirSync(OUT_MAIN)) {
  if (!file.endsWith('.js')) continue
  for (const name of externalRequires(readFileSync(join(OUT_MAIN, file), 'utf8'))) needed.add(name)
}

const missing = [...needed].filter((name) => !packaged.has(name)).sort()

console.log(`[verify] main이 밖에 남긴 패키지: ${[...needed].sort().join(', ') || '(없음)'}`)
console.log(`[verify] 설치본에 담긴 패키지: ${packaged.size}개`)

if (missing.length > 0) {
  console.error(
    `\n[verify] 실패 — 설치본에 없는 모듈이 있습니다: ${missing.join(', ')}\n` +
      '앱은 뜨자마자 `Cannot find module`로 죽습니다.\n' +
      'electron-builder.yml의 files에서 node_modules를 지나치게 제외하고 있는지 보세요.\n'
  )
  process.exit(1)
}

console.log('[verify] 통과 — main이 요구하는 모듈이 모두 담겼습니다.')
