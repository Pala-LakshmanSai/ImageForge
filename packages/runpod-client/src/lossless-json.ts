const NUMBER_TOKENS = new WeakMap<object, ReadonlyMap<string, string>>();

export class LosslessJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LosslessJsonError";
  }
}

interface ParsedValue {
  readonly value: unknown;
  readonly numberToken: string | null;
}

/**
 * A small, strict JSON decoder that retains the exact spelling of every JSON
 * number token. The returned value remains ordinary JavaScript data for legacy
 * callers; number-token evidence is available only through
 * `getLosslessJsonNumberToken` and never serialized back to provider payloads.
 */
export function parseLosslessJson(text: string): unknown {
  if (typeof text !== "string" || text.length > 8 * 1024 * 1024) {
    throw new LosslessJsonError("JSON response size is invalid.");
  }

  let offset = 0;

  function fail(message: string): never {
    throw new LosslessJsonError(`${message} at byte ${offset}.`);
  }

  function skipWhitespace(): void {
    while (offset < text.length && /[\u0009\u000a\u000d\u0020]/.test(text[offset] ?? "")) {
      offset += 1;
    }
  }

  function parseString(): string {
    if (text[offset] !== '"') fail("Expected a JSON string");
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      const character = text[offset];
      if (character === '"') {
        offset += 1;
        try {
          return JSON.parse(text.slice(start, offset)) as string;
        } catch {
          fail("Invalid JSON string");
        }
      }
      if (character === "\\") {
        offset += 1;
        const escape = text[offset];
        if (escape === "u") {
          const digits = text.slice(offset + 1, offset + 5);
          if (!/^[0-9A-Fa-f]{4}$/.test(digits)) fail("Invalid Unicode escape");
          offset += 5;
          continue;
        }
        if (escape === undefined || !/^["\\/bfnrt]$/.test(escape)) {
          fail("Invalid string escape");
        }
        offset += 1;
        continue;
      }
      if (character === undefined || character.charCodeAt(0) < 0x20) {
        fail("Invalid control character in JSON string");
      }
      offset += 1;
    }
    fail("Unterminated JSON string");
  }

  function parseNumber(): ParsedValue {
    const start = offset;
    if (text[offset] === "-") offset += 1;
    if (text[offset] === "0") {
      offset += 1;
      if (/[0-9]/.test(text[offset] ?? "")) fail("Leading zero in JSON number");
    } else if (/[1-9]/.test(text[offset] ?? "")) {
      while (/[0-9]/.test(text[offset] ?? "")) offset += 1;
    } else {
      fail("Invalid JSON number");
    }
    if (text[offset] === ".") {
      offset += 1;
      if (!/[0-9]/.test(text[offset] ?? "")) fail("Missing fractional digits");
      while (/[0-9]/.test(text[offset] ?? "")) offset += 1;
    }
    if (text[offset] === "e" || text[offset] === "E") {
      offset += 1;
      if (text[offset] === "+" || text[offset] === "-") offset += 1;
      if (!/[0-9]/.test(text[offset] ?? "")) fail("Missing exponent digits");
      while (/[0-9]/.test(text[offset] ?? "")) offset += 1;
    }
    const lexeme = text.slice(start, offset);
    const numeric = Number(lexeme);
    if (!Number.isFinite(numeric)) fail("JSON number is outside the finite range");
    return { value: numeric, numberToken: lexeme };
  }

  function parseArray(): ParsedValue {
    const result: unknown[] = [];
    const tokens = new Map<string, string>();
    offset += 1;
    skipWhitespace();
    if (text[offset] === "]") {
      offset += 1;
      NUMBER_TOKENS.set(result, tokens);
      return { value: result, numberToken: null };
    }
    while (true) {
      const index = result.length;
      const parsed = parseValue();
      result.push(parsed.value);
      if (parsed.numberToken !== null) tokens.set(String(index), parsed.numberToken);
      skipWhitespace();
      if (text[offset] === "]") {
        offset += 1;
        NUMBER_TOKENS.set(result, tokens);
        return { value: result, numberToken: null };
      }
      if (text[offset] !== ",") fail("Expected comma in JSON array");
      offset += 1;
      skipWhitespace();
    }
  }

  function parseObject(): ParsedValue {
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const tokens = new Map<string, string>();
    offset += 1;
    skipWhitespace();
    if (text[offset] === "}") {
      offset += 1;
      NUMBER_TOKENS.set(result, tokens);
      return { value: result, numberToken: null };
    }
    while (true) {
      const key = parseString();
      if (Object.hasOwn(result, key)) fail("Duplicate JSON object key");
      skipWhitespace();
      if (text[offset] !== ":") fail("Expected colon in JSON object");
      offset += 1;
      const parsed = parseValue();
      result[key] = parsed.value;
      if (parsed.numberToken !== null) tokens.set(key, parsed.numberToken);
      skipWhitespace();
      if (text[offset] === "}") {
        offset += 1;
        NUMBER_TOKENS.set(result, tokens);
        return { value: result, numberToken: null };
      }
      if (text[offset] !== ",") fail("Expected comma in JSON object");
      offset += 1;
      skipWhitespace();
    }
  }

  function parseValue(): ParsedValue {
    skipWhitespace();
    const character = text[offset];
    if (character === '"') return { value: parseString(), numberToken: null };
    if (character === "{") return parseObject();
    if (character === "[") return parseArray();
    if (character === "-" || /[0-9]/.test(character ?? "")) return parseNumber();
    if (text.startsWith("true", offset)) {
      offset += 4;
      return { value: true, numberToken: null };
    }
    if (text.startsWith("false", offset)) {
      offset += 5;
      return { value: false, numberToken: null };
    }
    if (text.startsWith("null", offset)) {
      offset += 4;
      return { value: null, numberToken: null };
    }
    fail("Invalid JSON value");
  }

  const parsed = parseValue();
  skipWhitespace();
  if (offset !== text.length) fail("Trailing bytes after JSON value");
  if (parsed.numberToken !== null) {
    const root = Object.freeze({ value: parsed.value });
    NUMBER_TOKENS.set(root, new Map([["value", parsed.numberToken]]));
    return root;
  }
  return parsed.value;
}

export function getLosslessJsonNumberToken(
  container: unknown,
  key: string | number,
): string | null {
  if ((typeof container !== "object" || container === null) && typeof container !== "function") {
    return null;
  }
  return NUMBER_TOKENS.get(container)?.get(String(key)) ?? null;
}

export function parseLosslessJsonNumberToken(text: string): { readonly value: number; readonly token: string } {
  const parsed = parseLosslessJson(text);
  if (typeof parsed !== "object" || parsed === null || !("value" in parsed)) {
    throw new LosslessJsonError("Expected one JSON number token.");
  }
  const token = getLosslessJsonNumberToken(parsed, "value");
  const value = (parsed as { readonly value?: unknown }).value;
  if (token === null || typeof value !== "number") {
    throw new LosslessJsonError("Expected one JSON number token.");
  }
  return Object.freeze({ value, token });
}
