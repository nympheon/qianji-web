import { z } from 'zod';
import type { Freshness } from '../../shared/model';
import type { Problem } from '../../shared/reply';
export const bookIdSchema = z.string().regex(/^(?:-1|[1-9]\d{0,24})$/);
export const bookRangeSchema = z.string().regex(/^(?:|all|y|q|m(?:[1-9]|1\d|2[0-8]))$/);
const version = z.string().length(64);
export const bookListSchema = z.strictObject({ includeHidden: z.boolean().default(false) });
export const bookSubmitSchema = z.discriminatedUnion('mode', [z.strictObject({ mode: z.literal('create'), name: z.string().trim().min(1).max(15), type: z.int(), cover: z.string().max(2048).nullable().optional(), range: bookRangeSchema.optional() }), z.strictObject({ mode: z.literal('edit'), id: bookIdSchema, expectedVersion: version, name: z.string().trim().min(1).max(15).optional(), cover: z.string().max(2048).nullable().optional(), range: bookRangeSchema.optional() }).refine((input) => input.name !== undefined || input.cover !== undefined || input.range !== undefined)]);
export const bookConfigureSchema = z.strictObject({ id: bookIdSchema, expectedVersion: version, range: bookRangeSchema });
export const bookVisibleSchema = z.strictObject({ id: bookIdSchema, visible: z.boolean() });
export const bookDeleteSchema = z.strictObject({ id: bookIdSchema, expectedVersion: version });
export const bookQuitSchema = bookDeleteSchema.extend({ memberId: z.string().min(1).max(100) });
export const bookReorderSchema = z.strictObject({ ids: z.array(bookIdSchema).min(1).max(200) });
export interface BookView { id: string; name: string; type: number; visible: boolean; sort: number; ownerId: string; memberId: string | null; role: 'owner' | 'member' | 'unknown'; defaultBook: boolean; expiredAsOwner: boolean; expiredAsMember: boolean; memberCount: number; range: string; cover: string | null; editVersion: string }
export interface BookListView { items: BookView[]; freshness: Freshness; problem?: Problem }
export interface BookDeleteCheck { ownerHasUnresolved: boolean; memberHasUnresolved: boolean; blocked: boolean }
export interface BookDeleteCheckView extends BookDeleteCheck { id: string; expectedVersion: string; role: BookView['role']; defaultBook: boolean }
export type BookListInput = z.input<typeof bookListSchema>;
export type BookSubmitInput = z.infer<typeof bookSubmitSchema>;
export type BookConfigureInput = z.infer<typeof bookConfigureSchema>;
export type BookVisibleInput = z.infer<typeof bookVisibleSchema>;
export type BookDeleteInput = z.infer<typeof bookDeleteSchema>;
export type BookQuitInput = z.infer<typeof bookQuitSchema>;
export type BookReorderInput = z.infer<typeof bookReorderSchema>;
export const baseCurrencySchema = z.string().regex(/^[A-Z][A-Z0-9_-]{1,19}$/);
export const baseCurrencyInputSchema = z.strictObject({ baseCurrency: baseCurrencySchema, expectedVersion: version });
export type BaseCurrencyInput = z.infer<typeof baseCurrencyInputSchema>;
export interface AccountingConfigView { baseCurrency: string; editVersion: string; freshness: Freshness; source: 'default' | 'qianji' }
export interface BookTypesView { items: { type: number; name: string; cover: string | null; description: string; range: string }[]; freshness: Freshness; problem?: Problem }
export interface BookMembersView { bookId: string; items: { id: string; name: string; avatar: string | null; role: 'owner' | 'member'; vipType: string; vipEndSec: string | null }[]; freshness: Freshness; problem?: Problem }
export const bookWriteSchemas = { 'books.submit': bookSubmitSchema, 'books.configure': bookConfigureSchema, 'books.setVisible': bookVisibleSchema, 'books.delete': bookDeleteSchema, 'books.quit': bookQuitSchema, 'books.reorder': bookReorderSchema, 'books.setBaseCurrency': baseCurrencyInputSchema };
const draft = { kind: z.literal('book'), requestId: z.string().min(1).max(200) };
export const bookDraftSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...draft, action: z.literal('books.submit'), input: z.discriminatedUnion('mode', [bookSubmitSchema.options[0].extend({ name: z.string().max(100) }), bookSubmitSchema.options[1].safeExtend({ name: z.string().max(100).optional() })]) }),
  z.strictObject({ ...draft, action: z.literal('books.configure'), input: bookConfigureSchema }),
  z.strictObject({ ...draft, action: z.literal('books.setVisible'), input: bookVisibleSchema }),
  z.strictObject({ ...draft, action: z.literal('books.delete'), input: bookDeleteSchema }),
  z.strictObject({ ...draft, action: z.literal('books.quit'), input: bookQuitSchema }),
  z.strictObject({ ...draft, action: z.literal('books.reorder'), input: bookReorderSchema }),
  z.strictObject({ ...draft, action: z.literal('books.setBaseCurrency'), input: baseCurrencyInputSchema }),
]);
export type BookDraft = z.infer<typeof bookDraftSchema>;
export interface BookDraftView { draft: BookDraft; operationId: string | null }
