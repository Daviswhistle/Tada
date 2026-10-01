"""One-shot CORE-03 integration: additive contracts, shared fixtures, generation.
Removed after the branch preparation commit; never run in normal PR validation.
"""
from pathlib import Path
import copy
import json

p = Path('crates/store/src/lib.rs')
s = p.read_text()
assert s.count('pub mod mock;') == 1
s = s.replace('pub mod mock;', 'pub mod control;\npub mod mock;')
start = s.index('    pub fn create_task(')
end = s.index('    pub fn start_run(', start)
s = s[:start] + '''    pub fn create_task(&mut self, contract: &TaskContract, budget_micro_usd: i64) -> Result<()> {
        counter(budget_micro_usd)?;
        let contract = tada_contracts::encode(contract).map_err(|_| Error::Invalid("INVALID_CONTRACT"))?;
        self.transact("create_task", |tx| {
            control::create_task_tx(tx, &contract, budget_micro_usd).map(|_| ())
        })
    }

''' + s[end:]
start = s.index('    pub fn cancel(')
end = s.index('    pub fn revoke_mock_grant(', start)
s = s[:start] + '''    pub fn cancel(&mut self, id: &str) -> Result<()> {
        let current = snapshot(&self.conn, id)?;
        if number(&current, "cancel_epoch")? > 0 {
            return Ok(());
        }
        self.transact("cancel", |tx| control::cancel_task_tx(tx, id).map(|_| ()))
    }

''' + s[end:]
p.write_text(s)

p = Path('crates/store/src/control/mod.rs')
s = p.read_text()
assert s.count('Connection, OptionalExtension, Transaction') == 1
s = s.replace('Connection, OptionalExtension, Transaction', 'Connection, Transaction')
old = '        let parameters = &value["params"];'
new = '''        // JSON Schema considers 1 and 1.0 equal integers. Normalize only through
        // validated generated types, never by coercing strings or dropping fields.
        let typed = tada_contracts::decode::<tada_contracts::ControlRequest>(&value)
            .map_err(|_| Error::Invalid("CONTROL_TYPED_DECODE_FAILED"))?;
        let normalized = tada_contracts::encode(&typed)
            .map_err(|_| Error::Invalid("CONTROL_TYPED_ENCODE_FAILED"))?;
        let parameters = &normalized["params"];'''
assert s.count(old) == 1
p.write_text(s.replace(old,new))

p = Path('crates/store/Cargo.toml')
s = p.read_text()
assert 'hmac =' not in s and 'getrandom =' not in s
p.write_text(s + '\nhmac = "=0.12.1"\ngetrandom = "=0.3.4"\n')

p = Path('packages/contracts/schema/v1.json')
schema = json.loads(p.read_text())
defs = schema['$defs']
original = copy.deepcopy(defs)
def ref(name): return {'$ref': '#/$defs/' + name}
def obj(properties, required):
    return {'type':'object','additionalProperties':False,'properties':properties,'required':required}
submit = obj({'request_id':ref('Identifier'),'contract':ref('TaskContract'),'budget_micro_usd':ref('Counter')}, ['request_id','contract','budget_micro_usd'])
cancel = obj({'request_id':ref('Identifier'),'task_id':ref('Identifier')}, ['request_id','task_id'])
get = obj({'task_id':ref('Identifier')}, ['task_id'])
events = obj({'task_id':ref('Identifier'),'after_seq':ref('Counter'),'limit':{'type':'integer','minimum':1,'maximum':64}}, ['task_id','after_seq','limit'])
params = obj({**submit['properties'],**cancel['properties'],**events['properties']}, [])
request = obj({'jsonrpc':{'type':'string','const':'2.0'},'id':ref('Identifier'),'method':{'type':'string','enum':['task.submit','task.cancel','task.get','task.events']},'params':ref('ControlParams')}, ['jsonrpc','id','method','params'])
request['allOf'] = [{'if':{'properties':{'method':{'const':method}},'required':['method']},'then':{'properties':{'params':ref(name)}}} for method,name in [('task.submit','ControlSubmitParams'),('task.cancel','ControlCancelParams'),('task.get','ControlGetParams'),('task.events','ControlEventsParams')]]
new = {'ControlSubmitParams':submit,'ControlCancelParams':cancel,'ControlGetParams':get,'ControlEventsParams':events,'ControlParams':params,'ControlRequest':request}
assert not set(new) & set(defs)
defs.update(new)
assert all(defs[k] == v for k,v in original.items())
p.write_text(json.dumps(schema,indent=2,ensure_ascii=False)+'\n')

p = Path('fixtures/contracts/v1/cases.json')
cases = json.loads(p.read_text())
contract = copy.deepcopy(next(c['instance'] for c in cases if c['name']=='task-valid'))
base = {'jsonrpc':'2.0','id':'wire-a','method':'task.submit','params':{'request_id':'submit-a','contract':contract,'budget_micro_usd':100}}
added = []
def case(name, value, valid):
    added.append({'name':'control-'+name,'contract':'ControlRequest','valid':valid,'instance':copy.deepcopy(value)})
def variant(name, mutate, valid=False, source=None):
    value = copy.deepcopy(base if source is None else source)
    mutate(value)
    case(name,value,valid)
case('submit-valid',base,True)
cancel_req = {'jsonrpc':'2.0','id':'wire-b','method':'task.cancel','params':{'request_id':'cancel-a','task_id':'task-a'}}
get_req = {'jsonrpc':'2.0','id':'wire-c','method':'task.get','params':{'task_id':'task-a'}}
events_req = {'jsonrpc':'2.0','id':'wire-d','method':'task.events','params':{'task_id':'task-a','after_seq':0,'limit':64}}
case('cancel-valid',cancel_req,True)
case('get-valid',get_req,True)
case('events-valid',events_req,True)
variant('integral-float',lambda v:v['params'].update(budget_micro_usd=100.0),True)
variant('future-rpc-version',lambda v:v.update(jsonrpc='3.0'))
variant('missing-transport-id',lambda v:v.pop('id'))
variant('null-transport-id',lambda v:v.update(id=None))
variant('numeric-transport-id',lambda v:v.update(id=1))
variant('unknown-root-field',lambda v:v.update(role='controller'))
variant('unknown-method',lambda v:v.update(method='policy.set'))
variant('missing-request-id',lambda v:v['params'].pop('request_id'))
variant('unknown-params-field',lambda v:v['params'].update(approval='DO_NOT_LOG_THIS_SECRET'))
variant('negative-budget',lambda v:v['params'].update(budget_micro_usd=-1))
variant('unsafe-budget',lambda v:v['params'].update(budget_micro_usd=9007199254740992))
variant('string-budget',lambda v:v['params'].update(budget_micro_usd='100'))
variant('contract-unknown-field',lambda v:v['params']['contract'].update(authority='document'))
variant('cancel-cross-method-params',lambda v:v['params'].update(contract=contract),source=cancel_req)
variant('get-cannot-carry-mutation-id',lambda v:v['params'].update(request_id='mutate'),source=get_req)
variant('negative-event-cursor',lambda v:v['params'].update(after_seq=-1),source=events_req)
variant('event-limit-zero',lambda v:v['params'].update(limit=0),source=events_req)
variant('event-limit-excessive',lambda v:v['params'].update(limit=65),source=events_req)
variant('params-null',lambda v:v.update(params=None))
case('batch-not-supported',[base],False)
assert len(added) == 24
assert len({c['name'] for c in cases+added}) == len(cases+added)
p.write_text(json.dumps(cases+added,indent=2,ensure_ascii=False)+'\n')

p = Path('crates/contracts/tests/conformance.rs')
s = p.read_text()
old = '        "TaskContract" => encode(&decode::<TaskContract>(value).unwrap()).unwrap(),'
assert s.count(old) == 1
s = s.replace(old,old+'\n        "ControlRequest" => encode(&decode::<ControlRequest>(value).unwrap()).unwrap(),')
p.write_text(s)

p = Path('crates/store/src/control/tests.rs')
s = p.read_text() + '''
#[test]
fn integral_float_counters_share_the_same_request_identity() {
    let temp = Temp::new();
    let mut store = Store::open(&temp.0).unwrap();
    let key = credential();
    let mut sessions = pair(&store, &key);
    let first = call(&mut store, &mut sessions, &submit());
    let mut alternate = submit();
    alternate["params"]["budget_micro_usd"] = json!(100.0);
    alternate["params"]["contract"]["contract_version"] = json!(1.0);
    assert_eq!(call(&mut store, &mut sessions, &alternate), first);
    assert_eq!(count(&store, "control.completed"), 1);
}
'''
p.write_text(s)
Path(__file__).unlink()
