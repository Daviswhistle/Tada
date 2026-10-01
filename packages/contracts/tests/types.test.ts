import { parseContract } from '../src/index.mjs';
import type { TaskContract, TaskSnapshot, ActionState } from '../src/generated/types.js';

const task: TaskContract = parseContract('TaskContract', {} as unknown);
const status: TaskSnapshot = parseContract('TaskSnapshot', {} as unknown);
const state: ActionState = 'UNCERTAIN';
void [task, status, state];
// @ts-expect-error A future wire version must not silently enter this protocol.
const badVersion: TaskContract['contract_version'] = 2;
// @ts-expect-error Unknown completion labels are not allowed.
const badStatus: TaskSnapshot['completion_status'] = 'DONE';
// @ts-expect-error A task parser does not return an action record.
const badAction: { action_id: string } = parseContract('TaskContract', {});
void [badVersion, badStatus, badAction];
