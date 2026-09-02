import { Button, Empty, Input, Space, Tabs, Typography, message } from 'antd'
import { useState } from 'react'
import type { Chapter, ChapterMeta, NovelProjectMeta, Volume } from '@shared/types'
import EntityLibrary from './EntityLibrary'

interface OutlinePanelProps {
  meta: NovelProjectMeta
  chapter: Chapter | null
  volume: Volume | null
  /** 全部章节：设定库的动态状态要选"从哪一章起生效" */
  chapters: ChapterMeta[]
  /** 保存细纲（失焦时触发） */
  onSaveSummary: (summary: string) => Promise<void>
  /** 面板不 await 它，因此允许同步返回（失焦即发，失败由调用方提示） */
  onUpdateProject: (patch: {
    title?: string
    genre?: string
    synopsis?: string
    targetWords?: number
  }) => void | Promise<void>
  onExportBook: () => void
}

/**
 * 右侧面板：本章细纲 + 作品设定。
 *
 * 细纲是"上下文编排的主要输入"（阶段 2 的 ContextBundle 会直接读它），
 * 因此单独占一个面板而不是塞进章节弹窗——写章时要能随时对照与修改。
 */
export default function OutlinePanel({
  meta,
  chapter,
  volume,
  chapters,
  onSaveSummary,
  onUpdateProject,
  onExportBook
}: OutlinePanelProps) {
  const [summary, setSummary] = useState(chapter?.summary ?? '')
  const [dirty, setDirty] = useState(false)

  // 章节切换时重载细纲
  const [loadedId, setLoadedId] = useState<string>('')
  if (chapter && chapter.id !== loadedId) {
    setLoadedId(chapter.id)
    setSummary(chapter.summary ?? '')
    setDirty(false)
  }

  const [title, setTitle] = useState(meta.title)
  const [genre, setGenre] = useState(meta.genre)
  const [synopsis, setSynopsis] = useState(meta.synopsis)
  const [target, setTarget] = useState(String(meta.targetWords || ''))

  if (!chapter) {
    return (
      <div style={{ padding: 16 }}>
        <Empty description="未选择章节" />
      </div>
    )
  }

  const flushSummary = async (): Promise<void> => {
    if (!dirty) return
    setDirty(false)
    try {
      await onSaveSummary(summary)
    } catch {
      message.error('细纲保存失败')
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Tabs
        size="small"
        defaultActiveKey="outline"
        className="novel-side-tabs"
        style={{ flex: 1, minHeight: 0, padding: '0 10px' }}
        items={[
          {
            key: 'outline',
            label: '本章细纲',
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {volume?.title} · {chapter.title}
                </Typography.Text>
                <Input.TextArea
                  aria-label="本章细纲"
                  value={summary}
                  onChange={(e) => {
                    setSummary(e.target.value)
                    setDirty(true)
                  }}
                  onBlur={() => void flushSummary()}
                  autoSize={{ minRows: 8, maxRows: 20 }}
                  placeholder="这一章要发生什么？写清楚起承转合，AI 续写时会以此为纲领。"
                />
                {dirty && (
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    失焦后自动保存
                  </Typography.Text>
                )}
              </div>
            )
          },
          {
            key: 'project',
            label: '作品设定',
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div>
                  <Typography.Text style={{ fontSize: 12 }}>书名</Typography.Text>
                  <Input
                    size="small"
                    aria-label="书名"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    onBlur={() => void onUpdateProject({ title })}
                  />
                </div>
                <div>
                  <Typography.Text style={{ fontSize: 12 }}>题材</Typography.Text>
                  <Input
                    size="small"
                    aria-label="题材"
                    value={genre}
                    onChange={(e) => setGenre(e.target.value)}
                    onBlur={() => void onUpdateProject({ genre })}
                    placeholder="玄幻 / 都市 / 科幻…"
                  />
                </div>
                <div>
                  <Typography.Text style={{ fontSize: 12 }}>目标字数</Typography.Text>
                  <Input
                    size="small"
                    aria-label="目标字数"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    onBlur={() => {
                      const n = Number(target)
                      void onUpdateProject({ targetWords: Number.isFinite(n) && n > 0 ? n : 0 })
                    }}
                    placeholder="如 1000000"
                  />
                </div>
                <div>
                  <Typography.Text style={{ fontSize: 12 }}>一句话梗概</Typography.Text>
                  <Input.TextArea
                    size="small"
                    aria-label="一句话梗概"
                    value={synopsis}
                    onChange={(e) => setSynopsis(e.target.value)}
                    onBlur={() => void onUpdateProject({ synopsis })}
                    autoSize={{ minRows: 4, maxRows: 10 }}
                  />
                </div>
                <Space direction="vertical" size={2}>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    创建于 {new Date(meta.createdAt).toLocaleDateString()}
                  </Typography.Text>
                </Space>
              </div>
            )
          },
          {
            key: 'entities',
            label: '设定库',
            children: (
              <EntityLibrary
                projectId={meta.id}
                chapterId={chapter.id}
                chapterTitle={chapter.title}
                chapterContent={chapter.content}
                chapters={chapters}
              />
            )
          }
        ]}
      />
      <div style={{ padding: '6px 12px', borderTop: '1px solid var(--border-color, rgba(128,128,128,.15))' }}>
        <Button size="small" block onClick={onExportBook}>
          导出成书…
        </Button>
      </div>
    </div>
  )
}
