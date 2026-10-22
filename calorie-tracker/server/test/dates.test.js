import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addDays, dateRange, isValidDate, localDate } from '../src/dates.js';

describe('dates', () => {
  it('accepts real calendar dates only', () => {
    for (const ok of ['2026-01-01', '2026-12-31', '2024-02-29', '2000-02-29']) assert.equal(isValidDate(ok), true, ok);
    for (const bad of ['2026-02-30', '2026-02-29', '1900-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '2026-1-1', '26-01-01', '2026-01-01T00:00', '', null, 20260101]) {
      assert.equal(isValidDate(bad), false, String(bad));
    }
  });

  it('adds days across month and year boundaries', () => {
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(addDays('2024-03-01', -1), '2024-02-29');
    assert.equal(addDays('2026-01-31', 1), '2026-02-01');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2027-01-01', -1), '2026-12-31');
  });

  it('is not affected by DST changes', () => {
    // US and EU DST transitions in 2026.
    assert.equal(addDays('2026-03-08', 1), '2026-03-09');
    assert.equal(addDays('2026-03-29', 1), '2026-03-30');
    assert.equal(addDays('2026-11-01', 1), '2026-11-02');
  });

  it('builds an inclusive range ending on the given date', () => {
    assert.deepEqual(dateRange('2026-03-02', 4), ['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
    assert.deepEqual(dateRange('2026-03-02', 1), ['2026-03-02']);
  });

  it('formats the local date, not the UTC one', () => {
    assert.equal(localDate(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
    assert.equal(localDate(new Date(2026, 10, 30, 0, 1)), '2026-11-30');
  });
});
