import { contextBridge, ipcRenderer } from 'electron'

// Narrow, explicit API surface - never a blanket passthrough of `electron` or
// `require` into the renderer. This is the entire main-process capability the
// renderer gets: ask for one or more log files, or for every log in one
// folder, and get back each file's name and text (or a per-file error), or a
// cancel. No other IPC channel is exposed, and no path ever travels in the
// renderer -> main direction.
export type LoadedFile = { fileName: string; text: string } | { fileName: string; error: string }

export type OpenLogFilesResult =
  | { canceled: true }
  | { canceled: false; files: LoadedFile[] }

export type OpenLogFolderResult =
  | { canceled: true }
  | { canceled: false; folderName: string; files: LoadedFile[] }

// 'kind' picks the dialog title/filter label and (for a folder) whether the
// "-merged" skip applies - see main/index.ts. Defaults to 'closed' so every
// existing call site keeps working unchanged.
export type LogFileKind = 'closed' | 'payout'

const api = {
  openLogFiles: (kind?: LogFileKind): Promise<OpenLogFilesResult> => ipcRenderer.invoke('ladderCap:openLogFiles', kind),
  openLogFolder: (kind?: LogFileKind): Promise<OpenLogFolderResult> => ipcRenderer.invoke('ladderCap:openLogFolder', kind)
}

contextBridge.exposeInMainWorld('ladderCapApi', api)

export type LadderCapApi = typeof api
