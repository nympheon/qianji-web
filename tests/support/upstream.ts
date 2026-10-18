import { QianjiClient } from '../../src/protocol/client';
import type { ActorScope, Clock } from '../../src/shared/model';

export class TestClock implements Clock {
  constructor(private time = 1792000000123) {}
  nowMs(): number { return this.time; }
  nowIso(): string { return new Date(this.time).toISOString(); }
  advance(ms: number): void { this.time += ms; }
}
export function createUpstream(clock: Clock, scope: ActorScope) {
  const calls: { url: string; body: string }[] = [];
  let responder: () => Promise<Response> = async () => new Response('{"ec":200,"data":{}}');
  const client = new QianjiClient({
    clock, deviceId: () => 'test-device', route: () => 'main', session: async () => ({ scope, utoken: 'TEST_TOKEN_NOT_REAL' }),
    fetch: async (url, init) => {
      calls.push({ url, body: String(init.body) });
      return responder();
    },
  });
  return { client, calls, respond(fn: () => Promise<Response>) { responder = fn; } };
}
