/* 媒体工具 IPC：图片工具 + 视频工具 + 音频工具 */
import { ipcMain, dialog, BrowserWindow } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { app } from 'electron'
import {
  probeMedia,
  convertMedia,
  extractFrame,
  videoToGif,
  extractAudio,
  trimMedia,
  ffmpegAvailable,
  type MediaProbe,
  type MediaOpResult
} from './ffmpeg.ts'

export interface MediaFilePick {
  path: string
  name: string
  size: number
}

/** 会话内允许读写的路径集合：共享 pathAcl（与其他 IO 模块同一份白名单） */
import { allowPath, isPathAllowed } from '../pathAcl'

const MAX_IO_BYTES = 500 * 1024 * 1024

function pickFilters(kind: 'image' | 'video' | 'audio' | 'media'): Electron.FileFilter[] {
  if (kind === 'image') {
    return [
      { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'svg', 'ico', 'tiff', 'tif'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  }
  if (kind === 'audio') {
    return [
      { name: '音频', extensions: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'aiff', 'alac'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  }
  if (kind === 'video') {
    return [
      { name: '视频', extensions: ['mp4', 'avi', 'mkv', 'mov', 'webm', 'flv', 'wmv', 'ts', 'm4v', '3gp'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  }
  return [
    {
      name: '媒体文件',
      extensions: [
        'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'svg', 'ico',
        'mp4', 'avi', 'mkv', 'mov', 'webm', 'flv', 'wmv', 'ts', 'm4v',
        'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma'
      ]
    },
    { name: '所有文件', extensions: ['*'] }
  ]
}

async function pickMediaFiles(
  event: Electron.IpcMainInvokeEvent,
  kind: 'image' | 'video' | 'audio' | 'media',
  multi: boolean,
  title: string
): Promise<MediaFilePick[]> {
  const win = BrowserWindow.fromWebContents(event.sender)
  const opts: Electron.OpenDialogOptions = {
    title,
    filters: pickFilters(kind),
    properties: multi ? ['openFile', 'multiSelections'] : ['openFile']
  }
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (result.canceled || result.filePaths.length === 0) return []
  const out: MediaFilePick[] = []
  for (const p of result.filePaths) {
    try {
      const buf = await readFile(p)
      allowPath(p)
      out.push({ path: p, name: basename(p), size: buf.byteLength })
    } catch {
      allowPath(p)
      out.push({ path: p, name: basename(p), size: 0 })
    }
  }
  return out
}

async function saveMediaPath(
  event: Electron.IpcMainInvokeEvent,
  defaultName: string,
  filters: Electron.FileFilter[]
): Promise<string | null> {
  const win = BrowserWindow.fromWebContents(event.sender)
  const opts: Electron.SaveDialogOptions = {
    title: '导出文件',
    defaultPath: defaultName,
    filters
  }
  const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  if (result.canceled || !result.filePath) return null
  allowPath(result.filePath)
  return result.filePath
}

function defaultOutPath(sourcePath: string, suffix: string, ext: string): string {
  const dir = dirname(sourcePath)
  const base = basename(sourcePath, extname(sourcePath))
  return join(dir, `${base}${suffix}${ext}`)
}

export function registerMediaIpc(): void {
  ipcMain.handle('media:ffmpeg-available', () => ffmpegAvailable())

  ipcMain.handle('media:pick-images', (e) => pickMediaFiles(e, 'image', true, '选择图片'))
  ipcMain.handle('media:pick-image', (e) => pickMediaFiles(e, 'image', false, '选择图片'))
  ipcMain.handle('media:pick-videos', (e) => pickMediaFiles(e, 'video', true, '选择视频'))
  ipcMain.handle('media:pick-video', (e) => pickMediaFiles(e, 'video', false, '选择视频'))
  ipcMain.handle('media:pick-audios', (e) => pickMediaFiles(e, 'audio', true, '选择音频'))
  ipcMain.handle('media:pick-audio', (e) => pickMediaFiles(e, 'audio', false, '选择音频'))
  ipcMain.handle('media:pick-media', (e) => pickMediaFiles(e, 'media', false, '选择媒体文件'))

  ipcMain.handle('media:save-path', (e, defaultName: string, exts: string[]) =>
    saveMediaPath(
      e,
      defaultName,
      exts.length ? [{ name: '导出文件', extensions: exts.map((x) => x.replace(/^\./, '')) }] : [{ name: '所有文件', extensions: ['*'] }]
    )
  )

  ipcMain.handle('media:read-file', async (_e, filePath: string): Promise<Uint8Array | null> => {
    if (!isPathAllowed(filePath)) return null
    try {
      const buf = await readFile(filePath)
      if (buf.byteLength > MAX_IO_BYTES) return null
      return new Uint8Array(buf)
    } catch {
      return null
    }
  })

  ipcMain.handle('media:write-file', async (_e, filePath: string, data: Uint8Array): Promise<boolean> => {
    if (!isPathAllowed(filePath)) return false
    if (data.byteLength > MAX_IO_BYTES) return false
    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, Buffer.from(data))
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('media:probe', (_e, filePath: string): Promise<MediaProbe> => probeMedia(filePath))

  ipcMain.handle(
    'media:convert',
    async (
      _e,
      input: {
        sourcePath: string
        targetFormat: string
        outputPath?: string
        quality?: 'low' | 'medium' | 'high'
        kind?: 'video' | 'audio' | 'gif'
      }
    ): Promise<MediaOpResult> => {
      const out =
        input.outputPath ||
        defaultOutPath(input.sourcePath, '', input.targetFormat.startsWith('.') ? input.targetFormat : `.${input.targetFormat}`)
      return convertMedia(input.sourcePath, input.targetFormat, out, input.quality ?? 'medium', {
        kind: input.kind
      })
    }
  )

  ipcMain.handle(
    'media:extract-frame',
    async (
      _e,
      input: {
        sourcePath: string
        timeSec: number
        outputPath?: string
        format?: 'png' | 'jpg' | 'webp'
        width?: number
      }
    ): Promise<MediaOpResult> => {
      const ext = input.format === 'jpg' ? '.jpg' : input.format === 'webp' ? '.webp' : '.png'
      const out = input.outputPath || defaultOutPath(input.sourcePath, `-${Math.round(input.timeSec * 1000)}ms`, ext)
      return extractFrame(input.sourcePath, input.timeSec, out, {
        format: input.format ?? 'png',
        width: input.width
      })
    }
  )

  ipcMain.handle(
    'media:video-to-gif',
    async (
      _e,
      input: {
        sourcePath: string
        startSec: number
        endSec: number
        outputPath?: string
        fps?: number
        width?: number
      }
    ): Promise<MediaOpResult> => {
      const out =
        input.outputPath ||
        defaultOutPath(input.sourcePath, `-${Math.round(input.startSec)}s-${Math.round(input.endSec)}s`, '.gif')
      return videoToGif(input.sourcePath, input.startSec, input.endSec, out, {
        fps: input.fps,
        width: input.width
      })
    }
  )

  ipcMain.handle(
    'media:extract-audio',
    async (
      _e,
      input: {
        sourcePath: string
        outputPath?: string
        targetFormat?: string
        quality?: 'low' | 'medium' | 'high'
      }
    ): Promise<MediaOpResult> => {
      const tf = input.targetFormat?.startsWith('.') ? input.targetFormat : `.${input.targetFormat || 'mp3'}`
      const out = input.outputPath || defaultOutPath(input.sourcePath, '-audio', tf)
      return extractAudio(input.sourcePath, out, tf, input.quality ?? 'medium')
    }
  )

  ipcMain.handle(
    'media:trim',
    async (
      _e,
      input: {
        sourcePath: string
        startSec: number
        endSec: number
        outputPath?: string
        reencode?: boolean
      }
    ): Promise<MediaOpResult> => {
      const ext = extname(input.sourcePath) || '.mp4'
      const out =
        input.outputPath || defaultOutPath(input.sourcePath, `-${Math.round(input.startSec)}s-${Math.round(input.endSec)}s`, ext)
      return trimMedia(input.sourcePath, input.startSec, input.endSec, out, { reencode: input.reencode })
    }
  )

  // 图片格式转换（本地读写，Canvas 无法处理时回退 ffmpeg）
  ipcMain.handle(
    'media:image-convert',
    async (
      _e,
      input: {
        sourcePath: string
        targetFormat: string
        outputPath?: string
        quality?: 'low' | 'medium' | 'high'
      }
    ): Promise<MediaOpResult> => {
      const tf = input.targetFormat.startsWith('.') ? input.targetFormat : `.${input.targetFormat}`
      const out = input.outputPath || defaultOutPath(input.sourcePath, '', tf)
      // SVG 等特殊格式交给 ffmpeg/后续处理
      return convertMedia(input.sourcePath, tf, out, input.quality ?? 'medium', {
        kind: tf === '.gif' ? 'gif' : 'video'
      })
    }
  )
}
