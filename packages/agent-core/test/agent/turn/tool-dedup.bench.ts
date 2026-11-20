import { bench, describe } from 'vitest';

import { ToolCallDeduplicator } from '../../../src/agent/turn/tool-dedup';

describe('tool-call registration and finalization', () => {
  for (const size of [32, 512, 4096]) {
    const calls = Array.from({ length: size }, (_, index) => ({
      id: String(index),
      args: { path: `src/file-${String(index)}.ts`, old_string: 'one', new_string: 'two' },
    }));
    bench(`${String(size)} distinct Edit calls`, async () => {
      const dedup = new ToolCallDeduplicator('/repo', 'posix');
      dedup.beginStep();
      for (const call of calls) dedup.checkSameStep(call.id, 'Edit', call.args);
      for (const call of calls) {
        await dedup.finalizeResult(call.id, 'Edit', call.args, { output: 'edited' });
      }
      dedup.endStep();
    });
  }
});
