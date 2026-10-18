import { expect,it } from 'vitest';
import { sourceCheckCompleted } from '../../src/features/sync/freshness';
it('can reuse a completed source check inside native cooldown without calling it a new job',()=>{
 expect(sourceCheckCompleted({job:null},{complete:true,validatedAt:'2026-10-19T00:00:00Z'},Date.parse('2026-10-19T00:00:04Z'))).toBe(true);
 expect(sourceCheckCompleted({job:null},{complete:true,validatedAt:'2026-10-19T00:00:00Z'},Date.parse('2026-10-19T00:00:06Z'))).toBe(false);
});
it('does not replace an explicit failed or running check with an old or future timestamp',()=>{
 const dataset={complete:true,validatedAt:'2026-10-19T00:00:00Z'},now=Date.parse('2026-10-19T00:00:01Z');
 expect(sourceCheckCompleted({job:{state:'failed'}},dataset,now)).toBe(false);
 expect(sourceCheckCompleted({job:{state:'running'}},dataset,now)).toBe(false);
 expect(sourceCheckCompleted({job:null},{...dataset,complete:false},now)).toBe(false);
 expect(sourceCheckCompleted({job:null},{...dataset,validatedAt:'2026-10-20T00:00:00Z'},now)).toBe(false);
});
