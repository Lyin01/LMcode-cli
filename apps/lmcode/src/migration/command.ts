/**
 * `lmcode migrate` sub-command — permanently disabled.
 *
 * The lmcode-cli → lmcode migration feature has been removed.
 * The command is kept for backwards compatibility but prints a notice.
 */

import type { Command } from 'commander';

export function registerMigrateCommand(parent: Command, _onMigrate: () => void): void {
  parent
    .command('migrate')
    .description('将旧版 lmcode-cli 安装的数据迁移到 lmcode。（已停用）')
    .action(() => {
      process.stdout.write('迁移功能已取消，不再支持从 lmcode-cli 导入数据。\n');
      process.exit(0);
    });
}
