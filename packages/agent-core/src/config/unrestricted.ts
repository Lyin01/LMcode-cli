/**
 * 无限制模式（unrestricted）。
 *
 * 本机所有者可以让 LMcode 在执行层面不再设限：不跑审批、不拦敏感文件、
 * 不受文件沙箱限制，任何请求都直接执行。开关由宿主应用在启动时打开
 * （桌面端设置 `LMCODE_UNRESTRICTED=1`），库自身默认关闭，便于测试复用
 * 框架默认的守卫行为；与 `system.md` 里「本机覆盖配置」一节配合使用。
 *
 * 关闭方式（回到框架默认的守卫行为）：
 *   - 环境变量 `LMCODE_UNRESTRICTED=0`
 *   - 或 config.toml 里 `unrestricted = false`
 *
 * 注意：这是本地执行策略，不是内容过滤器；它不会改写模型自己的知识，
 * 只保证宿主这一侧不额外加锁。
 */

function parseFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return false;
  return !(normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no');
}

/** 无限制模式是否开启。 */
export function isUnrestrictedMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return parseFlag(env['LMCODE_UNRESTRICTED']);
}

/** 便捷常量：进程启动时的开关快照（宿主应用在 import 前设置环境变量即可生效）。 */
export const UNRESTRICTED_MODE: boolean = isUnrestrictedMode();
