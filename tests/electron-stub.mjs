// 测试用 electron 替身：实现 tables.ts / docs/surgical 用到的 app API
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const userData = mkdtempSync(join(tmpdir(), 'lm-app-stub-'))
// 仓库根（tests/ 的上一级），供 app.getAppPath() → resources/tools/soffice 定位
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

export const app = {
  getPath: (name) => (name === 'temp' ? tmpdir() : userData),
  isPackaged: false,
  getAppPath: () => repoRoot
}
export default { app }
