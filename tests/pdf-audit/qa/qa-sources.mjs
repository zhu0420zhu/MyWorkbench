/**
 * QA 增强素材：三种「扫描件风格」源文件 + 一份元数据源。
 * 用 pdf-lib 构造，尽量贴近真实扫描页（纸底灰雾 / 文字发灰）。
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { createCanvas } from '@napi-rs/canvas'

export const QA_META = {
  title: 'QA 增强元数据测试',
  author: 'Edward (QA)',
  subject: 'enhance e2e',
  keywords: 'qa pdf enhance',
  producer: 'QA Source Producer',
  creator: 'QA Source Creator'
}

/** 矢量「扫描件风格」：米色纸底 + 淡灰正文 */
export async function makeVectorScan(dense = false) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  for (let p = 0; p < 3; p++) {
    const page = doc.addPage([595, 842])
    page.drawRectangle({ x: 0, y: 0, width: 595, height: 842, color: rgb(0.87, 0.86, 0.82) })
    page.drawText(`Scanned Document - Page ${p + 1}`, { x: 60, y: 780, size: 22, font: bold, color: rgb(0.32, 0.31, 0.3) })
    const nLines = dense ? 45 : 26
    const lh = dense ? 15 : 24
    for (let i = 0; i < nLines; i++) {
      page.drawText('The quick brown fox jumps over the lazy dog 0123456789 abcdefgh', {
        x: 50, y: 790 - i * lh, size: dense ? 11 : 12, font, color: rgb(0.5, 0.5, 0.5)
      })
    }
    if (!dense) {
      for (let i = 0; i < 8; i++) {
        page.drawText('Faded scanned line with low contrast and speckle noise', {
          x: 60, y: 120 - i * 12, size: 9, font, color: rgb(0.72, 0.71, 0.69)
        })
      }
    }
  }
  doc.setTitle(QA_META.title)
  doc.setAuthor(QA_META.author)
  doc.setSubject(QA_META.subject)
  doc.setKeywords(QA_META.keywords.split(' '))
  doc.setProducer(QA_META.producer)
  doc.setCreator(QA_META.creator)
  return doc.save({ useObjectStreams: false })
}

/** 真实感「栅格扫描件」：噪点纸底 + 灰字，整页作为 JPEG 嵌入（更贴近真实扫描） */
export async function makeRasterScan() {
  const W = 1240, H = 1754 // A4 @150dpi
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  const img = ctx.createImageData(W, H)
  // 纸底：均值 224、标准差 ~7 的高斯噪声（模拟扫描噪点）
  for (let i = 0; i < img.data.length; i += 4) {
    const g = 224 + ((Math.random() + Math.random() + Math.random() - 1.5) * 10)
    img.data[i] = g
    img.data[i + 1] = g - 2
    img.data[i + 2] = g - 6
    img.data[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  ctx.fillStyle = 'rgb(120,120,120)'
  ctx.font = '20px Arial'
  for (let i = 0; i < 44; i++) ctx.fillText('The quick brown fox jumps over the lazy dog 0123456789', 60, 90 + i * 37)
  ctx.fillStyle = 'rgb(160,160,160)'
  ctx.font = '15px Arial'
  for (let i = 0; i < 10; i++) ctx.fillText('Faded low-contrast line with speckle noise', 60, 1660 - i * 18)
  const jpeg = canvas.toBuffer('image/jpeg', 90)

  const doc = await PDFDocument.create()
  const j = await doc.embedJpg(jpeg)
  doc.addPage([595, 842]).drawImage(j, { x: 0, y: 0, width: 595, height: 842 })
  doc.addPage([595, 842]).drawImage(j, { x: 0, y: 0, width: 595, height: 842 })
  doc.addPage([595, 842]).drawImage(j, { x: 0, y: 0, width: 595, height: 842 })
  doc.setTitle(QA_META.title)
  doc.setAuthor(QA_META.author)
  doc.setSubject(QA_META.subject)
  doc.setKeywords(QA_META.keywords.split(' '))
  doc.setCreator(QA_META.creator)
  return doc.save({ useObjectStreams: false })
}
