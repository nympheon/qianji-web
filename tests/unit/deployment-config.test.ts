import {expect,it} from 'vitest';
import configText from '../../wrangler.jsonc?raw';
it('isolates preview and production Durable Object namespaces without binding preview to the production script',()=>{
 const config=JSON.parse(configText) as {name:string;env?:{preview?:{name:string;durable_objects:{bindings:{name:string;class_name:string;script_name?:string}[]}}};durable_objects:{bindings:{name:string;class_name:string}[]}};const preview=config.env?.preview;expect(preview?.name).toBe('qianji-personal-preview');expect(preview?.name).not.toBe(config.name);expect(preview?.durable_objects.bindings).toEqual(config.durable_objects.bindings);expect(preview?.durable_objects.bindings.every(binding=>!binding.script_name)).toBe(true);
});
