/**
 * PDF 文字增强的图像处理算法层。
 *
 * 设计原则：全部为「纯 typed-array 运算」——不依赖 canvas / DOM，
 * 因此可在 Node 中无头单元测试（见 tests/pdf-audit/test-enhance-algo.mjs）。
 * 页面层只负责「渲染到 canvas → getImageData → 调这里 → putImageData」。
 *
 * 针对的真实场景：扫描件文字发灰、纸底发黄、笔画糊。
 * 流水线：墨迹感知色阶（去灰雾）→ 中间调 gamma（加粗笔画）→ 纸底白化（折入 LUT）→ 反锐化掩模。
 *
 * ⚠ 关键原则（历史回归的教训）：
 *   **对原图算一次「墨迹/纸底」分类，之后所有阈值都在各自类内取分位；
 *    绝不在【已变形】的图上重算统计量。**
 *   旧实现先对全图取百分位求色阶，再在【拉过色阶的图】上重算 Otsu 做白化——
 *   前者在纸底占比 >88% 时把两个百分位双双吸进纸底平台（色阶被当成"退化"整段关闭），
 *   后者因色阶后直方图出现空档而把阈值塌到墨迹簇下沿（啃掉墨迹，属内容丢失）。
 */

export interface Levels {
  /** 输入黑场（0..1，按亮度归一化） */
  blackPoint: number
  /** 输入白场（0..1） */
  whitePoint: number
}

export interface EnhanceParams extends Levels {
  /**
   * 中间调 gamma。对归一化亮度 t∈(0,1) 取 t^gamma：
   *   gamma > 1 → 【压暗】中间调（把发灰的笔画推向纯黑，笔画视觉上加粗）
   *   gamma < 1 → 提亮中间调
   *   gamma = 1 → 不变
   */
  gamma: number
  /** 锐化强度 0..1，0 表示不锐化 */
  sharpen: number
  /** 是否转灰度（扫描件通常不需要彩色） */
  grayscale: boolean
  /**
   * 背景白化容差 tol（0 = 不白化；越大越激进）。
   * 白化下界由 whitenFloor() 依据「纸底类主导峰带宽」算出：
   *   paperFloor = max(paperBandLo - spread*tol, split+1)
   * 只作用于与主导背景峰连成一片的像素，独立灰阶（浅灰表格线等）不受影响。
   */
  whiten: number
}

export type EnhanceStrength = 'light' | 'medium' | 'strong'

export interface StrengthPreset {
  /** 墨迹类内分位（0..1）。越高 → 越多墨迹被压成纯黑 → 笔画越粗 */
  blackQ: number
  /** 纸底类内分位（0..1）：决定色阶白场（越高 → 白场越低 → 色阶上端压得越狠）。
   *  注意：白化激进度由 whiten 控制（见 whitenFloor），whiteQ 只定色阶上端。 */
  whiteQ: number
  gamma: number
  sharpen: number
  grayscale: boolean
  /** 白化容差 tol（见 whitenFloor）：0 = 不白化；越大 → 白化下界越低 → 越多背景提纯。
   *  注意：这不是「0..1 的比例」，而是「相对主峰带宽的扩展系数」。 */
  whiten: number
  /** 栅格化倍率。三档【相同】——见 STRENGTH_PRESETS 注释 */
  renderScale: number
}

/**
 * 三档参数：**构造上单调**。
 *   blackQ 随强度递增（0.30 → 0.55 → 0.70）：黑场越来越高 → 越多墨迹压成纯黑。
 *   whiten 随强度递增（0.0 → 0.5 → 1.0）：白化容差越大 → 背景提纯越彻底。
 *   gamma  随强度递增（1.00 → 1.03 → 1.06）：中间调越压越暗 → 发灰笔画更实。
 *   sharpen 非递减（0 → 0 → 0.2）。
 * 各项同时收紧，对比度因而单调上升 —— 不依赖任何"事后调参"。
 *
 * ⚠ renderScale 三档【相同】（产品理由）：输出分辨率一致，文件体积可预期，
 *   用户不会因切换强度而看到清晰度/体积突变。
 *   （附注：更高倍率会让重采样后的灰边变宽、抬高 haze 度量值，这也是统一倍率的副作用之一，
 *     但它是"度量公平性"层面的观察，不是这里统一倍率的首要理由。）
 */
export const STRENGTH_PRESETS: Record<EnhanceStrength, StrengthPreset> = {
  light: { blackQ: 0.30, whiteQ: 0.35, gamma: 1.0, sharpen: 0.0, grayscale: true, whiten: 0.0, renderScale: 2.0 },
  medium: { blackQ: 0.55, whiteQ: 0.20, gamma: 1.03, sharpen: 0.0, grayscale: true, whiten: 0.5, renderScale: 2.0 },
  strong: { blackQ: 0.70, whiteQ: 0.10, gamma: 1.06, sharpen: 0.2, grayscale: true, whiten: 1.0, renderScale: 2.0 }
}

export interface ImageStats {
  meanLuma: number
  /** 亮度标准差 —— 衡量整体对比度，增强后应显著上升 */
  stdLuma: number
  /** 暗像素（<100）占比 —— 文字主体，增强后应上升 */
  darkRatio: number
  /** 亮像素（>200）占比 —— 纸底，增强后应上升 */
  lightRatio: number
  /** 「灰雾」像素占比：亮度落在 140..210 之间，扫描件的典型脏底 */
  hazeRatio: number
}

/** 亮度提取（Rec.601），避免在多处重复同一个加权式 */
function lumaAt(data: Uint8ClampedArray, i: number): number {
  return (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000
}

const clampByte = (y: number): number => (y < 0 ? 0 : y > 255 ? 255 : y | 0)

/** 计算亮度统计（用于量化增强效果） */
export function analyze(data: Uint8ClampedArray): ImageStats {
  const n = data.length / 4
  let sum = 0
  let sumSq = 0
  let dark = 0
  let light = 0
  let haze = 0
  for (let i = 0; i < data.length; i += 4) {
    const y = lumaAt(data, i)
    sum += y
    sumSq += y * y
    if (y < 100) dark++
    else if (y > 200) light++
    if (y >= 140 && y <= 210) haze++
  }
  const mean = sum / n
  const variance = Math.max(0, sumSq / n - mean * mean)
  return {
    meanLuma: mean,
    stdLuma: Math.sqrt(variance),
    darkRatio: dark / n,
    lightRatio: light / n,
    hazeRatio: haze / n
  }
}

/* ==================== 墨迹 / 纸底 分类 ==================== */

export interface ToneClasses {
  /** Otsu 分割点（0..255，对【原图】计算）。墨迹 = luma <= split；纸底 = luma > split。 */
  split: number
  /** 墨迹类（luma <= split）内的 q 分位（0..255） */
  inkQuantile(q: number): number
  /** 纸底类（luma > split）内的 q 分位（0..255） */
  paperQuantile(q: number): number
  /** 纸底类直方图的【主峰】（众数）灰度，代表「主导背景」的典型亮度。 */
  paperMode: number
  /** 主峰邻域带宽下界：自主峰向左扩展，直到桶计数降到主峰计数的 10% 以下。 */
  paperBandLo: number
  /** 主峰邻域带宽上界：自主峰向右扩展，规则同上。 */
  paperBandHi: number
}

/** 由 256 桶直方图求 Otsu 最佳分割阈值 */
function otsuFromHist(hist: Uint32Array, n: number): number {
  let sumAll = 0
  for (let v = 0; v < 256; v++) sumAll += v * hist[v]
  let wB = 0
  let sumB = 0
  let best = 0
  let bestVar = -1
  for (let v = 0; v < 256; v++) {
    wB += hist[v]
    if (wB === 0) continue
    const wF = n - wB
    if (wF === 0) break
    sumB += v * hist[v]
    const mB = sumB / wB
    const mF = (sumAll - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > bestVar) {
      bestVar = between
      best = v
    }
  }
  return best
}

/** 在直方图的 [lo,hi] 闭区间内取分位（q ∈ [0,1]），返回亮度值 */
function quantileInRange(hist: Uint32Array, lo: number, hi: number, total: number, q: number): number {
  if (total <= 0) return lo
  const qq = q < 0 ? 0 : q > 1 ? 1 : q
  const target = qq * total
  let acc = 0
  for (let v = lo; v <= hi; v++) {
    acc += hist[v]
    if (acc >= target) return v
  }
  return hi
}

/**
 * 对【原图】做一次墨迹/纸底分类，并暴露「类内分位」查询。
 *
 * 返回 null 的情形（此时才是真的「无可分离两类」）：
 *   - 全图动态范围 < 16（纯色页 / 近乎纯色）
 *   - 分割后某一类为空或像素过少（无法稳定取分位）
 *
 * ⚠ 纸底占比再高也【不会】返回 null —— 只要存在墨迹，两类就可分。
 *   这正是旧退化保护（white-black<16 即整段关闭色阶）的错误所在：
 *   它把「正需要处理的高纸底占比页」误判成了「纯色页」。
 */
export function classifyTones(data: Uint8ClampedArray): ToneClasses | null {
  const n = data.length / 4
  if (n === 0) return null
  const hist = new Uint32Array(256)
  let lo = 255
  let hi = 0
  for (let i = 0; i < data.length; i += 4) {
    const b = clampByte(lumaAt(data, i))
    hist[b]++
    if (b < lo) lo = b
    if (b > hi) hi = b
  }
  if (hi - lo < 16) return null

  const split = otsuFromHist(hist, n)
  let inkCount = 0
  for (let v = 0; v <= split; v++) inkCount += hist[v]
  const paperCount = n - inkCount
  // 两类都要有足够像素，分位才稳定；否则视为不可分（交给满量程兜底）
  if (inkCount < 16 || paperCount < 16) return null

  // —— 纸底类「主导背景峰」与带宽 ——
  // 白化只应作用于【与主导背景峰连成一片】的像素。带宽必须用【桶的连通性】判定，
  // 而不是纸底类的分位差：分位差会把远端的独立灰阶（浅灰表格线、浅色图例）也算进去，
  // 得到一个过宽的带，反而把那些独立灰阶一起吞掉。
  // 做法：自主峰向两侧扩展，只要相邻桶【非空】就继续；遇到空桶即停。
  //   - 数字原生页：浅灰表格线与背景峰之间有直方图空档 → 带宽在主峰处即停止；
  //   - 发灰扫描件：脏纸底与背景峰连成一片（无空档）→ 带宽覆盖整条背景分布。
  // 用【非空】而非「主峰计数的百分比」：扫描件的背景拖尾每个桶计数都远低于主峰，
  // 用百分比阈值会在主峰处立刻截断，白化失效。
  let paperMode = split + 1
  let peak = 0
  for (let v = split + 1; v <= 255; v++) {
    if (hist[v] > peak) {
      peak = hist[v]
      paperMode = v
    }
  }
  let paperBandLo = paperMode
  while (paperBandLo - 1 > split && hist[paperBandLo - 1] > 0) paperBandLo--
  let paperBandHi = paperMode
  while (paperBandHi + 1 <= 255 && hist[paperBandHi + 1] > 0) paperBandHi++

  return {
    split,
    inkQuantile: (q: number) => quantileInRange(hist, 0, split, inkCount, q),
    paperQuantile: (q: number) => quantileInRange(hist, split + 1, 255, paperCount, q),
    paperMode,
    paperBandLo,
    paperBandHi
  }
}

/**
 * 计算纸底白化下界 paperFloor。
 *
 * 只白化【与主导背景峰连成一片】的像素，下界落在这条连续背景带之内：
 *   spread     = paperBandHi - paperBandLo
 *   paperFloor = clamp( round(paperBandLo + spread * (1 - tol)), split + 1, 256 )
 *   tol = 1 → 下沿（整条背景带全推白，最激进）
 *   tol → 0 → 上沿（最保守；tol = 0 直接不白化，返回 256）
 * 因为 paperFloor >= split + 1，而墨迹 <= split，所以永不啃墨迹。
 *
 * 为什么下界【不越过带宽下沿】：越界会重新吞掉紧贴背景带下沿的独立灰阶
 *   （例如扫描件上比脏纸底略深的浅灰批注）。停在带内，可保证这类内容不被白化。
 *
 * tol 与「脏纸底清理程度」的关系：
 *   - 发灰扫描件：脏纸底就是整条背景带，tol 越大清得越干净；
 *   - 数字原生页：背景带只有纯白主峰（与浅灰内容间有空档），下界恒为纯白 → 不动内容。
 */
export function whitenFloor(classes: ToneClasses, tol: number): number {
  if (tol <= 0) return 256
  const spread = classes.paperBandHi - classes.paperBandLo
  const floor = Math.round(classes.paperBandLo + spread * (1 - tol))
  return Math.min(256, Math.max(floor, classes.split + 1))
}

/**
 * 自动色阶（墨迹感知）。
 *
 * @param inkQuantile  墨迹类内分位（越高 → 黑场越高 → 越多墨迹压成纯黑）
 * @param paperQuantile 纸底类内分位（越低 → 白场越低 → 越多纸底提到纯白）
 *
 * 注：参数名为「类内分位」而非旧版的「全图百分位」——这是本函数语义的实质改变。
 * 旧诊断脚本曾传入 preset.lowPercentile/highPercentile；那两个字段只是 blackQ/whiteQ 的
 * 冗余别名，已随任务 #10 一并删除，调用方应直接传 STRENGTH_PRESETS[s].blackQ / .whiteQ。
 */
export function autoLevels(
  data: Uint8ClampedArray,
  inkQuantile: number,
  paperQuantile: number
): Levels {
  const classes = classifyTones(data)
  // 真·无可分离两类（纯色页）→ 满量程 = 不做色阶，避免放大噪点
  if (!classes) return { blackPoint: 0, whitePoint: 1 }
  const black = classes.inkQuantile(inkQuantile)
  const white = classes.paperQuantile(paperQuantile)
  // 类间本就有 split 分隔，white > black 必然成立；仍留一道保险
  if (white <= black) return { blackPoint: 0, whitePoint: 1 }
  return { blackPoint: black / 255, whitePoint: white / 255 }
}

/* ==================== LUT（色阶 + gamma + 白化） ==================== */

/**
 * 预计算 256 项查找表：色阶 + gamma，并把「纸底白化」折进来。
 *
 * paperFloor：原图亮度 >= 该值直接映射为 255；>=256 表示不白化。
 * 由于 paperFloor 取自【纸底类内分位】必然 > split，而墨迹 <= split，
 * 因此构造上保证了「任何墨迹像素都不可能被白化」——无需任何防呆判断。
 *
 * ⚠ 折入 LUT 只在 grayscale 模式下严格等价（LUT 按亮度索引）：
 *   当前三档 grayscale 均为 true。若将来放开彩色（逐通道查表），
 *   白化必须改回「按原始亮度驱动的独立一遍」，否则会按通道误白化。
 */
function buildLut(levels: Levels, gamma: number, paperFloor: number): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256)
  const lo = levels.blackPoint * 255
  const hi = levels.whitePoint * 255
  const span = Math.max(1e-6, hi - lo)
  for (let v = 0; v < 256; v++) {
    if (v >= paperFloor) {
      lut[v] = 255
      continue
    }
    let t = (v - lo) / span
    t = t < 0 ? 0 : t > 1 ? 1 : t
    if (gamma !== 1) t = Math.pow(t, gamma)
    lut[v] = t * 255
  }
  return lut
}

/** 用 LUT 就地改写像素（grayscale 时按亮度索引三通道同值） */
function applyLutInPlace(data: Uint8ClampedArray, lut: Uint8ClampedArray, grayscale: boolean): void {
  if (grayscale) {
    for (let i = 0; i < data.length; i += 4) {
      const v = lut[clampByte(lumaAt(data, i))]
      data[i] = v
      data[i + 1] = v
      data[i + 2] = v
    }
    return
  }
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lut[data[i]]
    data[i + 1] = lut[data[i + 1]]
    data[i + 2] = lut[data[i + 2]]
  }
}

/** 应用色阶 + gamma（可选把白化折入）。paperFloor 默认 256 = 不白化。 */
export function applyLevels(data: Uint8ClampedArray, p: EnhanceParams, paperFloor = 256): void {
  const lut = buildLut({ blackPoint: p.blackPoint, whitePoint: p.whitePoint }, p.gamma, paperFloor)
  applyLutInPlace(data, lut, p.grayscale)
}

/* ==================== Otsu（保留导出，供诊断） ==================== */

/**
 * Otsu 法求前景（墨迹）/ 背景（纸底）的最佳分割阈值。
 * 遍历 256 个候选阈值，取「类间方差」最大者——无需人工设参，自适应任意扫描件。
 */
export function otsuThreshold(data: Uint8ClampedArray): number {
  const hist = new Uint32Array(256)
  const n = data.length / 4
  for (let i = 0; i < data.length; i += 4) hist[clampByte(lumaAt(data, i))]++
  return otsuFromHist(hist, n)
}

/* ==================== 锐化 ==================== */

/**
 * 可分离盒式模糊（水平+垂直两趟，用滑动和做到 O(n)）。
 * 只处理亮度通道并写回三通道，返回模糊后的亮度数组。
 * 用盒式而非高斯：三趟盒式已足够近似，且常数更小、无乘法。
 */
function boxBlurLuma(data: Uint8ClampedArray, width: number, height: number, radius: number): Float32Array {
  const n = width * height
  const luma = new Float32Array(n)
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    luma[j] = lumaAt(data, i)
  }
  const tmp = new Float32Array(n)
  const out = new Float32Array(n)
  const w = radius * 2 + 1
  // 水平方向
  for (let y = 0; y < height; y++) {
    const row = y * width
    let sum = 0
    for (let x = -radius; x <= radius; x++) sum += luma[row + Math.min(width - 1, Math.max(0, x))]
    for (let x = 0; x < width; x++) {
      tmp[row + x] = sum / w
      const add = luma[row + Math.min(width - 1, x + radius + 1)]
      const sub = luma[row + Math.max(0, x - radius)]
      sum += add - sub
    }
  }
  // 垂直方向
  for (let x = 0; x < width; x++) {
    let sum = 0
    for (let y = -radius; y <= radius; y++) sum += tmp[Math.min(height - 1, Math.max(0, y)) * width + x]
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / w
      const add = tmp[Math.min(height - 1, y + radius + 1) * width + x]
      const sub = tmp[Math.max(0, y - radius) * width + x]
      sum += add - sub
    }
  }
  return out
}

/**
 * 反锐化掩模：out = src + amount * (src - blur)。
 * 只把锐化量作用在亮度差上并按原色比例施加，避免彩色边缘产生色散。
 */
export function applySharpen(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  amount: number,
  radius = 1
): void {
  if (amount <= 0 || width < 3 || height < 3) return
  const blur = boxBlurLuma(data, width, height, radius)
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    // 该像素的「亮度高频量」
    const high = (lumaAt(data, i) - blur[j]) * amount
    if (high === 0) continue
    data[i] = data[i] + high
    data[i + 1] = data[i + 1] + high
    data[i + 2] = data[i + 2] + high
  }
}

/* ==================== 流水线 ==================== */

/**
 * 完整增强流水线：墨迹感知色阶 + gamma（+ 白化折入）→ 反锐化掩模。
 * 返回实际使用的参数，便于在 UI 上如实展示"本次做了什么"。
 *
 * 返回：
 *   whitenThreshold —— 纸底白化下界 paperFloor（原图亮度 >= 它即推纯白）；256 = 未白化。
 *   whitenApplied   —— 本次是否真的执行了白化（paperFloor < 256 即 true，面板据此如实说明）。
 *
 * ⚠ sharpen 的实测增益：色阶已把输出推向两端（墨迹→0、纸底→255，近二值化），
 *   反锐化掩模在高对比边缘上被钳位抵消，实测梯度能量 0.2 与 0.85 完全相同（≈31.94），
 *   该参数【仅在低对比页上有效】，不要把它当成一个有意义的强度旋钮。
 */
export function enhanceImageData(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  strength: EnhanceStrength
): { params: EnhanceParams; auto: Levels; whitenThreshold: number; whitenApplied: boolean } {
  const preset = STRENGTH_PRESETS[strength]
  // 对【原图】算一次分类；之后所有阈值都在各自类内取分位
  const classes = classifyTones(data)

  let auto: Levels
  let paperFloor: number
  if (classes) {
    const black = classes.inkQuantile(preset.blackQ)
    const white = classes.paperQuantile(preset.whiteQ)
    auto = white > black ? { blackPoint: black / 255, whitePoint: white / 255 } : { blackPoint: 0, whitePoint: 1 }
    // 白化下界：只白化「与纸底主导峰连成一片」的像素（见 whitenFloor 注释）
    paperFloor = whitenFloor(classes, preset.whiten)
  } else {
    // 真·无可分离两类 → 满量程、不白化
    auto = { blackPoint: 0, whitePoint: 1 }
    paperFloor = 256
  }

  const params: EnhanceParams = {
    blackPoint: auto.blackPoint,
    whitePoint: auto.whitePoint,
    gamma: preset.gamma,
    sharpen: preset.sharpen,
    grayscale: preset.grayscale,
    whiten: preset.whiten
  }
  applyLevels(data, params, paperFloor)
  if (params.sharpen > 0) applySharpen(data, width, height, params.sharpen)
  return { params, auto, whitenThreshold: paperFloor, whitenApplied: paperFloor < 256 }
}
