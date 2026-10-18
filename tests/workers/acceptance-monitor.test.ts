import {expect,it} from 'vitest';
import {createTestApp} from '../support/app';
import {AcceptanceMonitor} from '../../tools/acceptance/monitor.mts';

it('retains every upstream attempt across idle eviction and actor recreation',async()=>{
 const app=await createTestApp();let firstId='';
 await app.repository(repository=>{const monitor=new AcceptanceMonitor(repository);firstId=monitor.snapshot().monitorId;monitor.attempt('2026-10-19T00:00:00.000Z');expect(monitor.snapshot().networkRequests).toBe(1);});
 await app.restart();await app.repository(repository=>{const monitor=new AcceptanceMonitor(repository);expect(monitor.snapshot()).toEqual({monitorId:firstId,networkRequests:1,lastNetworkAt:'2026-10-19T00:00:00.000Z'});monitor.attempt('2026-10-19T00:01:00.000Z');expect(monitor.snapshot().networkRequests).toBe(2);});
});
