/**
 * 角色工坊（SillyTavern 功能原生移植）· 契约类型
 * 数据格式兼容 SillyTavern 1.18（角色卡 V2 / 世界书 / 聊天记录 / 预设）
 */

/** 角色卡 V2（与 SillyTavern character card 兼容） */
export interface CharacterCard {
  name: string
  description: string
  personality: string
  scenario: string
  first_mes: string
  mes_example: string
  creator_notes: string
  system_prompt: string
  post_history_instructions: string
  alternate_greetings: string[]
  tags: string[]
  creator: string
  character_version: string
  extensions: Record<string, unknown>
  /**
   * 未知顶层字段的留存位（非 V2 契约、但导入卡里存在的顶层键，如 SillyTavern 的
   * character_book 内嵌世界书 / group_only_greetings / creation_date 等）。
   * 仅存储层自洽用：parseCardJson 读取时收集不认识的顶层键，cardToJson 序列化时
   * 展平回顶层，保证「读取 → 保存」往返零损；该键本身不会写进最终文件。
   */
  __extra?: Record<string, unknown>
}

/** 磁盘角色卡元信息 */
export interface CharacterMeta {
  id: string // 文件名（无扩展名）
  card: CharacterCard
  /** 头像是否内置（PNG 卡片含内嵌图） */
  hasAvatar: boolean
  updatedAt: number
}

/** 世界书条目 */
export interface WorldEntry {
  uid: number
  key: string[] // 触发关键词
  keysecondary: string[]
  comment: string
  content: string
  constant: boolean
  selective: boolean
  insertion_order: number
  enabled: boolean
  position: 'before_char' | 'after_char' | 'before_example' | 'after_example'
  exclude_recursion: boolean
  prevent_recursion: boolean
  display_index: number
  delay_until_recursion: boolean
  depth: number
}

/** 世界书（Lorebook） */
export interface WorldInfo {
  entries: WorldEntry[]
  name: string
  /** 递归深度上限 */
  recursive_scaling: number
  /** 允许递归 */
  enable_recursion: boolean
  /** 全局注入位置 */
  always_use_pos: boolean
}

/** 聊天消息（兼容 SillyTavern 结构，含滑动分支） */
export interface ChatMessage {
  name: string
  is_user: boolean
  is_name: boolean
  send_date: string
  mes: string
  swipes?: string[]
  swipe_id?: number
  extra?: Record<string, unknown>
}

/** 采样/预设参数（OpenAI 兼容子集） */
export interface SamplingParams {
  temperature: number
  top_p: number
  max_tokens: number
  presence_penalty: number
  frequency_penalty: number
  repetition_penalty: number
  top_k: number
  seed: number | null
}

/** 上下文/指导/推理模板 */
export interface InstructTemplate {
  system_prompt: string
  user_placeholder: string
  assistant_placeholder: string
  system_sequence: string[]
  stop_sequence: string[]
  wrap_in_quotes: boolean
  include_names: boolean
}

/** 预设包（采样 + 上下文 + 指导） */
export interface RolePreset {
  id: string
  name: string
  sampling: Partial<SamplingParams>
  instruct: Partial<InstructTemplate>
  context: string // 上下文模板文本
  wrap: boolean
  createdAt: number
}

/** 作者注释 / 提示词注入 */
export interface AuthorNote {
  enabled: boolean
  note: string
  position: 'top' | 'bottom' | 'depth'
  depth: number
  role: 'system' | 'user' | 'assistant'
}

/** 正则脚本 */
export interface RegexScript {
  id: string
  name: string
  findRegex: string
  replaceString: string
  trimStrings: boolean
  placement: ('user' | 'ai' | 'slash' | 'output')[]
  disabled: boolean
  markdownOnly: boolean
  promptOnly: boolean
}

/** 快速回复宏 */
export interface QuickReply {
  id: string
  label: string
  message: string
  isUser: boolean
}

/** 角色工坊全局配置（默认角色 / 默认世界书 / 当前聊天会话） */
export interface WorkshopConfig {
  defaultCharacterId: string | null
  defaultWorldId: string | null
  defaultPresetId: string | null
  activeChatCharacterId: string | null
  activeChatId: string | null
}

/** 角色工坊状态快照 */
export interface WorkshopStatus {
  ok: boolean
  dataRoot: string
  characterCount: number
  worldCount: number
  chatCount: number
  error?: string
}
