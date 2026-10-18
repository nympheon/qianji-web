import { expect, it } from 'vitest';
import vectors from '../../fixtures/apk-454/installment-vectors.json';
import { installmentParts, installmentInitialCount, previewInstallment } from '../../src/features/installments/preview';
import type { RemainderMode } from '../../src/features/installments/contract';
const fields = { totalMoney: '100', totalFee: '3', totalCount: 3, firstDate: '2026-01-31', time: '00:00', remainder: 'first' as const, feePlacement: 'ave' as const };
it('matches60 independent Java BigDecimal distribution vectors, including exact-cent and rounded negative residual branches', () => {
  for (const vector of vectors.distribution) expect(installmentParts(vector.total, vector.count, vector.mode as RemainderMode)).toEqual({ average: vector.average, residual: vector.residual });
});
it('matches the native Calendar initial count rather than fixing0 or using a simple month difference', () => {
  for (const vector of vectors.counts) expect(installmentInitialCount(vector.first, vector.today, vector.totalCount)).toBe(vector.count);
});
it('preserves native lenient month-end preview dates instead of clamping to each month end', () => {
  const preview = previewInstallment({ ...fields, totalCount: 6, totalFee: '0', limit: 6 }, '2026-01-01'); expect(preview.rows.map((row) => row.date)).toEqual(vectors.dates.items); expect(preview.rows.every((row) => !('id' in row))).toBe(true);
});
it('places both principal residuals and average fees at the selected first/last period', () => {
  expect(previewInstallment({ ...fields, totalFee: '1', remainder: 'first' }, '2026-01-01').rows.map((row) => [row.principal, row.fee])).toEqual([['33.34', '0.34'], ['33.33', '0.33'], ['33.33', '0.33']]);
  expect(previewInstallment({ ...fields, totalFee: '1', remainder: 'rnd', feePlacement: 'last' }, '2026-01-01').rows.map((row) => [row.principal, row.fee])).toEqual([['33.33', '0'], ['33.33', '0'], ['33.34', '1']]);
});
it('marks truncated previews and negative native remainders explicitly without altering total principal or fees', () => {
  const preview = previewInstallment({ ...fields, totalMoney: '1', totalFee: '0', totalCount: 40, remainder: 'rnd', limit: 40 }, '2026-01-01'); expect(preview.rows.at(-1)?.principal).toBe('-0.17'); expect(preview.warnings).toContain('NEGATIVE_NATIVE_REMAINDER');
  const limited = previewInstallment({ ...fields, totalCount: 121, limit: 120 }, '2026-01-01'); expect(limited.complete).toBe(false); expect(limited.rows).toHaveLength(120);
});
