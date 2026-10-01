"""One-shot CORE-02 API-boundary correction; removed after formatting."""
from pathlib import Path
import re
for name in ('lib.rs', 'mock.rs', 'tests.rs'):
    p = Path('crates/store/src') / name
    s = p.read_text()
    assert 'u64' in s
    s = re.sub(r'\bu64\b', 'i64', s)
    if name == 'lib.rs':
        assert s.count('SafeInteger::new(value)') == 1
        s = s.replace('SafeInteger::new(value)', 'u64::try_from(value).ok().and_then(SafeInteger::new)')
        old = 'value[key].as_u64().ok_or(Error::RecoveryRequired)'
        assert s.count(old) == 1
        s = s.replace(old, 'counter(value[key].as_i64().ok_or(Error::RecoveryRequired)?).map_err(|_| Error::RecoveryRequired)')
        assert s.count('rusqlite::DatabaseName::Main') == 1
        s = s.replace('rusqlite::DatabaseName::Main', '"main"')
        old = 'fn settle(tx: &Transaction<\'_>, id: &str, charged: i64) -> Result<()> {'
        assert s.count(old) == 1
        s = s.replace(old, old + '\n    counter(charged)?;')
    if name == 'tests.rs':
        s = s.replace('SafeInteger::MAX', 'i64::try_from(SafeInteger::MAX).unwrap()')
        s += '''
#[test]
fn negative_budget_and_reservation_cannot_create_credit() {
    let temp = Temp::new();
    let (mut store, mut service, lease) = setup(&temp.0);
    let before = witness_tip(&store);
    assert!(store.create_task(&contract("negative-cap"), -1).is_err());
    assert!(store.dispatch_mock("action-a", &lease, &mut service, MockMode::Normal, -1).is_err());
    assert_eq!(witness_tip(&store), before);
    assert_eq!(attempts(&store), 0);
    assert_eq!(service.effect_count().unwrap(), 0);
}
'''
    p.write_text(s)
Path(__file__).unlink()
