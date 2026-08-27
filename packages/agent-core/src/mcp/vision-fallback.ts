/**
 * 视觉降级（vision fallback）MCP 约定。
 *
 * `visual-mcp` 是产品内置的「看图补位」通道：当主模型没有图像输入能力
 * （`image_in=false`，如 DeepSeek V4 Flash）时，图片会由
 * `degradeImagesForModel` 落盘并提示模型改用该 MCP 读取内容。
 *
 * 有视觉能力的模型（`image_in=true`，如 Grok、GLM-5.3-Flash）原生即可读图，
 * 该 MCP 对它们纯属多余入口——会诱导模型绕过原生图像路径多做一次进程调用，
 * 拖慢任务。因此 ToolManager 在工具注入层对具备视觉能力的模型屏蔽它。
 *
 * 这里是名称的唯一真相来源：ToolManager 的过滤与 turn 层的降级提示文案
 * 都必须引用本模块的导出，避免重命名时漂移。
 */
export const VISUAL_FALLBACK_MCP_SERVER_NAME = 'visual-mcp';

export function isVisualFallbackMcpServer(serverName: string): boolean {
  return serverName === VISUAL_FALLBACK_MCP_SERVER_NAME;
}
