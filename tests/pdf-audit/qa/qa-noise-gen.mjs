/**
 * 任务 #12 —— QA 自有造图器与度量（与 diag-*.mjs / test-enhance-algo.mjs 内部 helper 独立实现）。
 *
 * 目的：让「主峰连通带 + Δ≥20」契约的验证不依赖被测/被测方自带的构造器。
 *   - makeScanPage：可指定 模型/种子/尺寸/灰线位置，忠实复刻四种噪声模型的语义
 *     （噪声 RNG 的消费顺序与原实现逐像素一致，故同种子可复现同一张图）。
 *   - 度量：lineIndices / paperIndices(±2) / meanLumaAt —— 均按【契约原文】口径独立实现。
 *
 * 契约（源自 test-enhance-algo.mjs §13/§14，本文件只实现、不修改之）：
 *   ① cls.paperBandLo > grayLevel                  —— 灰线确在带【外】（属独立灰阶）
 *   ② Δ_after = mean(纸底像素) − mean(灰线像素) ≥ 20 —— 增强后仍与纸底可辨
 *   ③ mean(灰线) < 245                              —— 灰线未被白化抹平
 *   ④ 带【内】像素（in-band）在 medium/strong 下被推白（契约 b）
 */

/** Rec.601 亮度（与被测内部一致；此处独立实现，避免依赖被测代码） */
export const lumAt = (d, i) => (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000

/** 灰线像素索引（按 4 字节步长） */
export function lineIndices(W, line) {
  const idx = []
  for (let y = line.y0; y < line.y1; y++)
    for (let x = line.x0; x < line.x1; x++) idx.push((y * W + x) * 4)
  return idx
}

/** 纸底参照像素索引：原图亮度贴近主峰 ±2（契约原文口径） */
export function paperIndices(src, W, paperMode, tol = 2) {
  const idx = []
  for (let i = 0; i < src.length; i += 4) {
    if (Math.abs(lumAt(src, i) - paperMode) <= tol) idx.push(i)
  }
  return idx
}

export const meanLumaAt = (d, idx) => (idx.length ? idx.reduce((s, i) => s + lumAt(d, i), 0) / idx.length : NaN)

/**
 * 造「发灰扫描件 + 一条灰阶内容线」，噪声模型可选。
 *
 * ⚠ 噪声 RNG 的消费顺序与原诊断脚本逐像素一致（先整页刷噪声、再覆盖灰线），
 *   故同 seed + 同尺寸 + 同模型 ⇒ 与原脚本得到同一张底噪图。
 *
 * @param model 'N1'|'N2'|'N3'|'N4'
 */
export function makeScanPage(
  W,
  H,
  {
    model = 'N1',
    paper = 215,
    ink = 150,
    grayLevel = 178,
    seed = 20260928,
    line = { x0: 300, x1: 520, y0: 300, y1: 308 },
    inkProb = 0.16,
    rowFrac = 0.006
  } = {}
) {
  const d = new Uint8ClampedArray(W * H * 4)
  const inkMask = new Uint8Array(W * H) // 真值：1 = 合成时的墨迹像素
  let s = seed >>> 0
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const gauss = () => {
    const u = Math.max(1e-9, rnd())
    const v = rnd()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
  const rowH = Math.max(1, Math.round(H * rowFrac))
  const gap = Math.max(rowH + 1, Math.round(rowH * 2.2))

  for (let y = 0; y < H; y++) {
    const inTextRow = y % gap < rowH
    for (let x = 0; x < W; x++) {
      let v
      let isInk = false
      if (inTextRow && rnd() < inkProb) {
        isInk = true
        v = ink + (rnd() - 0.5) * 10
      } else {
        switch (model) {
          case 'N1':
            v = paper + (rnd() - 0.5) * 16
            break
          case 'N2':
            v = paper + gauss() * 10
            break
          case 'N3':
            v = rnd() < 0.015 ? 150 + rnd() * 60 : paper + (rnd() - 0.5) * 16
            break
          case 'N4':
            v = 195 + ((x / W) * 0.6 + (y / H) * 0.4) * 50 + (rnd() - 0.5) * 6
            break
          default:
            throw new Error(`未知噪声模型: ${model}`)
        }
      }
      const p = y * W + x
      const i = p * 4
      const c = Math.max(0, Math.min(255, v))
      d[i] = d[i + 1] = d[i + 2] = c
      d[i + 3] = 255
      if (isInk) inkMask[p] = 1
    }
  }
  // 覆盖一条灰阶内容线（与诊断脚本一致：噪声先铺满，再覆盖线区）；line=null 表示不画线
  if (line) {
    for (let y = line.y0; y < line.y1; y++)
      for (let x = line.x0; x < line.x1; x++) {
        const i = (y * W + x) * 4
        d[i] = d[i + 1] = d[i + 2] = grayLevel
      }
  }
  return { data: d, inkMask, line }
}

/** 集合交集大小（用于判「纸底参照集」与「灰线集」是否互斥） */
export function intersectSize(a, b) {
  const sb = new Set(b)
  let n = 0
  for (const v of a) if (sb.has(v)) n++
  return n
}
