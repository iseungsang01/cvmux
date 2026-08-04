/**
 * 페이지 안에서 도는 조작 코드 (POLICY.md P23-3).
 *
 * 에이전트가 브라우저를 쓰는 방식은 사람과 다르다. 좌표를 눌러 달라고 하지
 * 못하고, CSS 선택자는 페이지가 조금만 바뀌어도 어긋난다. 그래서
 * [agent-browser](https://github.com/vercel-labs/agent-browser)가 세운 방식을
 * 따른다 — **스냅샷이 각 요소에 안정된 이름(`e12`)을 붙이고, 조작은 그 이름을
 * 가리킨다.** cmux의 내장 브라우저도 같은 API를 쓴다.
 *
 * 여기 있는 것은 전부 페이지 컨텍스트에서 평가될 **문자열**이다. 페이지는 신뢰
 * 경계 밖이므로(P23-6) 값을 심을 때는 반드시 JSON으로 감싼다.
 */

/** 값을 코드에 안전하게 심는다. 문자열 연결로 스크립트를 만들지 않는다 */
function lit(value: unknown): string {
  return JSON.stringify(value ?? null)
}

/**
 * 참조 표를 만들거나 되찾는다.
 *
 * 페이지가 새로 로드되면 표도 사라진다. 그러면 조작 명령이 "그 요소가 없다"를
 * 돌려주고, 에이전트는 스냅샷을 다시 뜬다 — 잘못된 요소를 누르는 것보다 낫다.
 */
const RUNTIME = `
  (() => {
    const w = window;
    if (!w.__cvmux) {
      w.__cvmux = {
        refs: new Map(),
        next: 1,
        put(el) {
          for (const [k, v] of this.refs) if (v === el) return k;
          const ref = 'e' + this.next++;
          this.refs.set(ref, el);
          return ref;
        },
        get(ref) {
          const el = this.refs.get(ref);
          return el && el.isConnected ? el : null;
        },
        visible(el) {
          if (!(el instanceof Element)) return false;
          const style = getComputedStyle(el);
          if (style.visibility === 'hidden' || style.display === 'none') return false;
          if (Number(style.opacity) === 0) return false;
          const box = el.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        },
        label(el) {
          const aria = el.getAttribute('aria-label');
          if (aria) return aria.trim();
          if (el.id) {
            const forLabel = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
            if (forLabel) return (forLabel.textContent || '').trim();
          }
          const alt = el.getAttribute('alt');
          if (alt) return alt.trim();
          const title = el.getAttribute('title');
          if (title) return title.trim();
          const placeholder = el.getAttribute('placeholder');
          if (placeholder) return placeholder.trim();
          const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
          return text.length > 120 ? text.slice(0, 117) + '…' : text;
        },
        role(el) {
          const explicit = el.getAttribute('role');
          if (explicit) return explicit;
          const tag = el.tagName.toLowerCase();
          if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
          if (tag === 'button') return 'button';
          if (tag === 'select') return 'combobox';
          if (tag === 'textarea') return 'textbox';
          if (tag === 'input') {
            const type = (el.getAttribute('type') || 'text').toLowerCase();
            if (type === 'checkbox') return 'checkbox';
            if (type === 'radio') return 'radio';
            if (type === 'submit' || type === 'button') return 'button';
            return 'textbox';
          }
          if (/^h[1-6]$/.test(tag)) return 'heading';
          if (tag === 'img') return 'img';
          return null;
        }
      };
    }
    return w.__cvmux;
  })()
`

/**
 * 접근성 스냅샷 (P23-3).
 *
 * DOM 전체가 아니라 **역할이 있는 것과 사람이 읽을 글**만 담는다. 전체를 주면
 * 토큰이 감당되지 않고, 그 안에서 무엇을 눌러야 하는지도 알기 어렵다.
 */
export function snapshotScript(maxNodes: number): string {
  return `
    (() => {
      const cvmux = ${RUNTIME};
      const lines = [];
      let count = 0;

      const walk = (node, depth) => {
        if (count >= ${maxNodes}) return;
        if (!(node instanceof Element)) return;
        const tag = node.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'noscript') return;
        if (!cvmux.visible(node)) return;

        const role = cvmux.role(node);
        if (role !== null) {
          const label = cvmux.label(node);
          const ref = cvmux.put(node);
          const bits = [role];
          if (label) bits.push(JSON.stringify(label));
          if (node.disabled) bits.push('disabled');
          if (node.checked) bits.push('checked');
          if (node.value && role === 'textbox') bits.push('value=' + JSON.stringify(node.value));
          lines.push('  '.repeat(depth) + '- ' + bits.join(' ') + ' [' + ref + ']');
          count++;
          depth++;
        }
        for (const child of node.children) walk(child, depth);
      };

      walk(document.body, 0);
      return {
        url: location.href,
        title: document.title,
        truncated: count >= ${maxNodes},
        snapshot: lines.join('\\n')
      };
    })()
  `
}

/**
 * 던진 오류를 살려 보낸다 (P23-7).
 *
 * `executeJavaScript`는 스크립트가 던지면 "Script failed to execute"라는 한
 * 문장만 남기고 우리 메시지를 버린다. 에이전트에게 "그 요소가 더 이상 없으니
 * 스냅샷을 다시 뜨라"고 말해 줄 수 없으면 조작 API가 반쪽이다. 그래서 값으로
 * 감싸 돌려보내고, 소켓 쪽에서 다시 오류로 세운다.
 */
function guard(body: string): string {
  return `
    (() => {
      try {
        return (() => { ${body} })();
      } catch (error) {
        return { __cvmuxError: String((error && error.message) || error) };
      }
    })()
  `
}

/** 페이지가 돌려준 값이 위의 감싼 오류인가 */
export function unwrapError(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const wrapped = (value as { __cvmuxError?: unknown }).__cvmuxError
  return typeof wrapped === 'string' ? wrapped : null
}

/** ref 또는 CSS 선택자로 요소를 집는다. 둘 다 없으면 실패다 */
function resolve(ref: string | undefined, selector: string | undefined): string {
  return `
    (() => {
      const cvmux = ${RUNTIME};
      const ref = ${lit(ref)};
      const selector = ${lit(selector)};
      if (ref) {
        const el = cvmux.get(ref);
        if (!el) throw new Error('그 요소가 더 이상 없습니다: ' + ref + ' (스냅샷을 다시 뜨세요)');
        return el;
      }
      if (selector) {
        const el = document.querySelector(selector);
        if (!el) throw new Error('선택자에 맞는 요소가 없습니다: ' + selector);
        return el;
      }
      throw new Error('--ref 또는 --selector가 필요합니다');
    })()
  `
}

export function clickScript(ref?: string, selector?: string): string {
  return guard(`
    const el = ${resolve(ref, selector)};
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.click();
    return { clicked: true, tag: el.tagName.toLowerCase() };
  `)
}

/**
 * 입력 (P23-3).
 *
 * `value`만 바꾸면 React처럼 값을 스스로 들고 있는 화면은 알아채지 못한다.
 * 네이티브 setter로 넣고 이벤트를 직접 쏴야 프레임워크가 따라온다.
 */
export function fillScript(value: string, ref?: string, selector?: string): string {
  return guard(`
    const el = ${resolve(ref, selector)};
    const value = ${lit(value)};
    el.focus();
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { filled: true, value: el.value };
  `)
}

export function pressScript(key: string, ref?: string, selector?: string): string {
  const target = ref || selector ? resolve(ref, selector) : 'document.activeElement || document.body'
  return guard(`
    const el = ${target};
    const key = ${lit(key)};
    el.focus?.();
    const init = { key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    // Enter는 폼 제출을 뜻할 때가 많다 — 이벤트만으로는 아무 일도 일어나지 않는다
    if (key === 'Enter' && el.form) el.form.requestSubmit?.();
    return { pressed: key };
  `)
}

/** 페이지에서 값을 읽는다. what은 고정된 목록이라 페이지가 정하지 못한다 */
export function getScript(what: string, ref?: string, selector?: string): string {
  return guard(`
    const what = ${lit(what)};
      if (what === 'url') return location.href;
      if (what === 'title') return document.title;
      if (what === 'html') return document.documentElement.outerHTML;
      if (what === 'text' && !${lit(ref)} && !${lit(selector)}) return document.body.innerText;

      const el = ${resolve(ref, selector)};
      if (what === 'text') return (el.innerText || el.textContent || '').trim();
      if (what === 'value') return el.value ?? null;
      if (what === 'count') return document.querySelectorAll(${lit(selector ?? '*')}).length;
      if (what === 'box') { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; }
    throw new Error('읽을 수 있는 것: url, title, text, html, value, count, box');
  `)
}

/**
 * 조건을 기다린다 (P23-4).
 *
 * 제한 시간은 **여기서 지킨다**. 페이지가 영영 그 상태가 되지 않아도 호출한
 * 쪽은 반드시 답을 받아야 한다 — 소켓 클라이언트를 무한정 매달아 두지 않는다.
 */
export function waitScript(
  kind: 'selector' | 'text' | 'load',
  value: string,
  timeoutMs: number
): string {
  return `
    (async () => {
      try {
        return await new Promise((resolve, reject) => {
      const kind = ${lit(kind)};
      const value = ${lit(value)};
      const deadline = Date.now() + ${timeoutMs};

      const ok = () => {
        if (kind === 'selector') return document.querySelector(value) !== null;
        if (kind === 'text') return (document.body.innerText || '').includes(value);
        return document.readyState === 'complete';
      };

      const tick = () => {
        if (ok()) { resolve({ waited: kind, value }); return; }
        if (Date.now() > deadline) { reject(new Error('기다렸지만 나타나지 않았습니다: ' + value)); return; }
        setTimeout(tick, 50);
      };
          tick();
        });
      } catch (error) {
        return { __cvmuxError: String(error && error.message || error) };
      }
    })()
  `
}
