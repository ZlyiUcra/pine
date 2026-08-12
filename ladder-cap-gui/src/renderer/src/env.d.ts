import type { LadderCapApi } from '../../preload/index'

declare global {
  interface Window {
    ladderCapApi: LadderCapApi
  }
}

export {}
