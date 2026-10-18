import { z } from 'zod';
import type { Freshness } from '../../shared/model';
import type { Problem } from '../../shared/reply';
export const assetIdSchema = z.string().regex(/^[1-9]\d{0,24}$/);
const money = z.string().max(80).regex(/^-?(0|[1-9]\d*)(\.\d{1,10})?$/);
export const differenceSchema = z.strictObject({ categoryId: assetIdSchema, countInStatistics: z.boolean(), countInBudget: z.boolean(), remark: z.string().max(500).optional(), images: z.array(z.string().max(1024)).max(100).optional() });
export const balanceAdjustmentSchema = z.strictObject({ id: assetIdSchema, expectedVersion: z.string().length(64), money, recordDifference: z.boolean(), difference: differenceSchema.optional() }).refine((input) => input.recordDifference === !!input.difference, '记录差额时需要差额资料，不记录时不能附带差额资料');
export type BalanceAdjustmentInput = z.infer<typeof balanceAdjustmentSchema>;
export const debtFinishSchema = z.strictObject({ id: assetIdSchema, finished: z.boolean(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
export type DebtFinishInput = z.infer<typeof debtFinishSchema>;
export interface AssetCurrencySummary { currency: string; assets: string; liabilities: string; borrowed: string; lent: string; net: string; installments: string }
export interface AssetSummary { currencies: AssetCurrencySummary[]; complete: boolean; incompleteReasons: string[] }
export interface AssetView { id: string; name: string; type: number; subtype: number; currency: string; money: string; status: number; visible: boolean; finished: boolean; inCount: boolean; groupId: string | null; remark: string; editVersion: string; knownType: boolean; enteredBalance?: string; installmentMoney?: string;
  credit?: { statementDay: number | null; paymentRule: string | null; limit: string; statementIncludesPrevious: boolean; sharedLimitAssetId: string | null } }
export interface AssetListView { items: AssetView[]; groups: { id: string; name: string; sort: number }[]; summary: AssetSummary; freshness: Freshness; nextCursor: string | null; problem?: Problem }
export const assetListSchema = z.strictObject({ status: z.union([z.literal(0), z.literal(2)]).default(0), includeInstallments: z.boolean().default(true), limit: z.int().min(1).max(200).default(100), cursor: z.string().max(4096).optional() });
export type AssetListInput = z.input<typeof assetListSchema>;
export const assetCreditSchema = z.strictObject({ statementDay: z.int().min(1).max(31).optional(), paymentDay: z.int().min(1).max(31).optional(), limit: money.optional(), statementIncludesPrevious: z.boolean().optional(), sharedLimitAssetId: assetIdSchema.nullable().optional() });
export const assetMetadataSchema = z.strictObject({ name: z.string().min(1).max(100).optional(), remark: z.string().max(500).optional(), inCount: z.boolean().optional(), icon: z.string().max(500).optional(), color: z.string().max(50).optional(), credit: assetCreditSchema.optional() });
export const assetSubmitSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('create'), fields: assetMetadataSchema.required({ name: true, inCount: true }).extend({ type: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]), subtype: z.int().min(1).max(10000), currency: z.string().min(1).max(20), money }) }),
  z.strictObject({ mode: z.literal('edit'), id: assetIdSchema, expectedVersion: z.string().length(64), changes: assetMetadataSchema.refine((fields) => Object.keys(fields).length > 0) }),
]);
export type AssetSubmitInput = z.infer<typeof assetSubmitSchema>;
export const assetVisibleSchema = z.strictObject({ id: assetIdSchema, visible: z.boolean() });
export const assetDeleteSchema = z.strictObject({ id: assetIdSchema, expectedVersion: z.string().length(64) });
export const assetReorderSchema = z.strictObject({ ids: z.array(assetIdSchema).min(1).max(200) });
export const assetTrendSchema = z.strictObject({ id: assetIdSchema, fromSec: z.int().min(0).max(253402300799), toSec: z.int().min(0).max(253402300799) }).refine((input) => input.toSec >= input.fromSec && input.toSec - input.fromSec <= 366 * 86400, '趋势单次查询范围须在一年内');
export type AssetTrendInput = z.infer<typeof assetTrendSchema>;
export interface AssetTypeView { type: number; subtype: number; name: string; group: string; icon: string; color: string }
export interface AssetTypesView { items: AssetTypeView[]; freshness: Freshness; problem?: Problem }
export interface AssetTrendView { id: string; currency: string; points: { id: string; timeSec: number; money: string }[]; freshness: Freshness; problem?: Problem }
const groupId = z.string().min(1).max(200);
export const assetGroupSubmitSchema = z.strictObject({ id: groupId.nullable(), expectedVersion: z.string().length(64).optional(), name: z.string().min(1).max(100) }).refine((input) => !!input.id === !!input.expectedVersion, '编辑分组需要详情版本');
export const assetGroupDeleteSchema = z.strictObject({ id: groupId, expectedVersion: z.string().length(64) });
export const assetGroupReorderSchema = z.strictObject({ ids: z.array(groupId).min(1).max(200) });
export const assetGroupAddSchema = z.strictObject({ groupId, assetIds: z.array(assetIdSchema).min(1).max(20) });
export const assetGroupRemoveSchema = z.strictObject({ groupId, assetId: assetIdSchema });
export interface AssetGroupsView { items: { id: string; name: string; sort: number; editVersion: string }[]; freshness: Freshness; problem?: Problem }
export interface AssetDetailView { asset: AssetView | null; freshness: Freshness; problem?: Problem }
export interface AssetDeleteCheckView { id: string; installCount: number; repeatCount: number; nativeCheckSkipped: boolean; blocked: boolean; deleteBillIds: string[]; detachBillIds: string[]; expectedVersion: string }
export const assetWriteSchemas = {
  'assets.submit': assetSubmitSchema, 'assets.adjustBalance': balanceAdjustmentSchema, 'assets.setFinished': debtFinishSchema, 'assets.setVisible': assetVisibleSchema, 'assets.reorder': assetReorderSchema, 'assets.delete': assetDeleteSchema,
  'assets.groups.submit': assetGroupSubmitSchema, 'assets.groups.delete': assetGroupDeleteSchema, 'assets.groups.reorder': assetGroupReorderSchema, 'assets.groups.add': assetGroupAddSchema, 'assets.groups.remove': assetGroupRemoveSchema,
};
const draftBase = { kind: z.literal('asset'), requestId: z.string().min(1).max(200) }, draftMoney = z.string().max(80);
const metadataDraft = assetMetadataSchema.extend({ name: z.string().max(100).optional(), credit: assetCreditSchema.extend({ limit: draftMoney.optional() }).optional() });
const submitDraft = z.discriminatedUnion('mode', [assetSubmitSchema.options[0].extend({ fields: assetSubmitSchema.options[0].shape.fields.extend({ name: z.string().max(100), money: draftMoney, credit: assetCreditSchema.extend({ limit: draftMoney.optional() }).optional() }) }), assetSubmitSchema.options[1].extend({ changes: metadataDraft })]);
export const assetDraftSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...draftBase, action: z.literal('assets.submit'), input: submitDraft }),
  z.strictObject({ ...draftBase, action: z.literal('assets.adjustBalance'), input: balanceAdjustmentSchema.safeExtend({ money: draftMoney }) }),
  z.strictObject({ ...draftBase, action: z.literal('assets.setFinished'), input: debtFinishSchema }),
  z.strictObject({ ...draftBase, action: z.literal('assets.setVisible'), input: assetVisibleSchema }),
  z.strictObject({ ...draftBase, action: z.literal('assets.reorder'), input: assetReorderSchema.extend({ ids: z.array(assetIdSchema).max(200) }) }),
  z.strictObject({ ...draftBase, action: z.literal('assets.delete'), input: assetDeleteSchema }),
  z.strictObject({ ...draftBase, action: z.literal('assets.groups.submit'), input: assetGroupSubmitSchema.safeExtend({ name: z.string().max(100) }) }),
  z.strictObject({ ...draftBase, action: z.literal('assets.groups.delete'), input: assetGroupDeleteSchema }),
  z.strictObject({ ...draftBase, action: z.literal('assets.groups.reorder'), input: assetGroupReorderSchema.extend({ ids: z.array(groupId).max(200) }) }),
  z.strictObject({ ...draftBase, action: z.literal('assets.groups.add'), input: assetGroupAddSchema.extend({ groupId: z.string().max(200), assetIds: z.array(assetIdSchema).max(20) }) }),
  z.strictObject({ ...draftBase, action: z.literal('assets.groups.remove'), input: assetGroupRemoveSchema }),
]);
export type AssetDraft = z.infer<typeof assetDraftSchema>;
export interface AssetDraftView { draft: AssetDraft; operationId: string | null }
export type AssetVisibleInput = z.infer<typeof assetVisibleSchema>;
export type AssetDeleteInput = z.infer<typeof assetDeleteSchema>;
export type AssetReorderInput = z.infer<typeof assetReorderSchema>;
export type AssetGroupSubmitInput = z.infer<typeof assetGroupSubmitSchema>;
export type AssetGroupDeleteInput = z.infer<typeof assetGroupDeleteSchema>;
export type AssetGroupReorderInput = z.infer<typeof assetGroupReorderSchema>;
export type AssetGroupAddInput = z.infer<typeof assetGroupAddSchema>;
export type AssetGroupRemoveInput = z.infer<typeof assetGroupRemoveSchema>;
export interface AssetSummaryView { summary: AssetSummary; freshness: Freshness; problem?: Problem }
