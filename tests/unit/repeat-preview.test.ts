import { expect, it } from 'vitest';
import { previewRepeat, repeatAmounts } from '../../src/features/repeat/preview';
import { repeatSubmitSchema, repeatDraftSchema } from '../../src/features/repeat/contract';
const fields = { type: 0 as const, bookId: '1', categoryId: '2', enteredMoney: '100', fee: '0', startDate: '2026-01-31', time: '08:30', repeat: { type: 'month' as const, values: ['32'] } };
const dates = (value: ReturnType<typeof previewRepeat>) => value.map((row) => row.date);
it('keeps early Gregorian years instead of applying JavaScript Date.UTC1900 offsets', () => {
  expect(dates(previewRepeat({ fields: { ...fields, startDate: '0099-12-31', repeat: { type: 'month', values: ['32'] } }, limit: 2 }))).toEqual(['0099-12-31', '0100-01-31']);
});
it('keeps an unselected bill in a draft and normalizes same-currency transfer fees before saving a task', () => {
  expect(repeatDraftSchema.safeParse({ action: 'repeat.setBillBinding', requestId: 'select-existing', input: { planId: '1', packId: '2', billId: '', bound: true } }).success).toBe(true);
  expect(repeatAmounts({ type: 2, enteredMoney: '103', fee: '3', currency: { srcSymbol: 'CNY', srcValue: '103', targetSymbol: 'CNY', targetValue: '103', baseSymbol: 'CNY', baseValue: '103' } })).toMatchObject({ currency: { targetValue: '100' } });
});
it('retains incomplete form text in a draft without making it a valid submitted rule', () => {
  const draft = { action: 'repeat.submit', requestId: 'typing', input: { mode: 'create', fields: { ...fields, enteredMoney: '', repeat: { type: 'year', values: ['3-'] } } } }; expect(repeatDraftSchema.safeParse(draft).success).toBe(true); expect(repeatSubmitSchema.safeParse(draft.input).success).toBe(false);
});
it('keeps partial edits partial so a remark edit never clears financial references or rules', () => {
  expect(repeatSubmitSchema.parse({ mode: 'edit', id: '100', expectedVersion: 'a'.repeat(64), changes: { remark: 'updated' } })).toMatchObject({ changes: { remark: 'updated' } });
  const value = repeatSubmitSchema.parse({ mode: 'edit', id: '100', expectedVersion: 'a'.repeat(64), changes: { remark: 'updated' } }); if (value.mode === 'edit') expect(Object.keys(value.changes)).toEqual(['remark']);
});
it('maps month-end32, 291 and301 including February and skips impossible ordinary31', () => {
  expect(dates(previewRepeat({ fields, limit: 3 }))).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
  for (const [value, last] of [['291', '2026-03-29'], ['301', '2026-03-30']]) expect(dates(previewRepeat({ fields: { ...fields, repeat: { type: 'month', values: [value!] } }, limit: 3 }))).toEqual(['2026-02-28', last, value === '291' ? '2026-04-29' : '2026-04-30']);
  expect(dates(previewRepeat({ fields: { ...fields, repeat: { type: 'month', values: ['31'] } }, limit: 3 }))).toEqual(['2026-01-31', '2026-03-31', '2026-05-31']);
});
it('includes the start for daily/step rules but follows native strict-next weekday rules', () => {
  expect(dates(previewRepeat({ fields: { ...fields, startDate: '2026-01-02', repeat: { type: 'bystep', values: ['3'] }, end: { kind: 'count', count: 2 } }, limit: 10 }))).toEqual(['2026-01-02', '2026-01-05']);
  expect(dates(previewRepeat({ fields: { ...fields, startDate: '2026-01-02', repeat: { type: 'week', values: ['1', '5'] } }, limit: 2 }))).toEqual(['2026-01-05', '2026-01-09']);
});
it('excludes the end date and creates no persisted Bill ID', () => {
  const preview = previewRepeat({ fields: { ...fields, startDate: '2026-01-01', repeat: { type: 'day', values: [] }, end: { kind: 'date', date: '2026-01-03' } }, limit: 10 });
  expect(dates(preview)).toEqual(['2026-01-01', '2026-01-02']); expect(preview[0]).toMatchObject({ money: '100', fee: '0', timeSec: 1767227400 }); expect(preview[0]).not.toHaveProperty('id');
});
it('uses official holiday overrides including weekend work and refuses missing year maps', () => {
  const input = { fields: { ...fields, startDate: '2026-01-02', repeat: { type: 'workday' as const, values: [] } }, limit: 2 };
  expect(() => previewRepeat(input)).toThrowError(expect.objectContaining({ code: 'HOLIDAYS_MISSING' }));
  expect(dates(previewRepeat(input, { '2026': { '2026-01-03': { holiday: false } } }))).toEqual(['2026-01-03', '2026-01-05']);
});
it('keeps annual month/day pairs together rather than synthesizing an unselected date', () => {
  expect(dates(previewRepeat({ fields: { ...fields, startDate: '2026-01-01', repeat: { type: 'year', values: ['3-30', '4-1'] } }, limit: 3 }))).toEqual(['2026-03-30', '2026-04-01', '2027-03-30']);
});
it('uses exact principal/fee amounts and refuses nonexistent or ambiguous local times', () => {
  expect(previewRepeat({ fields: { ...fields, type: 2, fromAssetId: '10', targetAssetId: '20', enteredMoney: '103', fee: '3' }, limit: 1 })[0]).toMatchObject({ money: '100', fee: '3' });
  const daily = { ...fields, repeat: { type: 'day' as const, values: [] } };
  expect(() => previewRepeat({ fields: { ...daily, startDate: '2026-03-08', time: '02:30' }, zone: 'America/New_York', limit: 1 })).toThrowError(expect.objectContaining({ code: 'LOCAL_TIME_UNAVAILABLE' }));
  expect(() => previewRepeat({ fields: { ...daily, startDate: '2026-11-01', time: '01:30' }, zone: 'America/New_York', limit: 1 })).toThrowError(expect.objectContaining({ code: 'LOCAL_TIME_AMBIGUOUS' }));
});
