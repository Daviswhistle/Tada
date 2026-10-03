"""One-shot SEC-01 source import. Exact base blobs are checked before edits.
This script creates explicit schema/fixture files, then removes itself. It is
not part of runtime startup, installation or the final read-only CI workflow.
"""
import copy
import hashlib
import json
from pathlib import Path

root = Path('.')
def replace(path, sha, old, new):
    p = root / path
    raw = p.read_bytes()
    actual = hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
    assert actual == sha, (path, actual)
    s = raw.decode()
    assert s.count(old) == 1, path
    p.write_text(s.replace(old, new))

replace('crates/store/src/control/mod.rs', 'a290c3697da894423f042a961c3a89829c5f761a',
        'pub mod auth;\nmod json_input;',
        'pub mod auth;\nmod json_input;\n// Separate host-bound worker API; never routed through the UI control methods.\npub mod worker;')
p = root / 'crates/contracts/src/lib.rs'
raw = p.read_bytes()
assert hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest() == 'e8442020aa5597a56351b5dc72ccdfca2b3e95e8'
s = raw.decode()
old = 'pub use generated::*;'
assert s.count(old) == 1
s = s.replace(old, old + '\n\n#[rustfmt::skip]\npub mod worker;')
old = '''    if !CONTRACT_NAMES.contains(&name) {
        return Err(ContractError("UNKNOWN_CONTRACT"));
    }
    let mut schema: Value =
        serde_json::from_str(include_str!("../../../packages/contracts/schema/v1.json"))'''
new = '''    let source = if CONTRACT_NAMES.contains(&name) {
        include_str!("../../../packages/contracts/schema/v1.json")
    } else if worker::CONTRACT_NAMES.contains(&name) {
        include_str!("../../../packages/contracts/schema/worker.v1.json")
    } else {
        return Err(ContractError("UNKNOWN_CONTRACT"));
    };
    let mut schema: Value = serde_json::from_str(source)'''
assert s.count(old) == 1
p.write_text(s.replace(old, new))
replace('packages/contracts/src/index.mjs', 'ef2cf8d4ca1afeb92e0b3b0e416a354138ca5801',
'''const schema = JSON.parse(readFileSync(new URL('../schema/v1.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: true, strictRequired: false, strictTypes: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(schema);
const validators = new Map();
for (const [name, definition] of Object.entries(schema.$defs)) {
  if (definition.type === 'object') validators.set(name, ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` }));
}''',
'''const schemas = ['v1.json', 'worker.v1.json'].map((name) =>
  JSON.parse(readFileSync(new URL('../schema/' + name, import.meta.url), 'utf8')));
const ajv = new Ajv2020({ strict: true, strictRequired: false, strictTypes: false, allErrors: true });
addFormats(ajv);
const validators = new Map();
for (const schema of schemas) {
  ajv.addSchema(schema);
  for (const [name, definition] of Object.entries(schema.$defs)) {
    if (definition.type !== 'object') continue;
    if (validators.has(name)) throw new Error('Duplicate contract name');
    validators.set(name, ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` }));
  }
}''')
replace('packages/contracts/src/index.d.mts', '157e0ab3768f14d1300535d595ff8efe743cf759',
'''import type { ContractMap } from './generated/types.js';
export type * from './generated/types.js';''',
'''import type { ContractMap as CoreContractMap } from './generated/types.js';
import type { WorkerContractMap } from './generated/worker.js';
type ContractMap = CoreContractMap & WorkerContractMap;
export type * from './generated/types.js';
export type * from './generated/worker.js';''')
replace('package.json', 'bf0459acb68a9873a0bfd77e433a82bb02014bc6',
'''    "generate": "node scripts/generate-contracts.mjs",
    "generate:check": "node scripts/generate-contracts.mjs --check",''',
'''    "generate": "node scripts/generate-contracts.mjs && node scripts/generate-worker-contracts.mjs",
    "generate:check": "node scripts/generate-contracts.mjs --check && node scripts/generate-worker-contracts.mjs --check",''')
replace('README.md', '75c3838473deab4424b5a280746ca9568b3d8203',
        '## Next gates',
'''## Worker authority admission

[SEC-01A](docs/worker-authority.md) adds a host-bound, exact-scope policy and one-call grant broker. It evaluates DENY/ALLOW/REQUIRE_DECISION/HANDOFF, rechecks cancellation, revocation, generation, fence, scope and monotonic expiry at admission, and records read-only invocation results in the existing witnessed ledger. Rust and TypeScript validate the same separate worker-v1 schema and 41 fixtures; existing task/control v1 is unchanged.

The only registered tool is `task.contract_digest`, which reads the immutable digest of its own assigned task. The serialized worker request API is a library boundary, not yet connected to the native process pipe or a TypeScript engine. Policy/channel creation stays on the trusted host, never in the UI or model RPC router. There is no file, shell, network, credential-export or task-completion capability in this slice.

```sh
cargo test --locked -p tada-store control::worker:: -- --nocapture
```

## Next gates''')

# The new schema is independent; original task/control definitions stay byte-identical.
D = {}
def ref(n): return {'$ref':'#/$defs/'+n}
def obj(name, props, optional=(), **extra):
    D[name] = {'type':'object','additionalProperties':False,'properties':props,'required':[k for k in props if k not in optional],**extra}
def arr(item): return {'type':'array','items':item,'minItems':0,'maxItems':64,'uniqueItems':True}
v = {'type':'integer','const':1}
D['WorkerId'] = {'type':'string','pattern':'^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'}
D['WorkerText'] = {'type':'string','minLength':1,'maxLength':1024}
D['WorkerHash'] = {'type':'string','pattern':'^[a-f0-9]{64}$'}
D['WorkerCounter'] = {'type':'integer','minimum':0,'maximum':9007199254740991}
D['WorkerPositive'] = {'type':'integer','minimum':1,'maximum':9007199254740991}
D['WorkerDecision'] = {'type':'string','enum':['DENY','ALLOW','REQUIRE_DECISION','HANDOFF']}
D['WorkerOrigin'] = {'type':'string','enum':['user_request','user_decision','local_policy']}
obj('WorkerRule', {'tool':ref('WorkerId'),'tool_version':ref('WorkerPositive'),'resource':ref('WorkerText'),'purpose':ref('WorkerText'),'decision':ref('WorkerDecision')})
obj('WorkerPolicy', {'schema_version':v,'profile_id':ref('WorkerId'),'revision':ref('WorkerPositive'),'origin':ref('WorkerOrigin'),'denied_tools':arr(ref('WorkerId')),'rules':arr(ref('WorkerRule')),'max_calls':{'type':'integer','minimum':1,'maximum':64},'grant_ttl_ms':{'type':'integer','minimum':1,'maximum':60000}})
obj('WorkerArguments', {'expected_hash':ref('WorkerHash')})
obj('WorkerProposal', {'schema_version':v,'call_id':ref('WorkerId'),'task_id':ref('WorkerId'),'tool':ref('WorkerId'),'tool_version':ref('WorkerPositive'),'resource':ref('WorkerText'),'purpose':ref('WorkerText'),'arguments':ref('WorkerArguments')})
obj('WorkerGrant', {'schema_version':v,'grant_id':ref('WorkerId'),'subject':ref('WorkerId'),'task_id':ref('WorkerId'),'tool':ref('WorkerId'),'tool_version':ref('WorkerPositive'),'resource':ref('WorkerText'),'purpose':ref('WorkerText'),'payload_hash':ref('WorkerHash'),'profile_id':ref('WorkerId'),'policy_revision':ref('WorkerPositive'),'generation':ref('WorkerPositive'),'cancel_epoch':ref('WorkerCounter'),'fencing_token':ref('WorkerPositive'),'expires_at_ms':ref('WorkerPositive')})
obj('WorkerAuthorization', {'schema_version':v,'decision':ref('WorkerDecision'),'reason':ref('WorkerId'),'grant':ref('WorkerGrant')}, optional=('grant',), allOf=[{'if':{'properties':{'decision':{'const':'ALLOW'}},'required':['decision']},'then':{'required':['grant']},'else':{'not':{'required':['grant']}}}])
obj('WorkerCall', {'grant_ref':ref('WorkerId'),'proposal':ref('WorkerProposal'),'policy_revision':ref('WorkerPositive'),'generation':ref('WorkerPositive'),'cancel_epoch':ref('WorkerCounter'),'fencing_token':ref('WorkerPositive')})
obj('WorkerRequest', {'jsonrpc':{'type':'string','const':'2.0'},'id':ref('WorkerId'),'method':{'type':'string','const':'tool.invoke'},'params':ref('WorkerCall')})
obj('WorkerResult', {'schema_version':v,'call_id':ref('WorkerId'),'grant_ref':ref('WorkerId'),'status':{'type':'string','const':'ok'},'side_effect_state':{'type':'string','const':'none'},'contract_hash':ref('WorkerHash'),'evidence_ref':ref('WorkerId'),'replayed':{'type':'boolean'}})
obj('WorkerReply', {'jsonrpc':{'type':'string','const':'2.0'},'id':ref('WorkerId'),'result':ref('WorkerResult')})
schema = {'$schema':'https://json-schema.org/draft/2020-12/schema','$id':'https://github.com/Daviswhistle/Tada/contracts/worker/v1','$comment':'Offline identifier. Narrow read-only worker admission protocol; policy and grants are trusted-host outputs, never authentic merely because schema-valid. Existing task/control v1 is unchanged.','$defs':D}
(root/'packages/contracts/schema/worker.v1.json').write_text(json.dumps(schema, indent=2)+'\n')

# Both languages read this same committed, explicit-value fixture file.
h = 'a'*64
rule = {'tool':'task.contract_digest','tool_version':1,'resource':'task://task-a/contract','purpose':'verify_input_snapshot','decision':'ALLOW'}
policy = {'schema_version':1,'profile_id':'fixture','revision':1,'origin':'local_policy','denied_tools':[],'rules':[rule],'max_calls':4,'grant_ttl_ms':10000}
proposal = {'schema_version':1,'call_id':'call-a','task_id':'task-a','tool':'task.contract_digest','tool_version':1,'resource':rule['resource'],'purpose':rule['purpose'],'arguments':{'expected_hash':h}}
grant = {'schema_version':1,'grant_id':'grant-a','subject':'worker-a','task_id':'task-a','tool':'task.contract_digest','tool_version':1,'resource':rule['resource'],'purpose':rule['purpose'],'payload_hash':h,'profile_id':'fixture','policy_revision':1,'generation':1,'cancel_epoch':0,'fencing_token':1,'expires_at_ms':1791036000000}
call = {'grant_ref':'grant-a','proposal':proposal,'policy_revision':1,'generation':1,'cancel_epoch':0,'fencing_token':1}
request = {'jsonrpc':'2.0','id':'rpc-a','method':'tool.invoke','params':call}
result = {'schema_version':1,'call_id':'call-a','grant_ref':'grant-a','status':'ok','side_effect_state':'none','contract_hash':h,'evidence_ref':'digest-a','replayed':False}
values = {'WorkerRule':rule,'WorkerPolicy':policy,'WorkerArguments':proposal['arguments'],'WorkerProposal':proposal,'WorkerGrant':grant,'WorkerAuthorization':{'schema_version':1,'decision':'ALLOW','reason':'ALLOWED','grant':grant},'WorkerCall':call,'WorkerRequest':request,'WorkerResult':result,'WorkerReply':{'jsonrpc':'2.0','id':'rpc-a','result':result}}
cases = [{'name':c+'-valid','contract':c,'valid':True,'value':v} for c,v in values.items()]
def case(name,c,path,value=None,remove=False,valid=False):
    v = copy.deepcopy(values[c]); at = v
    for key in path[:-1]: at = at[key]
    if remove: del at[path[-1]]
    else: at[path[-1]] = value
    cases.append({'name':name,'contract':c,'valid':valid,'value':v})
for name,c,path,value in [
('future-worker-version','WorkerProposal',['schema_version'],2),
('model-cannot-issue-policy','WorkerPolicy',['origin'],'model'),
('document-cannot-issue-policy','WorkerPolicy',['origin'],'document'),
('policy-zero-revision','WorkerPolicy',['revision'],0),
('policy-zero-call-budget','WorkerPolicy',['max_calls'],0),
('policy-excessive-call-budget','WorkerPolicy',['max_calls'],65),
('policy-zero-ttl','WorkerPolicy',['grant_ttl_ms'],0),
('policy-excessive-ttl','WorkerPolicy',['grant_ttl_ms'],60001),
('unknown-rule-field','WorkerRule',['self_approved'],True),
('proposal-unknown-argument','WorkerProposal',['arguments','path'],'/secret'),
('proposal-cannot-claim-effect','WorkerProposal',['effect'],'read'),
('proposal-cannot-claim-authority','WorkerProposal',['origin'],'user_request'),
('unsafe-worker-counter','WorkerCall',['generation'],9007199254740992),
('negative-cancel-epoch','WorkerCall',['cancel_epoch'],-1),
('zero-fence','WorkerCall',['fencing_token'],0),
('string-counter','WorkerCall',['fencing_token'],'1'),
('grant-no-secret','WorkerGrant',['token'],'FAKE_SECRET_CANARY'),
('grant-uppercase-hash','WorkerGrant',['payload_hash'],'A'*64),
('deny-cannot-carry-grant','WorkerAuthorization',['decision'],'DENY'),
('invalid-decision','WorkerAuthorization',['decision'],'SAFE'),
('rpc-cannot-set-policy','WorkerRequest',['method'],'policy.set'),
('rpc-cannot-bear-subject','WorkerRequest',['params','subject'],'worker-a'),
('rpc-unknown-root','WorkerRequest',['priority'],'urgent'),
('result-cannot-claim-write','WorkerResult',['side_effect_state'],'confirmed'),
('result-not-task-success','WorkerResult',['task_succeeded'],True),
('integral-float-worker-counter','WorkerCall',['generation'],1.0),
]: case(name,c,path,value,valid=name.startswith('integral-float'))
case('allow-requires-grant','WorkerAuthorization',['grant'],remove=True)
case('rpc-id-required','WorkerRequest',['id'],remove=True)
for decision in ['DENY','REQUIRE_DECISION','HANDOFF']:
    cases.append({'name':decision+'-without-grant','contract':'WorkerAuthorization','valid':True,'value':{'schema_version':1,'decision':decision,'reason':'DECISION_REQUIRED'}})
assert len(cases) == 41
p = root/'fixtures/worker/v1/cases.json'; p.parent.mkdir(parents=True,exist_ok=True)
p.write_text('[\n'+',\n'.join('  '+json.dumps(v,separators=(',',':')) for v in cases)+'\n]\n')
Path(__file__).unlink()
