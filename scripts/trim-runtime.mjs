/*
 * 포장이 끝난 앱에서 Chromium 런타임의 군더더기를 덜어낸다 (P26-7).
 *
 * electron-builder의 `files`는 asar 안쪽, 즉 우리가 쓴 코드와 npm 패키지만
 * 손댈 수 있다. Electron이 함께 놓는 DLL은 그 바깥에 있어 포장이 끝난 뒤에야
 * 지울 수 있고, 그래서 afterPack이다.
 *
 * 여기서 지우는 것은 **cvmux가 한 번도 호출하지 않는 기능**뿐이다. 무엇을
 * 남겼는지도 같이 적어 둔다 — 다음에 이 목록을 늘리려는 사람이 이유를 알고
 * 멈출 수 있도록.
 *
 * 남기는 것:
 *   libGLESv2.dll / libEGL.dll / d3dcompiler_47.dll
 *     xterm의 WebGL 렌더러가 ANGLE을 타고 D3D11로 내려간다. 터미널 스크롤
 *     성능이 여기에 달려 있다.
 *   LICENSES.chromium.html
 *     서드파티 라이선스 고지다. 20MB지만 지울 수 있는 종류의 파일이 아니다.
 */
import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** 지울 것과, 왜 우리와 무관한지 */
const DROP = [
  // WebGPU(Dawn)의 셰이더 컴파일러. cvmux는 WebGPU 컨텍스트를 만들지 않는다.
  ['dxcompiler.dll', 'WebGPU 셰이더 컴파일러'],
  ['dxil.dll', 'WebGPU 셰이더 서명'],
  // <video>/<audio>와 코덱. 터미널에는 재생할 것이 없다.
  ['ffmpeg.dll', '미디어 코덱'],
  /*
   * 소프트웨어 Vulkan. GPU가 없을 때의 폴백으로 알려져 있지만, 그 자리는
   * 이미 Skia의 CPU 래스터가 맡는다 — `--disable-gpu`로, 이 세 파일을 지운
   * 채로 앱을 띄워 창이 그대로 그려지는 것과 세션이 도는 것을 확인했다.
   * xterm의 WebGL 렌더러도 실패하면 DOM 렌더러로 물러난다(terminal-host.ts).
   */
  ['vk_swiftshader.dll', '소프트웨어 Vulkan'],
  ['vulkan-1.dll', 'Vulkan 로더'],
  ['vk_swiftshader_icd.json', 'SwiftShader 드라이버 등록 정보'],
]

export default async function trimRuntime(context) {
  const dir = context.appOutDir
  let freed = 0

  for (const [name, why] of DROP) {
    const path = join(dir, name)
    let size
    try {
      size = (await stat(path)).size
    } catch {
      // 이미 없다면 Electron 쪽에서 빠진 것이다 — 실패로 볼 일은 아니다.
      console.log(`[trim] ${name} 없음 — 건너뜀`)
      continue
    }
    await rm(path)
    freed += size
    console.log(`[trim] ${name} (${mb(size)}) 삭제 — ${why}`)
  }

  console.log(`[trim] 런타임에서 ${mb(freed)} 덜어냈습니다.`)
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`
