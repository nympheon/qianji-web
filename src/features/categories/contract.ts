import { z } from 'zod';
import { bookIdSchema } from '../books/contract';
import type { Freshness } from '../../shared/model';
import type { Problem } from '../../shared/reply';
export const categoryIdSchema = z.string().regex(/^[1-9]\d{0,24}$/);
const version = z.string().length(64), type = z.union([z.literal(0), z.literal(1)]);
export const categoryScopeSchema = z.strictObject({ bookId: bookIdSchema, type });
export const categoryListSchema = categoryScopeSchema;
export const categoryCheckSchema = categoryScopeSchema.extend({ id: categoryIdSchema });
export const categorySubmitSchema = z.discriminatedUnion('mode', [
  categoryScopeSchema.extend({ mode: z.literal('create'), name: z.string().trim().min(1).max(100), icon: z.string().max(2048).optional(), parentId: categoryIdSchema.nullable().default(null) }),
  categoryCheckSchema.extend({ mode: z.literal('edit'), expectedVersion: version, name: z.string().trim().min(1).max(100).optional(), icon: z.string().max(2048).optional() }).refine((input) => input.name !== undefined || input.icon !== undefined),
]);
export const categoryLevelSchema = categoryCheckSchema.extend({ expectedVersion: version, parentId: categoryIdSchema.nullable() });
export const categoryMoveSchema = categoryLevelSchema.extend({ parentId: categoryIdSchema });
export const categoryReorderSchema = categoryScopeSchema.extend({ groups: z.array(z.strictObject({ parentId: categoryIdSchema.nullable(), ids: z.array(categoryIdSchema).min(1).max(2000) })).min(1).max(2000) }).refine((input) => input.groups.reduce((count, group) => count + group.ids.length, 0) <= 2000, '本次排序最多2000项');
export type CategorySubmitInput = z.infer<typeof categorySubmitSchema>;
export type CategoryLevelInput = z.infer<typeof categoryLevelSchema>;
export type CategoryMoveInput = z.infer<typeof categoryMoveSchema>;
export type CategoryReorderInput = z.infer<typeof categoryReorderSchema>;
export const categoryDeleteSchema = categoryCheckSchema.extend({ expectedVersion: version, deleteBills: z.boolean(), newCategoryId: categoryIdSchema.nullable().optional(), newBookId: bookIdSchema.optional() }).refine((input) => (!input.deleteBills || !input.newCategoryId) && (!input.newBookId || !!input.newCategoryId), '删除关联账单与迁移不能同时选择，目标账本需要对应替换分类');
export type DeleteCategoryInput = z.infer<typeof categoryDeleteSchema>;
export type CategoryListInput = z.infer<typeof categoryListSchema>;
export type CategoryCheckInput = z.infer<typeof categoryCheckSchema>;
export interface CategoryView { id: string; bookId: string; type: 0 | 1; name: string; parentId: string | null; level: 1 | 2; sort: number; editable: boolean; icon: string; childIds: string[]; editVersion: string }
export interface CategoryListView { items: CategoryView[]; bookId: string; type: 0 | 1; freshness: Freshness; problem?: Problem }
export interface CategoryDeleteCheckView { id: string; count: number | null; other: number | null; hasChildren: boolean; blocked: boolean; expectedVersion: string }
export const categoryWriteSchemas = { 'categories.submit': categorySubmitSchema, 'categories.changeLevel': categoryLevelSchema, 'categories.move': categoryMoveSchema, 'categories.reorder': categoryReorderSchema, 'categories.delete': categoryDeleteSchema };
const draft = { kind: z.literal('category'), requestId: z.string().min(1).max(200) };
export const categoryDraftSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...draft, action: z.literal('categories.submit'), input: z.discriminatedUnion('mode', [categorySubmitSchema.options[0].extend({ name: z.string().max(100) }), categorySubmitSchema.options[1].safeExtend({ name: z.string().max(100).optional() })]) }),
  z.strictObject({ ...draft, action: z.literal('categories.changeLevel'), input: categoryLevelSchema }),
  z.strictObject({ ...draft, action: z.literal('categories.move'), input: categoryMoveSchema }),
  z.strictObject({ ...draft, action: z.literal('categories.reorder'), input: categoryReorderSchema }),
  z.strictObject({ ...draft, action: z.literal('categories.delete'), input: categoryDeleteSchema }),
]);
export type CategoryDraft = z.infer<typeof categoryDraftSchema>;
export interface CategoryDraftView { draft: CategoryDraft; operationId: string | null }
