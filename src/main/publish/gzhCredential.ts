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

function encSecret(secret: string): string {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(secret).toString('base64')
    }
  } catch {
    /* fall through */
  }
  // 与 AI Key 同策略：安全存储不可用时弱加密回退，保证功能可用
  return 'plain:' + Buffer.from(secret, 'utf-8').toString('base64')
}

function decSecret(enc: string): string {
  if (!enc) return ''
  if (enc.startsWith('plain:')) {
    try {
      return Buffer.from(enc.slice(6), 'base64').toString('utf-8')
    } catch {
      return ''
    }
  }
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'))
    }
  } catch {
    /* ignore */
  }
  return ''
}

export async function getGzhCredential(): Promise<GzhCredential | null> {
  try {
    const raw = JSON.parse(await fs.readFile(file(), 'utf8')) as { appId: string; secretEnc: string }
    if (!raw.appId || !raw.secretEnc) return null
    const secret = decSecret(raw.secretEnc)
    if (!secret) return null
    return { appId: raw.appId, secret }
  } catch {
    return null
  }
}

export async function saveGzhCredential(appId: string, secret: string): Promise<void> {
  const secretEnc = encSecret(secret)
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
