/**
 * 角色工坊 · 共享类型（渲染进程）
 */
export interface CharCard {
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
}

export interface CharacterMeta {
  id: string
  card: CharCard
  hasAvatar: boolean
  updatedAt: number
}

export interface WorldEntry {
  uid: number
  key: string[]
  keysecondary: string[]
  comment: string
  content: string
  constant: boolean
  selective: boolean
  insertion_order: number
  enabled: boolean
  position: string
  exclude_recursion: boolean
  prevent_recursion: boolean
  display_index: number
  delay_until_recursion: boolean
  depth: number
}

export interface WorldInfo {
  entries: WorldEntry[]
  name: string
  recursive_scaling: number
  enable_recursion: boolean
  always_use_pos: boolean
}

export interface ChatMsg {
  name: string
  is_user: boolean
  is_name: boolean
  send_date: string
  mes: string
  swipes?: string[]
  swipe_id?: number
  extra?: { streaming?: boolean; error?: boolean; [k: string]: unknown }
}

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

export interface RolePreset {
  id: string
  name: string
  sampling: Partial<SamplingParams>
  instruct: Partial<Record<string, unknown>>
  context: string
  wrap: boolean
  createdAt: number
}

export interface AuthorNote {
  enabled: boolean
  note: string
  position: string
  depth: number
  role: string
}

export interface RegexScript {
  id: string
  name: string
  findRegex: string
  replaceString: string
  trimStrings: boolean
  placement: string[]
  disabled: boolean
  markdownOnly: boolean
  promptOnly: boolean
}

export interface QuickReply {
  id: string
  label: string
  message: string
  isUser: boolean
}

export const EMPTY_CARD = (name = '新角色'): CharCard => ({
  name,
  description: '',
  personality: '',
  scenario: '',
  first_mes: '',
  mes_example: '',
  creator_notes: '',
  system_prompt: '',
  post_history_instructions: '',
  alternate_greetings: [],
  tags: [],
  creator: '',
  character_version: '',
  extensions: {}
})

export const DEFAULT_SAMPLING: SamplingParams = {
  temperature: 0.9,
  top_p: 1,
  max_tokens: 1024,
  presence_penalty: 0,
  frequency_penalty: 0,
  repetition_penalty: 1,
  top_k: 0,
  seed: null
}
