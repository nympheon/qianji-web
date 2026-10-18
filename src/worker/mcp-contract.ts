import type { ActionName } from '../contracts/actions';
/** Web autosave bookkeeping is not a model-facing business workflow. */
export function isMcpAction(action:ActionName){return !action.includes('.draft.');}
export function absoluteMcpLinks(value:unknown,origin:string):unknown{
  if(Array.isArray(value))return value.map(item=>absoluteMcpLinks(item,origin));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,typeof item==='string'&&['url','uploadPage','connectionUrl'].includes(key)&&/^\/(?!\/)/.test(item)?new URL(item,origin).href:absoluteMcpLinks(item,origin)]));
  return value;
}
