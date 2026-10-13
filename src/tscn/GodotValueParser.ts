import { call, type GodotValue, TSCNParseError } from './types.js';

/** Recursive-descent parser for Godot's serialized Variant expressions. */
export class GodotValueParser {
  private cursor = 0;
  private readonly source: string;
  private readonly line?: number;

  constructor(source: string, line?: number) {
    this.source = source;
    this.line = line;
  }

  parse(): GodotValue {
    this.cursor = 0;
    const value = this.parseValue();
    this.skipSpace();
    if (this.cursor < this.source.length) this.fail(`Unexpected token '${this.source[this.cursor]}'`);
    return value;
  }

  private parseValue(): GodotValue {
    this.skipSpace();
    const char = this.source[this.cursor];
    if ((char === '&' || char === '^') && (this.source[this.cursor + 1] === '"' || this.source[this.cursor + 1] === "'")) {
      this.cursor++;
      return this.parseString();
    }
    if (char === '"' || char === "'") return this.parseString();
    if (char === '[') return this.parseArray();
    if (char === '{') return this.parseDictionary();
    if (char === '-' || char === '+' || char === '.' || /\d/.test(char ?? '')) return this.parseNumber();

    const identifier = this.parseIdentifier();
    if (!identifier) this.fail('Expected a value');
    if (identifier === 'true') return true;
    if (identifier === 'false') return false;
    if (identifier === 'null' || identifier === 'Nil') return null;

    this.skipSpace();
    if (this.source[this.cursor] === '(') {
      this.cursor++;
      const args: GodotValue[] = [];
      this.skipSpace();
      while (this.cursor < this.source.length && this.source[this.cursor] !== ')') {
        args.push(this.parseValue());
        this.skipSpace();
        if (this.source[this.cursor] === ',') {
          this.cursor++;
          this.skipSpace();
          continue;
        }
        if (this.source[this.cursor] !== ')') this.fail("Expected ',' or ')' in constructor");
      }
      this.expect(')');
      return call(identifier, ...args);
    }
    return identifier;
  }

  private parseArray(): GodotValue[] {
    this.expect('[');
    const values: GodotValue[] = [];
    this.skipSpace();
    while (this.cursor < this.source.length && this.source[this.cursor] !== ']') {
      values.push(this.parseValue());
      this.skipSpace();
      if (this.source[this.cursor] === ',') {
        this.cursor++;
        this.skipSpace();
      } else if (this.source[this.cursor] !== ']') this.fail("Expected ',' or ']' in array");
    }
    this.expect(']');
    return values;
  }

  private parseDictionary(): { [key: string]: GodotValue } {
    this.expect('{');
    const value: { [key: string]: GodotValue } = {};
    this.skipSpace();
    while (this.cursor < this.source.length && this.source[this.cursor] !== '}') {
      const keyValue = this.parseValue();
      if (typeof keyValue !== 'string' && typeof keyValue !== 'number') this.fail('Dictionary keys must be strings or numbers');
      this.skipSpace();
      this.expect(':');
      value[String(keyValue)] = this.parseValue();
      this.skipSpace();
      if (this.source[this.cursor] === ',') {
        this.cursor++;
        this.skipSpace();
      } else if (this.source[this.cursor] !== '}') this.fail("Expected ',' or '}' in dictionary");
    }
    this.expect('}');
    return value;
  }

  private parseString(): string {
    const quote = this.source[this.cursor++];
    let result = '';
    while (this.cursor < this.source.length) {
      const char = this.source[this.cursor++];
      if (char === quote) return result;
      if (char === '\\') {
        const escaped = this.source[this.cursor++];
        const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '\\': '\\', '"': '"', "'": "'" };
        result += escapes[escaped] ?? escaped;
      } else result += char;
    }
    this.fail('Unterminated string');
  }

  private parseNumber(): number {
    const match = this.source.slice(this.cursor).match(/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
    if (!match) this.fail('Malformed number');
    this.cursor += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail(`Non-finite number '${match[0]}'`);
    return value;
  }

  private parseIdentifier(): string {
    const match = this.source.slice(this.cursor).match(/^[A-Za-z_][A-Za-z0-9_:.]*/);
    if (!match) return '';
    this.cursor += match[0].length;
    return match[0];
  }

  private skipSpace(): void {
    while (/\s/.test(this.source[this.cursor] ?? '')) this.cursor++;
  }

  private expect(token: string): void {
    this.skipSpace();
    if (this.source[this.cursor] !== token) this.fail(`Expected '${token}'`);
    this.cursor++;
  }

  private fail(message: string): never {
    throw new TSCNParseError(message, this.line);
  }
}
