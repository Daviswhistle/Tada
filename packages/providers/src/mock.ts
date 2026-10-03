// Deterministic, no-I/O provider fixture. Not a live-provider compatibility claim.
import type { ModelRequest, ProviderAdapter } from './stream.ts';
export const MOCK_SCENARIOS = ['normal','repair-once','partial-always','repeated-error','capacity','auth','network','text-only','after-tool-error','scope-change','hang'] as const;
export type MockScenario = typeof MOCK_SCENARIOS[number];
export class MockProvider implements ProviderAdapter {
  readonly id = 'tada-mock-v1';
  private turns = 0;
  private readonly scenario: MockScenario;
  constructor(scenario: MockScenario = 'normal') {
    if (!MOCK_SCENARIOS.includes(scenario)) throw new Error('MODEL_MOCK_SCENARIO');
    this.scenario = scenario;
  }
  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<unknown> {
    this.turns++;
    let seq = 0;
    const event = (type: string, fields: Record<string, unknown> = {}): unknown => ({schema_version:1,request_id:request.request_id,seq:++seq,type,...fields});
    if (signal.aborted) return;
    if (this.scenario === 'hang') {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return;
    }
    yield event('usage',{input_tokens:10,output_tokens:3});
    if (this.scenario === 'capacity') { yield event('rate_limit',{retry_after_ms:60000}); return; }
    if (this.scenario === 'auth' || this.scenario === 'network') { yield event('failed',{category:this.scenario}); return; }
    if (this.scenario === 'text-only') {
      yield event('text_delta',{value:'The task is complete.'});
      yield event('completed',{finish_reason:'stop'}); return;
    }
    if (this.scenario === 'repeated-error' || (this.scenario === 'after-tool-error' && request.phase === 'after_tool')) {
      yield event('failed',{category:'protocol'}); return;
    }
    const seed = JSON.parse(request.proposal_json) as {call_id:string;tool:string};
    if (this.scenario === 'partial-always' || (this.scenario === 'repair-once' && this.turns === 1)) {
      yield event('tool_call_delta',{call_id:seed.call_id,chunk:request.proposal_json.slice(0,20)}); return;
    }
    if (request.phase === 'after_tool') {
      if (request.evidence_refs.length === 0) throw new Error('MODEL_MOCK_EVIDENCE_REQUIRED');
      yield event('completed',{finish_reason:'stop'}); return;
    }
    const payload = this.scenario === 'scope-change' ? JSON.stringify({...seed,tool:'credential.export'}) : request.proposal_json;
    const middle = Math.floor(payload.length / 2);
    yield event('tool_call_delta',{call_id:seed.call_id,chunk:payload.slice(0,middle)});
    yield event('tool_call_delta',{call_id:seed.call_id,chunk:payload.slice(middle)});
    yield event('tool_call_complete',{call_id:seed.call_id,payload_json:payload});
    yield event('usage',{input_tokens:10,output_tokens:5});
    yield event('completed',{finish_reason:'tool_calls'});
  }
}
