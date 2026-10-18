import {expect,it,vi} from 'vitest';
import {exports} from 'cloudflare:workers';
import {maintenanceCommandSchema} from '../../src/actor/maintenance-command';
import bridge from '../../tools/ops/worker.mts';
it('does not expose maintenance as a public HTTP action or arbitrary SQL command',async()=>{
 const response=await exports.default.fetch('https://test/api/actions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'maintenance.restore',input:{sql:'DO_NOT_ECHO'}})});expect(await response.json()).toMatchObject({error:{code:'ACTION_NOT_FOUND'}});
 expect(maintenanceCommandSchema.safeParse({action:'status',sql:'DELETE FROM operations'}).success).toBe(false);expect(maintenanceCommandSchema.safeParse({action:'restore',bookmark:'b',restoreId:'new-run-001',sql:'arbitrary'}).success).toBe(false);
});
it('keeps the temporary remote-dev bridge closed without its per-run credential',async()=>{
 const operate=vi.fn(async()=>({phase:'paused'})),target={getByName:()=>({operate})} as unknown as DurableObjectNamespace,config={OPS_BRIDGE_KEY:'private-run-key',OPS_BRIDGE_ID:'run-id',TARGET:target};
 expect((await bridge.fetch(new Request('https://bridge/__ops',{method:'POST',body:'{"action":"status"}'}),config)).status).toBe(404);expect(operate).not.toHaveBeenCalled();
 const result=await bridge.fetch(new Request('https://bridge/__ops',{method:'POST',headers:{Authorization:'Bearer private-run-key'},body:'{"action":"status"}'}),config);expect(await result.json()).toEqual({phase:'paused'});expect(operate).toHaveBeenCalledTimes(1);
});
