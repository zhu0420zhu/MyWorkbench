/** 统一用户可读错误文案：隐藏底层堆栈，保留可行动信息 */
export function formatError(err: unknown, fallback = '操作失败'): string {
  if (!err) return fallback
  const raw = err instanceof Error ? err.message : String(err)
  const msg = raw.trim()
  if (!msg) return fallback
  // 常见英文技术错误 → 中文摘要
  const map: Array<[RegExp, string]> = [
    [/ENOENT|no such file/i, '文件不存在或已被移动'],
    [/EACCES|EPERM|permission/i, '没有读写权限'],
    [/ENOSPC|disk full/i, '磁盘空间不足'],
    [/EMFILE|too many open/i, '打开文件过多，请稍后重试'],
    [/Invalid PDF|PDFDocument/i, 'PDF 解析失败，文件可能已损坏'],
    [/password|encrypt/i, '需要密码或文件已加密'],
    [/timeout|超时/i, '处理超时'],
    [/ffmpeg|soffice|spawn/i, '外部工具执行失败']
  ]
  for (const [re, label] of map) {
    if (re.test(msg)) return label
  }
  // 过长堆栈截断
  return msg.length > 120 ? msg.slice(0, 120) + '…' : msg
}
