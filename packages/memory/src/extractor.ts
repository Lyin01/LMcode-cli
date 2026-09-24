import { type MemoryMemo, createMemoryMemo } from './models.js';
import { normalizeTags } from './tags.js';

/**
 * Parse memory-memo blocks from LLM compaction output.
 */
export function parseMemoryMemos(text: string): MemoryMemo[] {
  const memos: MemoryMemo[] = [];

  // Match ```memory-memo ... ``` blocks (tolerate optional whitespace/newlines after header)
  const regex = /```memory-memo[\s\S]*?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const jsonStr = match[1]?.trim();
    if (!jsonStr) continue;

    try {
      const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
      if (parsed['none'] === true) continue;

      const userNeed = typeof parsed['userNeed'] === 'string' ? parsed['userNeed'].trim() : '';
      if (userNeed.length === 0) {
        continue;
      }

      const rawTags = parsed['tags'];
      const tags = Array.isArray(rawTags) ? normalizeTags(rawTags) : undefined;

      memos.push(
        createMemoryMemo({
          userNeed,
          approach: typeof parsed['approach'] === 'string' ? parsed['approach'].trim() : '',
          outcome: typeof parsed['outcome'] === 'string' ? parsed['outcome'].trim() : '',
          whatFailed:
            typeof parsed['whatFailed'] === 'string' ? parsed['whatFailed'].trim() : 'none',
          whatWorked:
            typeof parsed['whatWorked'] === 'string' ? parsed['whatWorked'].trim() : 'none',
          tags,
          kind: parsed['kind'],
          extractionSource: 'compaction',
          sourceSessionId: '', // filled in by caller
          sourceSessionTitle: '', // filled in by caller
        }),
      );
    } catch {
      // Malformed JSON block: skip silently so one bad block doesn't break the whole extraction.
    }
  }

  return memos;
}

/** A pending memo reduced to what the extraction model needs to close it. */
export interface PendingTaskRef {
  readonly id: string;
  readonly userNeed: string;
}

/**
 * Parse the ids of pending memos the model reported as completed.
 *
 * Resolution lives in dedicated `memory-resolve` blocks so ids can never mix
 * with memo parsing; malformed blocks are skipped and ids are deduplicated in
 * first-seen order.
 */
export function parseResolvedPendingIds(text: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  const regex = /```memory-resolve[\s\S]*?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const jsonStr = match[1]?.trim();
    if (!jsonStr) continue;

    try {
      const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
      const raw = parsed['resolved'];
      if (!Array.isArray(raw)) continue;
      for (const entry of raw) {
        if (typeof entry !== 'string') continue;
        const id = entry.trim();
        if (id.length === 0 || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
      }
    } catch {
      // Malformed JSON block: skip silently so one bad block cannot break resolution parsing.
    }
  }

  return ids;
}

/** System prompt for exit-time extraction — instructs the LLM how to extract. */
export const EXIT_EXTRACTION_SYSTEM_PROMPT =
  '你是一个长期记忆提取助手。任务是：1）从对话记录中识别已完成的任务闭环，提炼任务经验记录；2）识别用户明确表达的、稳定的偏好与习惯，提炼偏好记录；3）识别明确未完成、需要下次继续的工作，提炼未完成事项记录；4）提示词给出待续清单时，把本次明确完成的待续事项输出为销账块。用对话的主要语言输出（中文对话用中文，英文对话用英文）。只输出指定的 JSON 格式，不要调用任何工具。';

/**
 * Build the user prompt for exit-time extraction, including a conversation
 * sample. When `pendingTasks` is given, the prompt also lists the open pending
 * memos so the model can report the ones this session finished.
 */
export function buildExitExtractionPrompt(
  sessionId: string,
  messageCount: number,
  sampleText: string,
  pendingTasks?: readonly PendingTaskRef[],
): string {
  const pendingSection = renderPendingResolutionSection(pendingTasks);
  return `以下是会话 "${sessionId}"（共 ${messageCount} 条消息）的对话记录。请提取三类长期记忆：

**一、已完成的任务闭环**（kind 省略或填 "task"）

判断标准：
- 用户提出了明确的需求或问题
- 给出了解决方案或回答
- 结果明确（成功、部分完成、失败）

\`\`\`memory-memo
{
  "userNeed": "<用户需求/目标，一句话概括>",
  "approach": "<执行方案，做了什么，2-4 句话>",
  "outcome": "<最终结果，如'完成'、'部分完成'、'失败：原因'>",
  "whatFailed": "<踩坑记录：试了但不行的路，无则填 'none'>",
  "whatWorked": "<成功经验：最终奏效的关键动作，无则填 'none'>",
  "tags": ["<标签1>", "<标签2>", "<标签3>"]
}
\`\`\`

**二、用户偏好与习惯**（kind = "preference"）

当用户明确表达或反复表现出**稳定的**偏好、习惯、工作方式时（例如：常用工具链、回答语言与风格、流程习惯、"以后都/每次都…"类要求），输出偏好记录：

\`\`\`memory-memo
{
  "kind": "preference",
  "userNeed": "<适用场景，一句话；跨项目通用则写'所有会话'>",
  "approach": "<偏好规则本身，一句话，写成可直接遵循的要求>",
  "outcome": "已记录为长期偏好",
  "whatFailed": "none",
  "whatWorked": "none",
  "tags": ["偏好", "<领域标签>"]
}
\`\`\`

偏好判定要宁缺毋滥：
- 只记录稳定、可复用的习惯，不记录一次性要求（"这次用 X"）或临时上下文
- 用户对既有偏好的纠正也要记录（写清新规则）
- 每条偏好独立成块，不要与任务经验合并

**三、未完成事项**（kind = "pending"）

仅当本次会话存在**明确未完成**的工作时输出：任务做到一半被打断、用户表示"下次继续 / 先到这里"、或已经开始但尚未收尾。任务已经完成并交付、用户表示满意、或只是日常问答时，不要输出。

\`\`\`memory-memo
{
  "kind": "pending",
  "userNeed": "<任务本身，一句话，如'修复 XXX 的启动崩溃'>",
  "approach": "<当前进度与下一步：做到哪了、卡在哪、下一步是什么，2-4 句话>",
  "outcome": "未完成",
  "whatFailed": "<已尝试但无效的路径，无则填 'none'>",
  "whatWorked": "<已验证有效的动作，无则填 'none'>",
  "tags": ["<标签1>", "<标签2>", "<标签3>"]
}
\`\`\`

未完成判定要宁缺毋滥：
- 只有任务明显还需要继续时才输出；话题自然结束、用户没有表达继续意愿时按完成处理
- 同一任务只输出一条，不要拆成多条

${pendingSection}注意：
- tags 是 3-5 个语义标签，概括任务领域/技术栈/动作类型，例如 ["react", "auth", "部署"]
- whatFailed 记录重要的错误尝试，帮助未来避免重蹈覆辙
- whatWorked 记录最终成功的关键动作，帮助未来复用经验
- 未完成的工作不写入任务经验；如有需要保留的未完成事项，按第三节单独输出
- 将紧密相关的子任务合并为一条记录
- 严格遵守上述字段名和 JSON 格式，不要添加额外字段

如果既没有已完成的任务闭环，也没有新的稳定偏好，也没有未完成事项，输出：
\`\`\`memory-memo
{"none": true}
\`\`\`

--- 对话记录（最近 30 条消息）---

${sampleText}

--- 对话记录结束 ---`;
}

const MAX_PENDING_TASK_CHARS = 120;

/** Render the optional prompt section that offers open pending ids for closure. */
function renderPendingResolutionSection(
  pendingTasks: readonly PendingTaskRef[] | undefined,
): string {
  if (pendingTasks === undefined || pendingTasks.length === 0) return '';
  const lines = pendingTasks
    .map((task) => `- ${task.id}｜${truncatePendingTask(task.userNeed)}`)
    .join('\n');
  return `**四、待续事项销账**（可选）

以下是此前记录的、仍未完成的待续事项（格式：id｜任务）：

${lines}

如果本次会话**明确完成**了其中某一项（工作已交付、结果已达成、或用户确认完成），在 memory-memo 块之外额外输出一个销账块：

\`\`\`memory-resolve
{"resolved": ["<完成的 id>"]}
\`\`\`

销账判定要宁缺毋滥：
- 只列本次会话确凿完成的 id；部分完成、不确定、只是提到但没有做完的，一律不列
- id 必须原样取自上方清单，不要编造、不要改写
- 即使本次没有其它记忆要写，只要完成了清单中的事项，也照常输出销账块
- 销账不影响第一节：完成的工作仍可按第一节提炼为任务经验
- 没有任何一项完成时，不要输出销账块

`;
}

function truncatePendingTask(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= MAX_PENDING_TASK_CHARS
    ? collapsed
    : `${collapsed.slice(0, MAX_PENDING_TASK_CHARS)}…`;
}
