import { GodotValueParser } from './GodotValueParser.js';
import { TSCNParseError, type ParsedTSCN, type TSCNSection, type TSCNResourceSection, type TSCNNodeSection, type TSCNConnectionSection, type GodotValue } from './types.js';

/** Parses Godot 4 text scenes into sections and typed Variant values. */
export class TSCNParser {
  parse(source: string): ParsedTSCN {
    return this.parseInternal(source, true);
  }

  parseResource(source: string): ParsedTSCN {
    return this.parseInternal(source, false);
  }

  private parseInternal(source: string, requireNode: boolean): ParsedTSCN {
    const result: ParsedTSCN = { scene: null, resourceProperties: {}, externalResources: [], subResources: [], nodes: [], connections: [] };
    const chunks = splitSections(source);
    for (const chunk of chunks) {
      const { type, attributes, line } = parseHeader(chunk.header, chunk.line);
      const section: TSCNSection = { type, attributes, line };
      const properties = parseProperties(chunk.body, chunk.line + 1);
      switch (type) {
        case 'gd_scene': result.scene = section; break;
        case 'gd_resource': result.scene = section; result.resourceProperties = properties; break;
        case 'resource': result.resourceProperties = properties; break;
        case 'ext_resource': result.externalResources.push({ ...section, id: stringAttr(attributes, 'id', line), resourceType: stringAttr(attributes, 'type', line), properties }); break;
        case 'sub_resource': result.subResources.push({ ...section, id: stringAttr(attributes, 'id', line), resourceType: stringAttr(attributes, 'type', line), properties }); break;
        case 'node': {
          const name = stringAttr(attributes, 'name', line);
          result.nodes.push({ ...section, name, nodeType: stringAttr(attributes, 'type', line, ''), parent: stringAttr(attributes, 'parent', line, '.'), properties });
          break;
        }
        case 'connection': {
          result.connections.push({ ...section, from: stringAttr(attributes, 'from', line), to: stringAttr(attributes, 'to', line), signal: stringAttr(attributes, 'signal', line), method: stringAttr(attributes, 'method', line) });
          break;
        }
        default: break; // Other Godot metadata sections do not affect the scene graph.
      }
    }
    if (requireNode && !result.nodes.length) throw new TSCNParseError('Scene contains no node sections');
    return result;
  }
}

interface SectionChunk { header: string; body: string; line: number }

function splitSections(source: string): SectionChunk[] {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  const chunks: SectionChunk[] = [];
  let current: SectionChunk | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\[/.test(line) && !/^\s*\[\s*\{/.test(line)) {
      if (current) chunks.push(current);
      current = { header: line.trim(), body: '', line: i + 1 };
    } else if (current) current.body += `${line}\n`;
  }
  if (current) chunks.push(current);
  return chunks;
}

function parseHeader(source: string, line: number): { type: string; attributes: Record<string, GodotValue>; line: number } {
  const end = findHeaderEnd(source);
  if (end < 0) throw new TSCNParseError('Malformed section header', line);
  const inner = source.slice(source.indexOf('[') + 1, end).trim();
  const match = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
  if (!match) throw new TSCNParseError('Missing section name', line);
  const type = match[1];
  const attributes: Record<string, GodotValue> = {};
  const rest = inner.slice(match[0].length);
  let cursor = 0;
  while (cursor < rest.length) {
    while (/\s/.test(rest[cursor] ?? '')) cursor++;
    if (cursor >= rest.length) break;
    const key = rest.slice(cursor).match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0];
    if (!key) throw new TSCNParseError(`Malformed header attribute near '${rest.slice(cursor)}'`, line);
    cursor += key.length;
    while (/\s/.test(rest[cursor] ?? '')) cursor++;
    if (rest[cursor++] !== '=') throw new TSCNParseError(`Expected '=' after '${key}'`, line);
    while (/\s/.test(rest[cursor] ?? '')) cursor++;
    const valueStart = cursor;
    let quote = '';
    let escaped = false;
    while (cursor < rest.length) {
      const char = rest[cursor];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = '';
      } else if (char === '"' || char === "'") quote = char;
      else if (/\s/.test(char)) break;
      cursor++;
    }
    attributes[key] = new GodotValueParser(rest.slice(valueStart, cursor), line).parse();
  }
  return { type, attributes, line };
}

function findHeaderEnd(value: string): number {
  let quote = '';
  let escaped = false;
  for (let i = value.indexOf('[') + 1; i < value.length; i++) {
    const char = value[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ']') return i;
  }
  return -1;
}

function parseProperties(body: string, startLine: number): Record<string, GodotValue> {
  const properties: Record<string, GodotValue> = {};
  const lines = body.split(/\r?\n/);
  let statement = '';
  let statementLine = startLine;
  let depth = 0;
  let quote = '';
  let escaped = false;

  const commit = () => {
    const cleaned = stripComment(statement).trim();
    if (!cleaned) return;
    const eq = findTopLevelEquals(cleaned);
    if (eq < 0) throw new TSCNParseError(`Expected key=value, got '${cleaned.slice(0, 80)}'`, statementLine);
    const key = cleaned.slice(0, eq).trim();
    if (!key) throw new TSCNParseError('Missing property name', statementLine);
    properties[key] = new GodotValueParser(cleaned.slice(eq + 1).trim(), statementLine).parse();
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!statement && (!raw.trim() || /^\s*#/.test(raw))) { statementLine = startLine + i + 1; continue; }
    if (!statement) statementLine = startLine + i;
    statement += `${statement ? '\n' : ''}${raw}`;
    const visible = stripComment(raw);
    for (const char of visible) {
      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = '';
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '(' || char === '[' || char === '{') depth++;
      else if (char === ')' || char === ']' || char === '}') depth--;
    }
    if (!quote && depth <= 0) {
      commit();
      statement = '';
      depth = 0;
    }
  }
  if (statement.trim()) throw new TSCNParseError('Unterminated multiline value', statementLine);
  return properties;
}

function stripComment(line: string): string {
  let quote = '';
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '#') return line.slice(0, i);
  }
  return line;
}

function findTopLevelEquals(source: string): number {
  let quote = '';
  let escaped = false;
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '(' || char === '[' || char === '{') depth++;
    else if (char === ')' || char === ']' || char === '}') depth--;
    else if (char === '=' && depth === 0) return i;
  }
  return -1;
}

function stringAttr(attrs: Record<string, GodotValue>, key: string, line: number, fallback?: string): string {
  const value = attrs[key];
  if (typeof value === 'string') return value;
  if (fallback !== undefined) return fallback;
  throw new TSCNParseError(`Section is missing string attribute '${key}'`, line);
}
