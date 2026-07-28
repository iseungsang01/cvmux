import { createRoot } from 'react-dom/client'

import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { App } from './App'

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

// StrictMode를 쓰지 않는다 — effect 이중 실행이 xterm 인스턴스와 PTY 구독을
// 두 벌 만들어 스크롤백이 깨진다. 인스턴스 수명은 terminal-host가 직접 관리한다(P5-1).
createRoot(container).render(<App />)
