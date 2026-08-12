import { app, BrowserWindow, dialog, ipcMain, session } from 'electron'
import { readFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

// Renderer never gets a file path from us in the other direction - the path
// only ever comes out of the native dialog below, main reads it, and only
// the file NAME (for display) and its TEXT content cross back over IPC. See
// .specify/consilium/2026-08-07-electron-ladder-cap-gui.md for why this
// removes the "untrusted path over IPC" vector entirely rather than just
// validating it.
const ALLOWED_EXTENSIONS = new Set(['.csv', '.log', '.txt'])

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    mainWindow.loadURL(rendererUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // No remote content is ever loaded, but the CSP is kept as a backstop: if
  // a future dependency ever pulled in an external script by accident, this
  // is what stops it from running.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'"]
      }
    })
  })

  // 'payout' reuses this exact handler rather than a second, near-identical
  // copy - see .specify/consilium/2026-08-11-ladder-cap-payout-crossref.md
  // (security/best-practices condition). Only the dialog title and filter
  // label change; the file-read path, ALLOWED_EXTENSIONS check and error
  // shape are shared.
  ipcMain.handle('ladderCap:openLogFiles', async (_event, kind: 'closed' | 'payout' = 'closed') => {
    const result = await dialog.showOpenDialog({
      title: kind === 'payout' ? 'Open payout logs' : 'Open closed logs',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: kind === 'payout' ? 'Payout log files' : 'Log files', extensions: ['csv', 'log', 'txt'] }]
    })
    if (result.canceled || !result.filePaths.length) return { canceled: true as const }

    // A bad file (wrong extension, unreadable) is reported per-file rather
    // than aborting the whole selection - the renderer decides whether to
    // still load the rest, same as the CLI would if you fixed the argv list.
    const files = result.filePaths.map((filePath) => {
      const fileName = basename(filePath)
      if (!ALLOWED_EXTENSIONS.has(extname(filePath).toLowerCase())) {
        return { fileName, error: 'unsupported file type: ' + extname(filePath) }
      }
      try {
        return { fileName, text: readFileSync(filePath, 'utf8') }
      } catch (err) {
        return { fileName, error: err instanceof Error ? err.message : String(err) }
      }
    })

    return { canceled: false as const, files }
  })

  // Same contract as openLogFiles - the path never comes from the renderer,
  // only out of the native dialog - but the selection is a whole directory
  // instead of a hand-picked list. Only the TOP level of the chosen folder is
  // read: no recursion, and only real files (a subdirectory or a symlink to
  // one is not followed).
  //
  // Two things are dropped before anything crosses back:
  //   - anything that is not a .csv/.log/.txt, silently. A log folder holds
  //     scripts and notes too, and listing those as errors would bury the
  //     real skips.
  //   - anything whose name ends in "-merged", reported as a skip WITH its
  //     reason. Per the naming convention in checks/, those files are a
  //     hand-made union of their siblings in the same folder, so reading both
  //     would feed the same windows in twice (user, 2026-08-08). Hand-picking
  //     one through openLogFiles above still works - this rule is only for
  //     "take the whole folder", where nobody vetted the list.
  // Same 'payout' reuse as openLogFiles above. The "-merged" skip is a
  // convention of the closed-log naming scheme only - a payout log is never
  // produced that way (one file per calendar day, po-payouts-YYYY-MM-DD.log),
  // so it is skipped entirely for kind === 'payout' rather than silently
  // rejecting a real file that happens to end in "-merged".
  ipcMain.handle('ladderCap:openLogFolder', async (_event, kind: 'closed' | 'payout' = 'closed') => {
    const result = await dialog.showOpenDialog({
      title: kind === 'payout' ? 'Open a folder of payout logs' : 'Open a folder of closed logs',
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths.length) return { canceled: true as const }

    const dir = result.filePaths[0]
    const folderName = basename(dir)

    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      return {
        canceled: false as const,
        folderName,
        files: [{ fileName: folderName, error: err instanceof Error ? err.message : String(err) }]
      }
    }

    const wanted = entries
      .filter((e) => e.isFile() && ALLOWED_EXTENSIONS.has(extname(e.name).toLowerCase()))
      .map((e) => e.name)
      .sort()

    const files = await Promise.all(
      wanted.map(async (fileName) => {
        if (kind === 'closed' && basename(fileName, extname(fileName)).toLowerCase().endsWith('-merged')) {
          return { fileName, error: 'merged file, its parts are in this folder too' }
        }
        try {
          return { fileName, text: await readFile(join(dir, fileName), 'utf8') }
        } catch (err) {
          return { fileName, error: err instanceof Error ? err.message : String(err) }
        }
      })
    )

    return { canceled: false as const, folderName, files }
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
