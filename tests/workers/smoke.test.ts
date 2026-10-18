import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('Worker boundary', () => {
  it('reports liveness without claiming an upstream connection', async () => {
    const response = await exports.default.fetch('https://test/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', service: 'qianji' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('persists the personal object identity in SQLite', async () => {
    const first = env.QIANJI_STATE.getByName('personal');
    const id = await first.ping();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const stored = await runInDurableObject(first, (_instance, state) =>
      state.storage.sql.exec<{ value: string }>(
        'SELECT value FROM instance_meta WHERE key = ?', 'instance_id',
      ).one().value,
    );
    expect(stored).toBe(id);
    expect(await env.QIANJI_STATE.getByName('personal').ping()).toBe(id);
  });

  it('keeps unknown API paths out of the page fallback', async () => {
    const response = await exports.default.fetch('https://test/api/unknown');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: 'NOT_FOUND' } });
  });
});
