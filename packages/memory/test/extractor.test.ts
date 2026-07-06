import { describe, expect, it } from 'vitest';

import { parseMemoryMemos } from '../src/extractor.js';

/**
 * Edge-case coverage for the LLM-output memo parser. The happy path and basic
 * rejection cases live in store.test.ts; this file pins the resilience and
 * cross-platform behaviors that a `\n`-anchored regex + strict JSON.parse can
 * quietly get wrong.
 */
describe('parseMemoryMemos — robustness', () => {
  it('parses a block written with Windows CRLF line endings', () => {
    // The primary platform is Windows, where model output routed through
    // files/streams can arrive CRLF-terminated. The header/body regex must not
    // depend on bare LF.
    const text = [
      '```memory-memo',
      '{',
      '  "userNeed": "修复 CRLF 解析",',
      '  "approach": "在 Windows 上测试",',
      '  "outcome": "完成"',
      '}',
      '```',
    ].join('\r\n');

    const memos = parseMemoryMemos(text);
    expect(memos.length).toBe(1);
    expect(memos[0]!.userNeed).toBe('修复 CRLF 解析');
    expect(memos[0]!.outcome).toBe('完成');
  });

  it('keeps a valid block when a malformed block precedes it', () => {
    // One bad JSON block must not swallow a healthy sibling.
    const text =
      '```memory-memo\n{ not valid json }\n```\n\n' +
      '```memory-memo\n{"userNeed": "second block", "approach": "x", "outcome": "完成"}\n```';

    const memos = parseMemoryMemos(text);
    expect(memos.length).toBe(1);
    expect(memos[0]!.userNeed).toBe('second block');
  });

  it('skips a {"none": true} sentinel while still extracting a real block', () => {
    const text =
      '```memory-memo\n{"none": true}\n```\n\n' +
      '```memory-memo\n{"userNeed": "real work", "approach": "x", "outcome": "完成"}\n```';

    const memos = parseMemoryMemos(text);
    expect(memos.length).toBe(1);
    expect(memos[0]!.userNeed).toBe('real work');
  });

  it('does not throw and yields undefined tags when tags is not an array', () => {
    const text =
      '```memory-memo\n{"userNeed": "bad tags", "approach": "x", "outcome": "完成", "tags": "react,auth"}\n```';

    const memos = parseMemoryMemos(text);
    expect(memos.length).toBe(1);
    expect(memos[0]!.tags).toBeUndefined();
  });

  it('drops non-string tag entries without dropping the memo', () => {
    const text =
      '```memory-memo\n{"userNeed": "mixed tags", "approach": "x", "outcome": "完成", "tags": ["react", 42, null, "auth"]}\n```';

    const memos = parseMemoryMemos(text);
    expect(memos.length).toBe(1);
    expect(memos[0]!.tags).toEqual(['react', 'auth']);
  });

  it('defaults whatFailed/whatWorked to "none" when the fields are absent', () => {
    const text =
      '```memory-memo\n{"userNeed": "defaults", "approach": "x", "outcome": "完成"}\n```';

    const memos = parseMemoryMemos(text);
    expect(memos[0]!.whatFailed).toBe('none');
    expect(memos[0]!.whatWorked).toBe('none');
  });

  it('tolerates a blank line between the header fence and the JSON body', () => {
    const text = '```memory-memo\n\n{"userNeed": "blank line", "approach": "x", "outcome": "完成"}\n\n```';

    const memos = parseMemoryMemos(text);
    expect(memos.length).toBe(1);
    expect(memos[0]!.userNeed).toBe('blank line');
  });

  it('extracts a block embedded in surrounding prose', () => {
    const text =
      'Here is my summary of the session.\n\n' +
      'Some narrative about what happened.\n\n' +
      '```memory-memo\n{"userNeed": "embedded", "approach": "x", "outcome": "完成"}\n```\n\n' +
      'And some closing remarks.';

    const memos = parseMemoryMemos(text);
    expect(memos.length).toBe(1);
    expect(memos[0]!.userNeed).toBe('embedded');
  });

  it('returns an empty array when there is no memo block', () => {
    expect(parseMemoryMemos('just a plain summary with no blocks')).toEqual([]);
    expect(parseMemoryMemos('')).toEqual([]);
  });
});
