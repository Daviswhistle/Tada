import test from 'node:test';
import assert from 'node:assert/strict';
import { localDay, localHour } from '../src/attention.mjs';
import { followupTimezone } from '../src/followup-contract.mjs';

test('reused timezone formatting tracks each instant, zone, midnight and DST change', () => {
  const instants = [
    '2026-10-10T14:59:59Z', '2026-10-10T15:00:00Z',
    '2026-03-08T06:59:59Z', '2026-03-08T07:00:00Z',
    '2026-11-01T05:59:59Z', '2026-11-01T06:00:00Z',
  ].map(Date.parse);
  for (const zone of ['Asia/Seoul', 'America/New_York', 'UTC']) {
    assert.equal(followupTimezone(zone), zone);
    for (const now of [...instants, ...instants.toReversed()]) {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
      assert.equal(localDay(now, zone), ['year', 'month', 'day'].map(key => parts.find(p => p.type === key).value).join('-'));
      assert.equal(localHour(now, zone), Number(new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', hourCycle: 'h23' }).format(now)));
    }
  }
});

test('timezone churn retains validation and cannot cache an invalid identifier', () => {
  for (const zone of Intl.supportedValuesOf('timeZone').slice(0, 24)) {
    assert.equal(followupTimezone(zone), zone);
    assert.match(localDay(0, zone), /^1969-12-31$|^1970-01-01$/u);
  }
  for (let repeat = 0; repeat < 2; repeat++) {
    for (const value of ['', 'invalid/timezone', 'x'.repeat(101), null, {}, 0]) {
      assert.throws(() => followupTimezone(value), /CONTACT_TIMEZONE_INVALID/u);
    }
    assert.throws(() => localDay(0, 'invalid/timezone'), RangeError);
    assert.equal(followupTimezone('Asia/Seoul'), 'Asia/Seoul');
    assert.equal(localDay(Date.parse('2026-10-10T15:00:00Z'), 'Asia/Seoul'), '2026-10-11');
  }
});
