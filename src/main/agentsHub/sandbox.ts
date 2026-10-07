/**
 * 沙箱命令执行（EvoFlow D4/C 类）：在指定工作目录跑命令，超时截断输出
 */
import { exec } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { SandboxRun } from '../../shared/types.ts'
import { appendSandboxRun } from './store.ts'

const BLOCK = /\b(rm\s+-rf\s+[\/~]|mkfs|dd\s+if=|shutdown|reboot|format\s+c:)/i

export async function runSandboxCommand(
  cwd: string,
  command: string,
  timeoutMs = 30_000
): Promise<SandboxRun> {
  const id = randomUUID()
  const run: SandboxRun = {
    id,
    cwd,
    command,
    status: 'running',
    stdout: '',
    stderr: '',
    startedAt: Date.now()
  }
  await appendSandboxRun(run)
  if (BLOCK.test(command)) {
    run.status = 'failed'
    run.stderr = '命令被安全策略拒绝'
    run.endedAt = Date.now()
    await appendSandboxRun({ ...run })
    return run
  }
  try {
    await fs.mkdir(cwd, { recursive: true })
  } catch {
    /* ignore */
  }
  return new Promise((resolve) => {
    const child = exec(command, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 512 * 1024 }, (err, stdout, stderr) => {
      run.stdout = String(stdout || '').slice(0, 8000)
      run.stderr = String(stderr || '').slice(0, 4000)
      run.endedAt = Date.now()
      if (err && /ETIMEDOUT|timed out/i.test(String(err.message))) {
        run.status = 'timeout'
        run.stderr += `\n${err.message}`
      } else if (err) {
        run.status = 'failed'
        run.stderr += `\n${err.message}`
      } else {
        run.status = 'ok'
      }
      void appendSandboxRun({ ...run }).then(() => resolve(run))
    })
    void child
  })
}
