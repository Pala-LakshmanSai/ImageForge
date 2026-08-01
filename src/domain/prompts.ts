import type { DraftPrompt, ValidationIssue } from './types';

export const MAX_PROMPTS = 450;
export const MAX_PROMPT_LENGTH = 600;

export interface ParsedPromptResult {
  prompts: DraftPrompt[];
  issues: ValidationIssue[];
  sourceRows: number;
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function parseCsvRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const next = input[index + 1];

    if (character === '"' && quoted && next === '"') {
      field += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && next === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function rowsFromInput(input: string, sourceName?: string | null): Array<{ text: string; line: number }> {
  const normalized = input.replace(/^\uFEFF/, '');
  const isCsv = sourceName?.toLowerCase().endsWith('.csv') ?? false;
  if (!isCsv) {
    return normalized.split(/\r?\n/).map((text, index) => ({ text, line: index + 1 }));
  }

  const rows = parseCsvRows(normalized);
  if (rows.length === 0) return [];
  const headers = rows[0].map((cell) => cell.trim().toLowerCase());
  const promptColumn = headers.findIndex((header) =>
    ['prompt', 'description', 'image prompt', 'scene'].includes(header),
  );
  const start = promptColumn >= 0 ? 1 : 0;
  const column = promptColumn >= 0 ? promptColumn : 0;

  return rows.slice(start).map((row, index) => ({ text: row[column] ?? '', line: index + start + 1 }));
}

export function parsePromptText(input: string, sourceName?: string | null): ParsedPromptResult {
  const rows = rowsFromInput(input, sourceName);
  const nonEmptyRows = rows
    .map((row) => ({ ...row, text: row.text.trim().replace(/\s+/g, ' ') }))
    .filter((row) => row.text.length > 0);
  const counts = new Map<string, number>();

  nonEmptyRows.forEach(({ text }) => {
    const key = text.toLocaleLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });

  const issues: ValidationIssue[] = [];
  if (nonEmptyRows.length > MAX_PROMPTS) {
    issues.push({
      code: 'too_many',
      level: 'error',
      message: `${nonEmptyRows.length} prompts found. ImageForge accepts at most ${MAX_PROMPTS} in one batch.`,
    });
  }

  const prompts = nonEmptyRows.map(({ text, line }, index): DraftPrompt => {
    const promptIssues: ValidationIssue[] = [];
    if (text.length > MAX_PROMPT_LENGTH) {
      promptIssues.push({
        code: 'too_long',
        level: 'error',
        line,
        message: `Line ${line} is ${text.length} characters; shorten it to ${MAX_PROMPT_LENGTH}.`,
      });
    }
    if (text.length < 12) {
      promptIssues.push({
        code: 'too_short',
        level: 'warning',
        line,
        message: `Line ${line} is unusually short and may produce an ambiguous image.`,
      });
    }
    if ((counts.get(text.toLocaleLowerCase()) ?? 0) > 1) {
      promptIssues.push({
        code: 'duplicate',
        level: 'warning',
        line,
        message: `Line ${line} duplicates another prompt. It will still keep its ordered slot.`,
      });
    }

    const hash = stableHash(`${index}:${text}`);
    issues.push(...promptIssues);
    return {
      id: `prompt-${index + 1}-${hash.toString(36)}`,
      index: index + 1,
      sourceLine: line,
      text,
      seed: 100_000 + (hash % 900_000),
      issues: promptIssues,
    };
  });

  return { prompts, issues, sourceRows: rows.length };
}

export const SAMPLE_PROMPTS = [
  'A solitary marine biologist walking across a black sand beach at blue hour, wind lifting her field notes',
  'Close editorial portrait of a ceramic artist in a sunlit Jaipur workshop, clay dust suspended in the air',
  'A rain-soaked night market seen from inside a quiet tea shop, reflections glowing across the glass',
  'Wide aerial view of terraced farms curving around a misty Himalayan valley at first light',
  'An old astronomer calibrating a brass telescope beneath a clear desert sky, documentary photography',
  'Two architects reviewing paper plans inside an unfinished concrete museum, strong side light',
  'A red fishing boat crossing a slate-blue Nordic fjord with low clouds folding over the mountains',
  'Young robotics students testing a small rover in a bright community workshop, candid and optimistic',
  'An empty suburban swimming pool after a summer storm, scattered leaves and cinematic morning haze',
  'Macro view of a watchmaker placing a tiny gear into a mechanical movement under a task lamp',
  'A chef carrying fresh herbs through a quiet restaurant kitchen moments before evening service',
  'Families boarding a rural train at dawn, warm carriage light against a cool foggy platform',
  'A conservation team releasing a sea turtle at the shoreline as distant clouds catch sunrise color',
  'A fashion designer pinning indigo fabric on a dress form in a restrained daylight studio',
  'Wide interior of a modern public library with one reader crossing the patterned floor below skylights',
  'A cyclist pausing beside a high alpine road, weather moving quickly across the valley behind him',
  'Hands sorting handwritten letters on a dark oak table, soft window light and archival detail',
  'A lighthouse keeper climbing an exterior stair during a winter squall, ocean spray in the air',
  'A field researcher recording measurements among tall amber grass just before sunset',
  'Night shift engineers monitoring a hydroelectric control room, practical light and quiet concentration',
  'A small bookstore opening for the morning, owner turning the sign as sunlight enters the doorway',
  'Birds lifting from a flooded rice field while a farmer walks the narrow ridge in early mist',
  'A cellist rehearsing alone on an empty theater stage beneath a single work light',
  'A weathered expedition tent on a Patagonian ridge, tiny against fast-moving cloud and stone',
].join('\n');
