import type { ContractMap } from './generated/types.js';
export type * from './generated/types.js';
export function validateContract(name: string, value: unknown): { valid: boolean; errors: string[] };
export function parseContract<K extends keyof ContractMap>(name: K, value: unknown): ContractMap[K];
