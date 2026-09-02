/* 公众号凭证管理：AppID/Secret 用 Electron safeStorage 加密存储（userData/publish-gzh.json） */
import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export interface GzhCredential {
  appId: string
  secret: string
}

function file(): string {
  return join(app.getPath('userData'), 'publish-gzh.json')
}

export async function getGzhCredential(): Promise<GzhCredential | null> {
  try {
    const raw = JSON.parse(await fs.readFile(file(), 'utf8')) as { appId: string; secretEnc: string }
    if (!raw.appId || !raw.secretEnc) return null
    if (!safeStorage.isEncryptionAvailable()) return null
    const secret = safeStorage.decryptString(Buffer.from(raw.secretEnc, 'base64'))
    return { appId: raw.appId, secret }
  } catch {
    return null
  }
}

export async function saveGzhCredential(appId: string, secret: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统安全存储不可用（safeStorage 无法加密）')
  }
  const secretEnc = safeStorage.encryptString(secret).toString('base64')
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(file(), JSON.stringify({ appId: appId.trim(), secretEnc }, null, 2), 'utf8')
}

export async function clearGzhCredential(): Promise<void> {
  try {
    await fs.unlink(file())
  } catch {
    /* 不存在则忽略 */
  }
}
