export interface GodotCall {
  readonly kind: 'call';
  readonly name: string;
  readonly args: GodotValue[];
}

export type GodotValue =
  | null
  | boolean
  | number
  | string
  | GodotCall
  | GodotValue[]
  | { [key: string]: GodotValue };

export interface TSCNSection {
  type: string;
  attributes: Record<string, GodotValue>;
  line: number;
}

export interface TSCNResourceSection extends TSCNSection {
  id: string;
  resourceType: string;
  properties: Record<string, GodotValue>;
}

export type GodotResourceSection = TSCNResourceSection;

export interface TSCNNodeSection extends TSCNSection {
  name: string;
  nodeType: string;
  parent: string;
  properties: Record<string, GodotValue>;
}

export interface TSCNConnectionSection extends TSCNSection {
  from: string;
  to: string;
  signal: string;
  method: string;
}

export interface ParsedTSCN {
  scene: TSCNSection | null;
  resourceProperties: Record<string, GodotValue>;
  externalResources: TSCNResourceSection[];
  subResources: TSCNResourceSection[];
  nodes: TSCNNodeSection[];
  connections: TSCNConnectionSection[];
}

export class TSCNParseError extends Error {
  readonly sourceLine?: number;

  constructor(message: string, sourceLine?: number) {
    super(sourceLine === undefined ? message : `Line ${sourceLine}: ${message}`);
    this.name = 'TSCNParseError';
    this.sourceLine = sourceLine;
  }
}

export function isGodotCall(value: GodotValue | undefined): value is GodotCall {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'kind' in value && value.kind === 'call';
}

export function call(name: string, ...args: GodotValue[]): GodotCall {
  return { kind: 'call', name, args };
}
