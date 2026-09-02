/**
 * 角色工坊（SillyTavern 功能移植）IPC 接线
 */
import { ipcMain, type WebContents } from 'electron'
import type { AiChatMessage } from '../../shared/types'
import type { CharacterCard, WorldInfo, ChatMessage, RolePreset, SamplingParams, AuthorNote, RegexScript, QuickReply } from './types'
import { initDataStore, dataRoot } from './dataStore'
import * as chars from './charCards'
import * as worlds from './worlds'
import * as chats from './chats'
import * as presets from './presets'
import { buildSystemPrompt, buildMessages, streamChat, stopStream, applyRegex } from './promptBuilder'

export function registerSillyTavernIpc(): void {
  void initDataStore()

  /* ---- 状态 ---- */
  ipcMain.handle('sillytavern:status', async () => {
    const [cs, ws] = await Promise.all([chars.listCharacters(), worlds.listWorlds()])
    return { ok: true, dataRoot: dataRoot(), characterCount: cs.length, worldCount: ws.length, chatCount: 0 }
  })

  /* ---- 角色卡 ---- */
  ipcMain.handle('sillytavern:chars-list', () => chars.listCharacters())
  ipcMain.handle('sillytavern:chars-get', (_e, id: string) => chars.getCharacter(id))
  ipcMain.handle('sillytavern:chars-save', (_e, id: string, card: CharacterCard) => chars.saveCharacter(id, card))
  ipcMain.handle('sillytavern:chars-avatar', (_e, id: string, bytes: Uint8Array) => chars.updateCharacterAvatar(id, bytes))
  ipcMain.handle('sillytavern:chars-export', (_e, id: string) => chars.exportCharacterCard(id))
  ipcMain.handle('sillytavern:chars-import', (_e, bytes: Uint8Array) => chars.importCharacter(bytes))
  ipcMain.handle('sillytavern:chars-delete', (_e, id: string) => chars.deleteCharacter(id))
  ipcMain.handle('sillytavern:chars-default-get', () => chars.getDefaultCharacterId())
  ipcMain.handle('sillytavern:chars-default-set', (_e, id: string | null) => chars.setDefaultCharacterId(id))

  /* ---- 世界书 ---- */
  ipcMain.handle('sillytavern:worlds-list', () => worlds.listWorlds())
  ipcMain.handle('sillytavern:worlds-get', (_e, id: string) => worlds.getWorld(id))
  ipcMain.handle('sillytavern:worlds-save', (_e, id: string, world: WorldInfo) => worlds.saveWorld(id, world))
  ipcMain.handle('sillytavern:worlds-delete', (_e, id: string) => worlds.deleteWorld(id))
  ipcMain.handle('sillytavern:worlds-default-get', () => worlds.getDefaultWorldId())
  ipcMain.handle('sillytavern:worlds-default-set', (_e, id: string | null) => worlds.setDefaultWorldId(id))

  /* ---- 聊天记录 ---- */
  ipcMain.handle('sillytavern:chats-list', (_e, charId: string) => chats.listChats(charId))
  ipcMain.handle('sillytavern:chats-get', (_e, charId: string, chatId: string) => chats.getChat(charId, chatId))
  ipcMain.handle('sillytavern:chats-save', (_e, charId: string, chatId: string, msgs: ChatMessage[]) => chats.saveChat(charId, chatId, msgs))
  ipcMain.handle('sillytavern:chats-delete', (_e, charId: string, chatId: string) => chats.deleteChat(charId, chatId))
  ipcMain.handle('sillytavern:chats-new-id', () => chats.newChatId())
  ipcMain.handle('sillytavern:chats-active-get', () => chats.getActiveChat())
  ipcMain.handle('sillytavern:chats-active-set', (_e, charId: string, chatId: string) => chats.setActiveChat(charId, chatId))

  /* ---- 预设 ---- */
  ipcMain.handle('sillytavern:presets-list', () => presets.listPresets())
  ipcMain.handle('sillytavern:presets-get', (_e, id: string) => presets.getPreset(id))
  ipcMain.handle('sillytavern:presets-save', (_e, p: RolePreset) => presets.savePreset(p))
  ipcMain.handle('sillytavern:presets-delete', (_e, id: string) => presets.deletePreset(id))
  ipcMain.handle('sillytavern:presets-default-get', () => presets.getDefaultPresetId())
  ipcMain.handle('sillytavern:presets-default-set', (_e, id: string | null) => presets.setDefaultPresetId(id))

  /* ---- 作者注释 / 正则 / 快速回复 ---- */
  ipcMain.handle('sillytavern:note-get', () => presets.getAuthorNote())
  ipcMain.handle('sillytavern:note-set', (_e, note: AuthorNote) => presets.setAuthorNote(note))
  ipcMain.handle('sillytavern:regex-get', () => presets.getRegexScripts())
  ipcMain.handle('sillytavern:regex-set', (_e, list: RegexScript[]) => presets.setRegexScripts(list))
  ipcMain.handle('sillytavern:quick-get', () => presets.getQuickReplies())
  ipcMain.handle('sillytavern:quick-set', (_e, list: QuickReply[]) => presets.setQuickReplies(list))

  /* ---- 对话引擎 ---- */
  ipcMain.handle(
    'sillytavern:chat',
    (
      event,
      sessionId: string,
      payload: {
        card: CharacterCard | null
        world: WorldInfo | null
        history: ChatMessage[]
        userText: string
        params: Partial<SamplingParams>
        authorNote: AuthorNote | null
        regex: RegexScript[]
        model?: string
      }
    ) => {
      const sender: WebContents = event.sender
      const card = payload.card
      const history = payload.history
      const userText = payload.userText
      // 正则后处理：对用户输入应用 user 脚本
      const processedUser = applyRegex(userText, payload.regex ?? [], 'user')
      const conversationText = [...history.map((m) => m.mes), processedUser].join('\n')
      const system = buildSystemPrompt({
        card,
        world: payload.world ?? null,
        conversationText,
        authorNote: payload.authorNote ?? null
      })
      const msgs: AiChatMessage[] = buildMessages(card, history, processedUser, system)
      return streamChat(sender, sessionId, msgs, payload.params ?? {}, payload.model)
    }
  )
  ipcMain.handle('sillytavern:stop', (_e, sessionId: string) => stopStream(sessionId))

  /* ---- 角色上下文编译（供写作融合模式把角色卡/世界书/作者注释注入 ai.chat 的 system） ---- */
  ipcMain.handle(
    'sillytavern:build-context',
    (_e, opts: { card: CharacterCard | null; world: WorldInfo | null; conversationText: string; authorNote: AuthorNote | null }) =>
      buildSystemPrompt(opts)
  )
}
