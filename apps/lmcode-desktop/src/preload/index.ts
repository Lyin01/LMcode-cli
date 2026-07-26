import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  BackgroundTaskInfo,
  CronJobInfo,
  LmcodeConfigPatch,
  SessionStatus,
} from '@lmcode-cli/lmcode-sdk'
import type {
  ApprovalRequestPayload,
  ApprovalResponsePayload,
  InteractionSettledPayload,
  QuestionRequestPayload,
  QuestionResponsePayload,
  SessionEventPayload,
} from '../shared/ipc-types.js'
import type { TerminalOutputPayload } from '../shared/terminal-types.js'
import type { TextAttachment } from '../shared/file-types.js'

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

  selectWorkDirectory: (initialDirectory?: string) =>
    ipcRenderer.invoke('lmcode:selectWorkDirectory', initialDirectory),

  // ── Chat ────────────────────────────────────────────────────────

  sendMessage: (sessionId: string, text: string) =>
    ipcRenderer.invoke('lmcode:sendMessage', sessionId, text),

  steerMessage: (sessionId: string, text: string) =>
    ipcRenderer.invoke('lmcode:steerMessage', sessionId, text),

  cancelResponse: (sessionId: string) =>
    ipcRenderer.invoke('lmcode:cancelResponse', sessionId),

  getSessionHistory: (sessionId: string) =>
    ipcRenderer.invoke('lmcode:getSessionHistory', sessionId),

  getSessionStatus: (sessionId: string): Promise<SessionStatus> =>
    ipcRenderer.invoke('lmcode:getSessionStatus', sessionId),

  // ── Session control ─────────────────────────────────────────────

  setModel: (sessionId: string, model: string) =>
    ipcRenderer.invoke('lmcode:setModel', sessionId, model),

  setThinking: (sessionId: string, level: string) =>
    ipcRenderer.invoke('lmcode:setThinking', sessionId, level),

  setPermission: (sessionId: string, mode: string) =>
    ipcRenderer.invoke('lmcode:setPermission', sessionId, mode),

  createGoal: (sessionId: string, objective: string, replace = false) =>
    ipcRenderer.invoke('lmcode:createGoal', sessionId, objective, replace),

  getGoal: (sessionId: string) =>
    ipcRenderer.invoke('lmcode:getGoal', sessionId),

  updateGoalStatus: (
    sessionId: string,
    status: 'active' | 'complete' | 'paused' | 'blocked',
  ) => ipcRenderer.invoke('lmcode:updateGoalStatus', sessionId, status),

  cancelGoal: (sessionId: string) =>
    ipcRenderer.invoke('lmcode:cancelGoal', sessionId),

  setPlanMode: (sessionId: string, enabled: boolean) =>
    ipcRenderer.invoke('lmcode:setPlanMode', sessionId, enabled),

  compactSession: (sessionId: string, instruction?: string) =>
    ipcRenderer.invoke('lmcode:compactSession', sessionId, instruction),

  undoHistory: (sessionId: string, count = 1) =>
    ipcRenderer.invoke('lmcode:undoHistory', sessionId, count),

  closeSession: (sessionId: string) =>
    ipcRenderer.invoke('lmcode:closeSession', sessionId),

  // ── Scheduled automations ──────────────────────────────────────

  listCronJobs: (sessionId: string): Promise<readonly CronJobInfo[]> =>
    ipcRenderer.invoke('lmcode:listCronJobs', sessionId),

  createCronJob: (
    sessionId: string,
    input: {
      readonly cron: string
      readonly prompt: string
      readonly recurring?: boolean | undefined
    },
  ): Promise<CronJobInfo> => ipcRenderer.invoke('lmcode:createCronJob', sessionId, input),

  deleteCronJob: (sessionId: string, id: string): Promise<void> =>
    ipcRenderer.invoke('lmcode:deleteCronJob', sessionId, id),

  listBackgroundTasks: (sessionId: string): Promise<readonly BackgroundTaskInfo[]> =>
    ipcRenderer.invoke('lmcode:listBackgroundTasks', sessionId),

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

  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  readFileContent: (filePath: string): Promise<TextAttachment> =>
    ipcRenderer.invoke('lmcode:readFileContent', filePath),

  // ── Git review ─────────────────────────────────────────────────

  getGitSnapshot: (sessionId: string) =>
    ipcRenderer.invoke('lmcode:getGitSnapshot', sessionId),

  getGitFileDiff: (sessionId: string, filePath: string) =>
    ipcRenderer.invoke('lmcode:getGitFileDiff', sessionId, filePath),

  setGitFileStaged: (sessionId: string, filePath: string, staged: boolean) =>
    ipcRenderer.invoke('lmcode:setGitFileStaged', sessionId, filePath, staged),

  commitGitChanges: (sessionId: string, message: string) =>
    ipcRenderer.invoke('lmcode:commitGitChanges', sessionId, message),

  listGitWorktrees: (sessionId: string) =>
    ipcRenderer.invoke('lmcode:listGitWorktrees', sessionId),

  createWorktreeHandoff: (sessionId: string, branchName: string) =>
    ipcRenderer.invoke('lmcode:createWorktreeHandoff', sessionId, branchName),

  handoffToWorktree: (sessionId: string, worktreePath: string) =>
    ipcRenderer.invoke('lmcode:handoffToWorktree', sessionId, worktreePath),

  // ── Project terminal ────────────────────────────────────────────

  startTerminal: (sessionId: string) =>
    ipcRenderer.invoke('lmcode:startTerminal', sessionId),

  writeTerminal: (sessionId: string, input: string) =>
    ipcRenderer.invoke('lmcode:writeTerminal', sessionId, input),

  stopTerminal: (sessionId: string) =>
    ipcRenderer.invoke('lmcode:stopTerminal', sessionId),

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

  onTerminalOutput: (callback: (data: TerminalOutputPayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: TerminalOutputPayload) => callback(data)
    ipcRenderer.on('lmcode:terminalOutput', handler)
    return () => {
      ipcRenderer.removeListener('lmcode:terminalOutput', handler)
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

  stopTask: (sessionId: string, taskId: string) =>
    ipcRenderer.invoke('lmcode:stopTask', sessionId, taskId),

  getTaskOutput: (sessionId: string, taskId: string) =>
    ipcRenderer.invoke('lmcode:getTaskOutput', sessionId, taskId),

  // ── App control ─────────────────────────────────────────────────

  quit: () => {
    ipcRenderer.send('lmcode:quit')
  },
}

contextBridge.exposeInMainWorld('lmcodeAPI', lmcodeAPI)
