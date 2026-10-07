/* ============================================
 * 格式转换器（移植自 ck 06_格式转换引擎：ffmpeg/imagemagick/libreoffice/pandoc）
 * 每个转换器封装一个底层外部工具，声明源→目标格式映射，convert() 调起工具执行。
 * 外部二进制依赖说明：ffmpeg / ImageMagick / LibreOffice / Pandoc 需存在
 *   - 优先 resources/tools 目录（打包内置），否则回退系统 PATH。
 *   工具缺失时 isAvailable()=false，注册表会自动跳过该转换器（非破坏性）。
 * ============================================ */

import { existsSync, readdirSync } from 'node:fs'
import { join, parse } from 'node:path'
import { BaseConverter, normFormat, safeSize } from './baseConverter.ts'
import type { ConversionResult, FormatMap } from './types.ts'

/* ---------------- FFmpeg（视频/音频） ---------------- */

function buildFfmpegMap(): FormatMap {
  const videoFormats = ['.mp4', '.avi', '.mkv', '.webm', '.mov', '.flv', '.wmv', '.ts', '.m4v', '.3gp']
  const videoTargets = ['.mp4', '.avi', '.mkv', '.webm', '.mov', '.flv', '.wmv', '.ts', '.gif', '.mp3', '.wav']
  const audioFormats = ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.wma', '.m4a', '.aiff', '.opus']
  const audioTargets = ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.wma', '.m4a', '.aiff', '.opus']
  const map: FormatMap = {}
  for (const vf of videoFormats) map[vf] = videoTargets.filter((t) => t !== vf)
  for (const af of audioFormats) map[af] = audioTargets.filter((t) => t !== af)
  map['.gif'] = ['.mp4', '.webm', '.avi']
  return map
}

export class FFmpegConverter extends BaseConverter {
  name = 'ffmpeg'
  formatMap: FormatMap = buildFfmpegMap()

  isAvailable(): boolean {
    return this.checkToolAvailable('ffmpeg')
  }

  async convert(
    sourcePath: string,
    targetFormat: string,
    outputDir?: string,
    quality = 'medium',
    kwargs: Record<string, unknown> = {}
  ): Promise<ConversionResult> {
    const start = Date.now()
    const tf = normFormat(targetFormat)
    const outDir = this.ensureOutputDir(sourcePath, outputDir)
    const targetPath = this.getOutputPath(sourcePath, tf, outDir)
    const sizeBefore = safeSize(sourcePath)

    const cmd = this.buildCommand(sourcePath, targetPath, tf, quality, kwargs)
    const [success, error] = await this.runCommand(cmd, 600)
    const duration = (Date.now() - start) / 1000
    const sizeAfter = success ? safeSize(targetPath) : 0

    return {
      success,
      sourcePath,
      targetPath: success ? targetPath : null,
      targetFormat: tf,
      converterName: this.name,
      duration,
      error,
      fileSizeBefore: sizeBefore,
      fileSizeAfter: sizeAfter
    }
  }

  private buildCommand(
    sourcePath: string,
    targetPath: string,
    targetFormat: string,
    quality: string,
    kwargs: Record<string, unknown>
  ): string[] {
    const ffmpeg = this.getToolPath('ffmpeg')
    const cmd = [ffmpeg, '-y', '-i', sourcePath]
    const videoCodec = kwargs.videoCodec as string | undefined
    const audioCodec = kwargs.audioCodec as string | undefined

    if (['.mp4', '.m4v', '.mov'].includes(targetFormat)) {
      if (!videoCodec) cmd.push('-c:v', 'libx264')
      if (!audioCodec) cmd.push('-c:a', 'aac')
    } else if (targetFormat === '.webm') {
      if (!videoCodec) cmd.push('-c:v', 'libvpx-vp9')
      if (!audioCodec) cmd.push('-c:a', 'libopus')
    } else if (targetFormat === '.avi') {
      if (!videoCodec) cmd.push('-c:v', 'mpeg4')
      if (!audioCodec) cmd.push('-c:a', 'mp3')
    } else if (targetFormat === '.mkv') {
      if (!videoCodec) cmd.push('-c:v', 'libx265')
      if (!audioCodec) cmd.push('-c:a', 'aac')
    }

    if (quality === 'low') cmd.push('-crf', '28', '-preset', 'ultrafast')
    else if (quality === 'high') cmd.push('-crf', '18', '-preset', 'slow')
    else cmd.push('-crf', '23', '-preset', 'medium')

    const audioFormats = ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.wma', '.m4a', '.aiff', '.opus']
    if (audioFormats.includes(targetFormat)) {
      cmd.push('-vn')
      if (quality === 'low') cmd.push('-b:a', '96k')
      else if (quality === 'high') cmd.push('-b:a', '320k')
      else cmd.push('-b:a', '192k')
    }

    if (targetFormat === '.gif') cmd.push('-vf', 'fps=15,scale=640:-1:flags=lanczos')
    cmd.push(targetPath)
    return cmd
  }
}

/* ---------------- ImageMagick（图片） ---------------- */

function buildImagemagickMap(): FormatMap {
  const imageFormats = [
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.tif',
    '.webp', '.ico', '.svg', '.heic', '.heif', '.avif',
    '.psd', '.raw', '.ppm', '.pgm', '.pbm', '.xcf'
  ]
  const imageTargets = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.webp', '.ico', '.pdf', '.avif', '.heic']
  const map: FormatMap = {}
  for (const f of imageFormats) map[f] = imageTargets.filter((t) => t !== f)
  map['.pdf'] = ['.png', '.jpg', '.jpeg', '.tiff', '.webp']
  return map
}

/**
 * 判断路径是否落在 Windows 系统目录（SystemRoot / System32）。
 * Windows 自带 `C:\Windows\System32\convert.exe` 是 NTFS/FAT 卷转换工具，
 * 与 ImageMagick 的 `convert` 同名但完全无关——必须显式排除，否则
 * `which('convert')` 会命中它造成「imagemagick 可用=true」的假阳性。
 */
function isWindowsSystemPath(p: string): boolean {
  if (process.platform !== 'win32') return false
  const norm = p.toLowerCase().replace(/\//g, '\\')
  const winDir = (process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows')
    .toLowerCase()
    .replace(/\//g, '\\')
  return norm.startsWith(`${winDir}\\`) || norm.includes('\\system32\\')
}

export class ImageMagickConverter extends BaseConverter {
  name = 'imagemagick'
  formatMap: FormatMap = buildImagemagickMap()

  /**
   * 解析真正的 ImageMagick 可执行文件：
   * 优先内置 resources/tools → 系统 PATH；仅在没有 `magick` 时才考虑旧版 `convert`，
   * 且 `convert` 命中 Windows 系统目录时视为非 ImageMagick（见 isWindowsSystemPath）。
   */
  private resolveBinary(): string | null {
    const bundledMagick = this.resolveBundledTool('magick')
    if (bundledMagick) return bundledMagick
    const bundledConvert = this.resolveBundledTool('convert')
    if (bundledConvert && !isWindowsSystemPath(bundledConvert)) return bundledConvert
    const whichMagick = this.which('magick')
    if (whichMagick) return whichMagick
    const whichConvert = this.which('convert')
    if (whichConvert && !isWindowsSystemPath(whichConvert)) return whichConvert
    return null
  }

  isAvailable(): boolean {
    return this.resolveBinary() !== null
  }

  private getCommandPrefix(): string {
    // isAvailable() 为 false 时注册表会跳过该转换器，此处仅作兜底
    return this.resolveBinary() ?? this.getToolPath('magick')
  }

  async convert(
    sourcePath: string,
    targetFormat: string,
    outputDir?: string,
    quality = 'medium',
    kwargs: Record<string, unknown> = {}
  ): Promise<ConversionResult> {
    const start = Date.now()
    const tf = normFormat(targetFormat)
    const outDir = this.ensureOutputDir(sourcePath, outputDir)
    const targetPath = this.getOutputPath(sourcePath, tf, outDir)
    const sizeBefore = safeSize(sourcePath)

    const cmd = this.buildCommand(sourcePath, targetPath, tf, quality, kwargs)
    const [success, error] = await this.runCommand(cmd, 120)
    const duration = (Date.now() - start) / 1000
    const sizeAfter = success ? safeSize(targetPath) : 0

    return {
      success,
      sourcePath,
      targetPath: success ? targetPath : null,
      targetFormat: tf,
      converterName: this.name,
      duration,
      error,
      fileSizeBefore: sizeBefore,
      fileSizeAfter: sizeAfter
    }
  }

  private buildCommand(
    sourcePath: string,
    targetPath: string,
    targetFormat: string,
    quality: string,
    kwargs: Record<string, unknown>
  ): string[] {
    const prefix = this.getCommandPrefix()
    const cmd = [prefix, sourcePath]

    if (['.jpg', '.jpeg'].includes(targetFormat)) {
      if (quality === 'low') cmd.push('-quality', '50')
      else if (quality === 'high') cmd.push('-quality', '95')
      else cmd.push('-quality', '80')
    } else if (targetFormat === '.webp') {
      if (quality === 'low') cmd.push('-quality', '40')
      else if (quality === 'high') cmd.push('-quality', '90')
      else cmd.push('-quality', '70')
    }

    const resize = kwargs.resize as string | undefined
    if (resize) cmd.push('-resize', resize)

    const density = kwargs.density as string | undefined
    if (density) cmd.push('-density', density)

    if (sourcePath.toLowerCase().endsWith('.pdf') && !density) cmd.push('-density', '150')

    cmd.push(targetPath)
    return cmd
  }
}

/* ---------------- LibreOffice（文档/表格/演示） ---------------- */

const LO_OUTPUT_FILTERS: Record<string, string> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.doc': 'doc',
  '.odt': 'odt',
  '.rtf': 'rtf',
  '.txt': 'txt:Text',
  '.html': 'html',
  '.xlsx': 'xlsx',
  '.xls': 'xls',
  '.ods': 'ods',
  '.csv': 'csv:Text - txt - csv (StarCalc)',
  '.pptx': 'pptx',
  '.ppt': 'ppt',
  '.odp': 'odp',
  '.png': 'png'
}

function buildLibreOfficeMap(): FormatMap {
  const docFormats = ['.doc', '.docx', '.odt', '.rtf', '.txt', '.html', '.htm', '.wps']
  const docTargets = ['.pdf', '.docx', '.doc', '.odt', '.rtf', '.txt', '.html']
  const sheetFormats = ['.xls', '.xlsx', '.ods', '.csv', '.tsv', '.et']
  const sheetTargets = ['.pdf', '.xlsx', '.xls', '.ods', '.csv']
  const slideFormats = ['.ppt', '.pptx', '.odp', '.dps']
  const slideTargets = ['.pdf', '.pptx', '.ppt', '.odp']
  const pdfTargets = ['.docx', '.odt', '.txt', '.html', '.png']
  const map: FormatMap = {}
  for (const f of docFormats) map[f] = docTargets.filter((t) => t !== f)
  for (const f of sheetFormats) map[f] = sheetTargets.filter((t) => t !== f)
  for (const f of slideFormats) map[f] = slideTargets.filter((t) => t !== f)
  map['.pdf'] = pdfTargets
  return map
}

const LO_WIN_PATHS = [
  'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'
]

export class LibreOfficeConverter extends BaseConverter {
  name = 'libreoffice'
  formatMap: FormatMap = buildLibreOfficeMap()

  isAvailable(): boolean {
    if (this.checkToolAvailable('soffice')) return true
    if (process.platform !== 'win32' && this.checkToolAvailable('libreoffice')) return true
    if (process.platform === 'win32') {
      return LO_WIN_PATHS.some((p) => existsSync(p))
    }
    return false
  }

  private getLoCommand(): string {
    const bundled = this.getToolPath('soffice')
    if (bundled !== 'soffice' && existsSync(bundled)) return bundled
    if (process.platform === 'win32') {
      const found = LO_WIN_PATHS.find((p) => existsSync(p))
      if (found) return found
    }
    if (this.checkToolAvailable('libreoffice')) return this.getToolPath('libreoffice')
    return this.getToolPath('soffice')
  }

  async convert(
    sourcePath: string,
    targetFormat: string,
    outputDir?: string,
    _quality = 'medium',
    _kwargs: Record<string, unknown> = {}
  ): Promise<ConversionResult> {
    const start = Date.now()
    const tf = normFormat(targetFormat)
    const outDir = this.ensureOutputDir(sourcePath, outputDir)
    const sizeBefore = safeSize(sourcePath)

    const outputFilter = LO_OUTPUT_FILTERS[tf] ?? tf.replace(/^\./, '')
    const loCmd = this.getLoCommand()
    const cmd = [loCmd, '--headless', '--convert-to', outputFilter, '--outdir', outDir, sourcePath]

    const [success, error] = await this.runCommand(cmd, 300)
    const targetPath = success ? this.findOutputFile(sourcePath, tf, outDir) : null
    const duration = (Date.now() - start) / 1000
    const sizeAfter = targetPath ? safeSize(targetPath) : 0

    return {
      success: success && targetPath !== null,
      sourcePath,
      targetPath,
      targetFormat: tf,
      converterName: this.name,
      duration,
      error: !success ? error : targetPath === null ? '输出文件未找到' : '',
      fileSizeBefore: sizeBefore,
      fileSizeAfter: sizeAfter
    }
  }

  private findOutputFile(sourcePath: string, targetFormat: string, outputDir: string): string | null {
    const stem = parse(sourcePath).name
    const expected = join(outputDir, `${stem}${targetFormat}`)
    if (existsSync(expected)) return expected
    try {
      const entries = readdirSync(outputDir)
      for (const name of entries) {
        if (name.toLowerCase().endsWith(targetFormat) && name.toLowerCase().includes(stem.toLowerCase())) {
          return join(outputDir, name)
        }
      }
    } catch {
      /* ignore */
    }
    return null
  }
}

/* ---------------- Pandoc（文档标记格式） ---------------- */

function buildPandocMap(): FormatMap {
  const markdownFormats = ['.md', '.markdown', '.mkd']
  const docFormats = ['.docx', '.odt', '.rtf', '.epub', '.rst', '.org']
  const webFormats = ['.html', '.htm']
  const latexFormats = ['.tex', '.latex']
  const textFormats = ['.txt', '.csv']
  const allTargets = ['.pdf', '.docx', '.odt', '.rtf', '.epub', '.html', '.md', '.tex', '.rst', '.org', '.txt', '.pptx']
  const map: FormatMap = {}
  for (const f of [...markdownFormats, ...docFormats, ...webFormats, ...latexFormats]) {
    map[f] = allTargets.filter((t) => t !== f)
  }
  for (const f of textFormats) map[f] = ['.html', '.md', '.docx', '.pdf']
  return map
}

export class PandocConverter extends BaseConverter {
  name = 'pandoc'
  formatMap: FormatMap = buildPandocMap()

  isAvailable(): boolean {
    return this.checkToolAvailable('pandoc')
  }

  async convert(
    sourcePath: string,
    targetFormat: string,
    outputDir?: string,
    _quality = 'medium',
    kwargs: Record<string, unknown> = {}
  ): Promise<ConversionResult> {
    const start = Date.now()
    const tf = normFormat(targetFormat)
    const outDir = this.ensureOutputDir(sourcePath, outputDir)
    const targetPath = this.getOutputPath(sourcePath, tf, outDir)
    const sizeBefore = safeSize(sourcePath)

    const pandoc = this.getToolPath('pandoc')
    const cmd = [pandoc, sourcePath, '-o', targetPath]
    if (tf === '.pdf') {
      const pdfEngine = (kwargs.pdfEngine as string) ?? 'xelatex'
      cmd.push('--pdf-engine', pdfEngine)
    }
    if (kwargs.toc) cmd.push('--toc')
    if (kwargs.template) cmd.push('--template', kwargs.template as string)

    const [success, error] = await this.runCommand(cmd, 120)
    const duration = (Date.now() - start) / 1000
    const sizeAfter = success ? safeSize(targetPath) : 0

    return {
      success,
      sourcePath,
      targetPath: success ? targetPath : null,
      targetFormat: tf,
      converterName: this.name,
      duration,
      error,
      fileSizeBefore: sizeBefore,
      fileSizeAfter: sizeAfter
    }
  }

  /**
   * 「导出成书」专用：输出路径由调用方指定（用户"另存为"的位置），
   * 并支持写入书名 / 作者等 EPUB 元数据与目录。
   * 与 convert() 的区别：convert 自动生成输出路径、不支持 metadata。
   *
   * 额外支持（EPUB / HTML 排版所需）：
   * - css        注入样式表（Pandoc `--css`，EPUB 会被打进包内，HTML 则外链/内联）
   * - coverImage EPUB 封面图（Pandoc `--epub-cover-image`，仅 .epub 目标生效）
   * - lang       文档语言元数据（`--metadata lang=zh-CN`，影响 EPUB 断行与阅读器字体选择）
   * - tocDepth   目录层级深度（`--toc-depth`）
   * - standalone 输出完整文档（HTML 需要，含 head/style）
   *
   * 注：EPUB 分章不用 `--split-level`（Pandoc 3.0+ 才有，旧版是 --epub-chapter-level），
   * 改由样式表 `h1 { page-break-before: always }` 实现，兼容所有 Pandoc 版本。
   */
  async convertTo(
    sourcePath: string,
    targetPath: string,
    kwargs: {
      title?: string
      author?: string
      toc?: boolean
      pdfEngine?: string
      css?: string
      coverImage?: string
      lang?: string
      tocDepth?: number
      standalone?: boolean
    } = {}
  ): Promise<{ success: boolean; error: string | null }> {
    const pandoc = this.getToolPath('pandoc')
    const lower = targetPath.toLowerCase()
    const cmd = [pandoc, sourcePath, '-o', targetPath]
    if (lower.endsWith('.pdf')) {
      cmd.push('--pdf-engine', kwargs.pdfEngine ?? 'xelatex')
    }
    if (kwargs.toc) cmd.push('--toc')
    if (kwargs.toc && kwargs.tocDepth) cmd.push('--toc-depth', String(kwargs.tocDepth))
    if (kwargs.title) cmd.push('--metadata', `title=${kwargs.title}`)
    if (kwargs.author) cmd.push('--metadata', `author=${kwargs.author}`)
    if (kwargs.lang) cmd.push('--metadata', `lang=${kwargs.lang}`)
    // --css 对 EPUB / HTML 有效；PDF/DOCX 传了会被 Pandoc 忽略，但为稳妥仅在这两类目标传
    if (kwargs.css && (lower.endsWith('.epub') || lower.endsWith('.html') || lower.endsWith('.htm')))
      cmd.push('--css', kwargs.css)
    if (kwargs.coverImage && lower.endsWith('.epub'))
      cmd.push('--epub-cover-image', kwargs.coverImage)
    if (kwargs.standalone) cmd.push('--standalone')
    const [success, error] = await this.runCommand(cmd, 300)
    return { success, error }
  }
}
