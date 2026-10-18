import { z } from 'zod';
import type { Freshness } from '../../shared/model';
import type { Problem } from '../../shared/reply';
import { categoryScopeSchema,categoryIdSchema } from './contract';
export const categoryBatchSchema=categoryScopeSchema.extend({parentId:categoryIdSchema.nullable().default(null),items:z.array(z.strictObject({name:z.string().trim().min(1).max(100),icon:z.string().min(1).max(2048)})).min(1).max(200)}).refine(value=>new Set(value.items.map(item=>JSON.stringify([item.name,item.icon]))).size===value.items.length,'批量分类不能含重复名称与图标组合');
export const categoryBatchDraftSchema=z.strictObject({requestId:z.string().min(1).max(200),input:categoryBatchSchema.safeExtend({items:z.array(z.strictObject({name:z.string().max(100),icon:z.string().min(1).max(2048)})).max(200)})});
export type CategoryBatchDraft=z.infer<typeof categoryBatchDraftSchema>;
export interface CategoryBatchDraftView {draft:CategoryBatchDraft;operationId:string|null}
export interface CategoryIconView {icon:string;name:string;group:string}
export interface CategoryIconListView {items:CategoryIconView[];freshness:Freshness;problem?:Problem}
