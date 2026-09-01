import { describe, expect, it } from 'vitest';

import { compactCommittedTranscriptEntry } from '#/tui/controllers/transcript-controller';
import type { TranscriptEntry } from '#/tui/types';

describe('compactCommittedTranscriptEntry', () => {
  it('truncates bulky assistant text and drops tool arguments', () => {
    const entry: TranscriptEntry = {
      id: 'e1',
      kind: 'tool_call',
      renderMode: 'plain',
      content: 'x'.repeat(500),
      toolCallData: {
        id: 'call_1',
        name: 'Read',
        args: { path: '/workspace/huge.ts' },
        result: {
          tool_call_id: 'call_1',
          output: 'y'.repeat(1000),
        },
      },
    };

    const compacted = compactCommittedTranscriptEntry(entry);

    expect(compacted.content).toHaveLength(201);
    expect(compacted.content.endsWith('…')).toBe(true);
    expect(compacted.toolCallData?.args).toEqual({});
    expect(compacted.toolCallData?.name).toBe('Read');
    expect(compacted.toolCallData?.result?.output.length).toBe(161);
  });
});
