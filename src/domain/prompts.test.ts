import { describe, expect, it } from 'vitest';
import { MAX_PROMPTS, parsePromptText } from './prompts';

describe('parsePromptText', () => {
  it('normalizes pasted lines, skips blanks, and preserves stable order', () => {
    const result = parsePromptText('  First detailed editorial image  \n\nSecond detailed editorial image\r\n');

    expect(result.prompts).toHaveLength(2);
    expect(result.prompts.map((prompt) => prompt.index)).toEqual([1, 2]);
    expect(result.prompts.map((prompt) => prompt.text)).toEqual([
      'First detailed editorial image',
      'Second detailed editorial image',
    ]);
    expect(parsePromptText('  First detailed editorial image  \n\nSecond detailed editorial image\r\n').prompts)
      .toEqual(result.prompts);
  });

  it('parses a quoted CSV prompt column without treating commas as new prompts', () => {
    const result = parsePromptText(
      'index,prompt,notes\n1,"A quiet room, seen at dawn",keep\n2,"A field researcher at work",keep',
      'brief.csv',
    );

    expect(result.prompts.map((prompt) => prompt.text)).toEqual([
      'A quiet room, seen at dawn',
      'A field researcher at work',
    ]);
    expect(result.prompts.map((prompt) => prompt.sourceLine)).toEqual([2, 3]);
  });

  it('warns about duplicate slots but keeps both in numeric order', () => {
    const result = parsePromptText('A detailed repeated prompt\nA detailed repeated prompt');

    expect(result.prompts).toHaveLength(2);
    expect(result.issues.filter((issue) => issue.code === 'duplicate')).toHaveLength(2);
    expect(result.issues.every((issue) => issue.level === 'warning')).toBe(true);
  });

  it('blocks lists above the 450 prompt product limit', () => {
    const input = Array.from({ length: MAX_PROMPTS + 1 }, (_, index) => `Detailed editorial prompt number ${index + 1}`).join('\n');
    const result = parsePromptText(input);

    expect(result.prompts).toHaveLength(451);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'too_many', level: 'error' }));
  });

  it('explains skipped blank rows without treating a trailing newline as an issue', () => {
    const result = parsePromptText('First detailed editorial image\n\nSecond detailed editorial image\n');

    expect(result.prompts).toHaveLength(2);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'empty', level: 'warning', line: 2 }));
    expect(result.issues.filter((issue) => issue.code === 'empty')).toHaveLength(1);
  });

  it('blocks an unterminated quoted CSV field', () => {
    const result = parsePromptText('prompt,notes\n"A quiet room at dawn,keep', 'brief.csv');

    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'invalid_csv', level: 'error' }));
  });
});
