import { useEffect, useMemo, useRef, useState, type JSX } from 'react'

import { filterCommands, type Command } from '../lib/palette'

/**
 * 명령 팔레트 (POLICY.md P21-6).
 *
 * 단축키는 외운 사람에게만 열린 문이다. 팔레트는 이름의 일부만 기억하면
 * 되는 입구이고, 동시에 **단축키를 가르치는 자리**다 — 항목 오른쪽에 늘
 * 조합을 함께 적는다.
 */

export interface CommandPaletteProps {
  commands: Command[]
  open: boolean
  onClose(): void
}

export function CommandPalette(props: CommandPaletteProps): JSX.Element | null {
  const { commands, open, onClose } = props
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const matches = useMemo(() => filterCommands(commands, query), [commands, query])

  // 열 때마다 빈 질의로 시작한다 — 지난번에 친 글자가 남아 있으면 놀란다
  useEffect(() => {
    if (!open) return
    setQuery('')
    setCursor(0)
    inputRef.current?.focus()
  }, [open])

  // 목록이 줄어 커서가 밖으로 나가면 끌어당긴다
  useEffect(() => {
    setCursor((c) => (c >= matches.length ? Math.max(0, matches.length - 1) : c))
  }, [matches.length])

  // 커서가 보이는 자리에 있게 한다
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    list.children[cursor]?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  if (!open) return null

  const run = (index: number): void => {
    const match = matches[index]
    if (!match) return
    // 먼저 닫는다 — 명령이 포커스를 옮기는데 팔레트가 아직 떠 있으면 뺏어 온다
    onClose()
    match.command.run()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    // 한글 조합 중의 화살표·엔터는 IME의 것이다. P6-4
    if (event.nativeEvent.isComposing) return

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setCursor((c) => (matches.length === 0 ? 0 : (c + 1) % matches.length))
        break
      case 'ArrowUp':
        event.preventDefault()
        setCursor((c) => (matches.length === 0 ? 0 : (c - 1 + matches.length) % matches.length))
        break
      case 'Enter':
        event.preventDefault()
        run(cursor)
        break
      case 'Escape':
        event.preventDefault()
        onClose()
        break
      default:
        break
    }
  }

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-label="명령 팔레트"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          type="text"
          value={query}
          placeholder="명령 검색…"
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value)
            setCursor(0)
          }}
          onKeyDown={onKeyDown}
        />

        {matches.length === 0 ? (
          <div className="palette-empty">맞는 명령이 없습니다.</div>
        ) : (
          <ul className="palette-list" ref={listRef}>
            {matches.map((match, index) => (
              <li
                key={match.command.id}
                className={`palette-item${index === cursor ? ' is-cursor' : ''}`}
                onMouseMove={() => setCursor(index)}
                onMouseDown={(event) => {
                  event.preventDefault()
                  run(index)
                }}
              >
                <span className="palette-section">{match.command.section}</span>
                <span className="palette-title">
                  {highlight(match.command.title, match.hits)}
                </span>
                {match.command.hint ? (
                  <span className="palette-hint">{match.command.hint}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/** 맞은 글자에 표시를 남긴다 — 왜 이것이 걸렸는지 보이게 */
function highlight(title: string, hits: number[]): JSX.Element[] {
  const set = new Set(hits)
  return [...title].map((char, i) =>
    set.has(i) ? (
      <mark key={i} className="palette-hit">
        {char}
      </mark>
    ) : (
      <span key={i}>{char}</span>
    )
  )
}
