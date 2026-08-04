# NOTICE

cvmux는 [cmux](https://github.com/manaflow-ai/cmux)(Copyright © 2024-present
Manaflow, Inc., GPL-3.0-or-later)에서 파생된 저작물을 포함한다. 따라서 cvmux
전체가 **GPL-3.0-or-later**로 배포된다. 자세한 조건은 [LICENSE](./LICENSE)를 보라.

cvmux는 Manaflow, Inc.와 아무 관계가 없고 후원받지도 않았다.

## 무엇을 가져왔는가

cmux는 Swift + AppKit + libghostty로 만든 macOS 앱이고 cvmux는 Electron +
TypeScript로 만든 Windows 앱이라, **바이너리로 재사용할 수 있는 코드는 없다.**
파생은 다음 세 가지 형태다.

| 형태 | cmux 원본 | cvmux 대응 |
|------|-----------|-----------|
| **동작 명세를 그대로 채택** | `docs/cli-contract.md`, `docs/events.md`, `docs/notifications.md`, `docs/configuration.md`, `docs/agent-hooks.md` | [POLICY.md](./POLICY.md), `src/shared/protocol.ts` |
| **로직을 Swift → TypeScript로 번역** | `Sources/Sidebar/`, `Packages/macOS/`, `CLI/` | `src/core/`, `src/main/`, `src/cli/` |
| **TypeScript 코드를 이식** | `webviews/src/` | `src/renderer/browser/` |

macOS 고유 동작(⌘ 키 조합, Sparkle 자동 업데이트, Unix 도메인 소켓,
`~/Library/Application Support`)은 Windows 등가물(Ctrl/Alt 조합, named pipe,
`%APPDATA%`)로 옮겼다. 이 대응 관계는 [POLICY.md](./POLICY.md)에 규칙 ID로
적혀 있다.

## 제3자 구성요소

| 구성요소 | 라이선스 |
|---------|---------|
| [Electron](https://github.com/electron/electron) | MIT |
| [xterm.js](https://github.com/xtermjs/xterm.js) | MIT |
| [node-pty](https://github.com/microsoft/node-pty) | MIT |
| [React](https://github.com/facebook/react) | MIT |

MIT 구성요소는 GPL-3.0과 호환되며 각자의 라이선스 아래 배포된다.
