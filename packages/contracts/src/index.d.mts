import type { ContractMap as CoreContractMap } from './generated/types.js';
import type { WorkerContractMap } from './generated/worker.js';
import type { ModelContractMap } from './generated/model.js';
type ContractMap = CoreContractMap & WorkerContractMap & ModelContractMap;
export type * from './generated/types.js';
export type * from './generated/worker.js';
export type * from './generated/model.js';
export function validateContract(name: string, value: unknown): { valid: boolean; errors: string[] };
export function parseContract<K extends keyof ContractMap>(name: K, value: unknown): ContractMap[K];
