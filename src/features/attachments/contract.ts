import { z } from 'zod';
import type { Freshness } from '../../shared/model';
export const imagePurposeSchema = z.enum(['bill', 'cover', 'category']);
export const imageMimeSchema = z.enum(['image/jpeg', 'image/png']);
export const uploadImageSchema = z.strictObject({ purpose: imagePurposeSchema, mime: imageMimeSchema, dataBase64: z.string().max(11184812).optional(), draftKey: z.string().min(1).max(300).optional() });
export type UploadImageInput = z.infer<typeof uploadImageSchema>;
export const uploadIntentSchema = z.strictObject({ purpose: imagePurposeSchema, mime: imageMimeSchema, width: z.int().positive(), height: z.int().positive(), bytesLength: z.int().positive().max(8388608), sha256: z.string().regex(/^[a-f0-9]{64}$/), etag: z.string().regex(/^[\w-]{28}$/), draftKey: z.string().min(1).max(300).optional() });
export type UploadIntent = z.infer<typeof uploadIntentSchema>;
export const uploadedImageSchema = uploadIntentSchema.omit({ draftKey: true }).extend({ key: z.string().min(1).max(200), associationValue: z.string().min(1).max(2048), sourceUrl: z.url(), createdAt: z.string(), proof: z.enum(['qiniu-receipt', 'object-read']) });
export type UploadedImage = z.infer<typeof uploadedImageSchema>;
export const imageReferenceSchema = z.strictObject({ reference: z.string().min(1).max(2048), purpose: imagePurposeSchema.default('bill'), size: z.enum(['small', 'medium', 'original']).default('medium') });
export type ImageReferenceInput = z.input<typeof imageReferenceSchema>;
export interface ImageView { key: string | null; url: string; source: 'qianji-key' | 'external-url'; uploaded: boolean }
export interface AttachmentOptions { maxBillImages: number; maxBytes: number; countSource: 'apk-default' | 'qianji'; uploadPage: string; freshness: Freshness }
export const uploadDraftSchema = z.strictObject({ requestId: z.string().min(1).max(200), purpose: imagePurposeSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/), mime: imageMimeSchema, bytesLength: z.int().positive().max(8388608), fileName: z.string().max(200) });
export type UploadDraft = z.infer<typeof uploadDraftSchema>;
export interface UploadDraftView { draft: UploadDraft; operationId: string | null; appliedKey: string | null }
