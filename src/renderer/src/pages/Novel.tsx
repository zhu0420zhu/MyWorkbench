import WritingWorkspace from '../components/roleWorkshop/WritingWorkspace'

/**
 * 长篇作品页（独立导航入口）。
 * 与写作页共用同一套 WritingWorkspace：短篇 + 长篇已在写作模块内合一，
 * 这里仅作为直达长篇创作的入口（openChapterId 透传用于外部跳转）。
 */
export default function Novel({ openChapterId }: { openChapterId?: string }) {
  return <WritingWorkspace openChapterId={openChapterId} />
}
