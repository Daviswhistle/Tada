import { parseContract, type WorkerProposal, type WorkerRequest, type WorkerPolicy } from '../src/index.mjs';

// Compile-only checks: generated worker contracts participate in typed decoding.
export function typedWorkerBoundary(value: unknown): WorkerProposal {
  return parseContract('WorkerProposal', value);
}
export function typedWorkerRequest(value: unknown): WorkerRequest {
  return parseContract('WorkerRequest', value);
}
export function typedHostPolicy(value: unknown): WorkerPolicy {
  return parseContract('WorkerPolicy', value);
}
