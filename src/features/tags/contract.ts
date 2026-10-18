import { z } from 'zod';
import type { Freshness } from '../../shared/model';
import type { Problem } from '../../shared/reply';
export const tagIdSchema = z.string().min(1).max(200), tagColorSchema = z.string().regex(/^(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);
const version = z.string().length(64), tagFields = { name: z.string().trim().min(1).max(100), groupId: tagIdSchema.nullable(), color: tagColorSchema.nullable() };
export const tagListSchema = z.strictObject({ includeArchived: z.boolean().default(false), groupId: tagIdSchema.nullable().optional() });
export const tagSubmitSchema = z.discriminatedUnion('mode', [z.strictObject({ mode: z.literal('create'), ...tagFields }), z.strictObject({ mode: z.literal('edit'), id: tagIdSchema, expectedVersion: version, ...tagFields })]);
export const tagGroupSubmitSchema = z.discriminatedUnion('mode', [z.strictObject({ mode: z.literal('create'), name: z.string().trim().min(1).max(10) }), z.strictObject({ mode: z.literal('edit'), id: tagIdSchema, expectedVersion: version, name: z.string().trim().min(1).max(10) })]);
export const tagOrderSchema = z.strictObject({ ids: z.array(tagIdSchema).min(1).max(2000) }).refine((input) => new Set(input.ids).size === input.ids.length, '排序ID不可重复');
export const tagArchiveSchema = z.strictObject({ id: tagIdSchema, archived: z.boolean() });
export const tagDeleteSchema = z.strictObject({ id: tagIdSchema, expectedVersion: version });
export const tagWriteSchemas = { 'tags.submitTag': tagSubmitSchema, 'tags.submitGroup': tagGroupSubmitSchema, 'tags.reorderTags': tagOrderSchema, 'tags.reorderGroups': tagOrderSchema, 'tags.setArchived': tagArchiveSchema, 'tags.deleteTag': tagDeleteSchema, 'tags.deleteGroup': tagDeleteSchema };
export type TagListInput = z.input<typeof tagListSchema>;
export interface TagView { id: string; name: string; groupId: string | null; color: string | null; archived: boolean; sort: number; editVersion: string }
export interface TagGroupView { id: string; name: string; sort: number; editVersion: string }
export interface TagListView { items: TagView[]; groups: TagGroupView[]; freshness: Freshness; problem?: Problem }
const draft = { kind: z.literal('tag'), requestId: z.string().min(1).max(200) };
export const tagDraftSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...draft, action: z.literal('tags.submitTag'), input: z.discriminatedUnion('mode', [tagSubmitSchema.options[0].extend({ name: z.string().max(100) }), tagSubmitSchema.options[1].extend({ name: z.string().max(100) })]) }),
  z.strictObject({ ...draft, action: z.literal('tags.submitGroup'), input: z.discriminatedUnion('mode', [tagGroupSubmitSchema.options[0].extend({ name: z.string().max(10) }), tagGroupSubmitSchema.options[1].extend({ name: z.string().max(10) })]) }),
  z.strictObject({ ...draft, action: z.literal('tags.reorderTags'), input: tagOrderSchema }), z.strictObject({ ...draft, action: z.literal('tags.reorderGroups'), input: tagOrderSchema }),
  z.strictObject({ ...draft, action: z.literal('tags.setArchived'), input: tagArchiveSchema }), z.strictObject({ ...draft, action: z.literal('tags.deleteTag'), input: tagDeleteSchema }), z.strictObject({ ...draft, action: z.literal('tags.deleteGroup'), input: tagDeleteSchema }),
]);
export type TagDraft = z.infer<typeof tagDraftSchema>;
export interface TagDraftView { draft: TagDraft; operationId: string | null }
