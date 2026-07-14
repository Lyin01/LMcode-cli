import { contextBridge, ipcRenderer } from 'electron'
import type { LmcodeConfigPatch } from '@lmcode-cli/lmcode-sdk'
import type {
  ApprovalRequestPayload,
  ApprovalResponsePayload,
  InteractionSettledPayload,
  QuestionRequestPayload,
  QuestionResponsePayload,
  SessionEventPayload,
} from '../shared/ipc-types.js'

// Custom API exposed as window.lmcodeAPI
const lmcodeAPI = {
  // ── Session management ──────────────────────────────────────────

  createSession: (opts: {
    workDir: string
    model?: string
    thinking?: string
    permission?: 'yolo' | 'manual' | 'auto'
  }) => ipcRenderer.invoke('lmcode:createSession', opts),

  resumeSession: (id: string) =>
    ipcRenderer.invoke('lmcode:resumeSession', id),

  deleteSession: (id: string) =>
    ipcRenderer.invoke('lmcode:deleteSession', id),

  exportSession: (id: string) =>
    ipcRenderer.invoke('lmcode:exportSession', id),

  renameSession: (id: string, title: string) =>
    ipcRenderer.invoke('lmcode:renameSession', id, title),

  listSessions: () => ipcRenderer.invoke('lmcode:listSessions'),

  // ── Chat ────────────────────────────────────────────────────────

  sendMessage: (sessionId: string, text: string) =>
    ipcRenderer.invoke('lmcode:sendMessage', sessionId, text),

  cancelResponse: (sessionId: string) =>
    ipcRenderer.invoke('lmcode:cancelResponse', sessionId),

  getSessionHistory: (sessionId: string) =>
    ipcRenderer.invoke('lmcode:getSessionHistory', sessionId),

  // ── Session control ─────────────────────────────────────────────

  setModel: (sessionId: string, model: string) =>
    ipcRenderer.invoke('lmcode:setModel', sessionId, model),

  setThinking: (sessionId: string, level: string) =>
    ipcRenderer.invoke('lmcode:setThinking', sessionId, level),

  setPermission: (sessionId: string, mode: string) =>
    ipcRenderer.invoke('lmcode:setPermission', sessionId, mode),

  closeSession: (sessionId: string) =>
    ipcRenderer.invoke('lmcode:closeSession', sessionId),

  // ── Skills & MCP ────────────────────────────────────────────────

  listSkills: (sessionId: string) =>
    ipcRenderer.invoke('lmcode:listSkills', sessionId),

  activateSkill: (sessionId: string, name: string, args?: string) =>
    ipcRenderer.invoke('lmcode:activateSkill', sessionId, name, args),

  listMcpServers: (sessionId: string) =>
    ipcRenderer.invoke('lmcode:listMcpServers', sessionId),

  reconnectMcpServer: (sessionId: string, name: string) =>
    ipcRenderer.invoke('lmcode:reconnectMcpServer', sessionId, name),

  addMcpServer: (sessionId: string, name: string, config: Record<string, unknown>) =>
    ipcRenderer.invoke('lmcode:addMcpServer', sessionId, name, config),

  stopMcpServer: (sessionId: string, name: string) =>
    ipcRenderer.invoke('lmcode:stopMcpServer', sessionId, name),

  removeMcpServer: (sessionId: string, name: string) =>
    ipcRenderer.invoke('lmcode:removeMcpServer', sessionId, name),

  // ── Config ──────────────────────────────────────────────────────

  getConfig: () => ipcRenderer.invoke('lmcode:getConfig'),

  setConfig: (patch: LmcodeConfigPatch) => ipcRenderer.invoke('lmcode:setConfig', patch),

  // ── File operations ─────────────────────────────────────────────

  readFileContent: (filePath: string) =>
    ipcRenderer.invoke('lmcode:readFileContent', filePath),

  // ── Version ─────────────────────────────────────────────────────

  getVersion: () => ipcRenderer.invoke('lmcode:getVersion'),

  // ── Misc ────────────────────────────────────────────────────────

  getHomeDir: () => ipcRenderer.invoke('lmcode:getHomeDir'),

  // ── Event listeners (main → renderer) ───────────────────────────

  onSessionEvent: (callback: (event: SessionEventPayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: SessionEventPayload) => callback(data)
    ipcRenderer.on('lmcode:sessionEvent', handler)
    return () => {
      ipcRenderer.removeListener('lmcode:sessionEvent', handler)
    }
  },

  onApprovalRequest: (callback: (data: ApprovalRequestPayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: ApprovalRequestPayload) => callback(data)
    ipcRenderer.on('lmcode:approvalRequest', handler)
    return () => {
      ipcRenderer.removeListener('lmcode:approvalRequest', handler)
    }
  },

  onQuestionRequest: (callback: (data: QuestionRequestPayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: QuestionRequestPayload) => callback(data)
    ipcRenderer.on('lmcode:questionRequest', handler)
    return () => {
      ipcRenderer.removeListener('lmcode:questionRequest', handler)
    }
  },

  onInteractionSettled: (callback: (data: InteractionSettledPayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: InteractionSettledPayload) => callback(data)
    ipcRenderer.on('lmcode:interactionSettled', handler)
    return () => {
      ipcRenderer.removeListener('lmcode:interactionSettled', handler)
    }
  },

  // ── Navigation events (from tray menu) ──────────────────────────

  onNavigate: (callback: (data: { route: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { route: string }) => callback(data)
    ipcRenderer.on('lmcode:navigate', handler)
    return () => {
      ipcRenderer.removeListener('lmcode:navigate', handler)
    }
  },

  // ── Approval / Question responses ───────────────────────────────

  respondApproval: (payload: ApprovalResponsePayload) =>
    ipcRenderer.invoke('lmcode:respondApproval', payload),

  respondQuestion: (payload: QuestionResponsePayload) =>
    ipcRenderer.invoke('lmcode:respondQuestion', payload),

  // ── Memory ──────────────────────────────────────────────────────

  listMemories: () => ipcRenderer.invoke('lmcode:listMemories'),

  searchMemories: (query: string) =>
    ipcRenderer.invoke('lmcode:searchMemories', query),

  deleteMemory: (id: string) =>
    ipcRenderer.invoke('lmcode:deleteMemory', id),

  // ── Background tasks ────────────────────────────────────────────

  stopTask: (taskId: string) =>
    ipcRenderer.invoke('lmcode:stopTask', taskId),

  getTaskOutput: (taskId: string) =>
    ipcRenderer.invoke('lmcode:getTaskOutput', taskId),

  // ── App control ─────────────────────────────────────────────────

  quit: () => {
    ipcRenderer.send('lmcode:quit')
  },
}

contextBridge.exposeInMainWorld('lmcodeAPI', lmcodeAPI)
