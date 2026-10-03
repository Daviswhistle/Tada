// Opt-in process-fixture bridge. The ordinary deterministic probe is unchanged.
// This controller's limits are test limits, not an authoritative task budget.
import { parseContract } from '../../contracts/src/index.mjs';
import { MockProvider } from '../../providers/src/mock.ts';
import { runModelLoop } from './model-loop.ts';
import { runDigestSession } from './session.ts';
export async function runMockModelSession(io, scenario) {
  const seed = parseContract('WorkerProposal', await io.receive());
  let delivered;
  let invoked = false;
  const outcome = await runModelLoop(new MockProvider(scenario), seed, {
    async invoke(proposal) {
      if (invoked) throw new Error('MODEL_FIXTURE_SINGLE_CALL');
      invoked = true;
      let bootstrap = true;
      // Preserve the existing worker-v1 propose/grant/invoke/replay flow. Keep
      // its final result locally until the follow-up model stream has ended.
      await runDigestSession({
        async receive() { if (bootstrap) { bootstrap=false; return proposal; } return io.receive(); },
        async send(message) {
          if (message.evidence_ref !== undefined) delivered=message;
          else await io.send(message);
        },
      });
      if (!delivered) throw new Error('MODEL_FIXTURE_NO_RECEIPT');
      return delivered;
    },
  }, {
    max_turns:6,max_tool_calls:1,max_recoveries:2,max_active_ms:scenario === 'hang' ? 150 : 10000,
    max_events:64,max_bytes:65536,max_call_bytes:16384,
  }, new AbortController().signal);
  // Model stop alone is not evidence. Even a committed read is insufficient if
  // the follow-up stream fails: the host must not checkpoint that conversation.
  if (outcome.state !== 'verify' || !delivered || outcome.evidence.length !== 1) {
    throw new Error('MODEL_FIXTURE_NOT_CHECKPOINTABLE');
  }
  await io.send(delivered);
}
