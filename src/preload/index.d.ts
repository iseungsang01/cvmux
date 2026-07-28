import type { CvmuxApi } from '@shared/types'

declare global {
  interface Window {
    cvmux: CvmuxApi
  }
}

export {}
