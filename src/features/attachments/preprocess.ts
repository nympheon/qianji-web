import { DomainError } from '../../shared/errors';
export interface BillImagePlan { width: number; height: number; huge: boolean; quality: 0.8; mime: 'image/jpeg' }
/** APK fl/d + dl/n; long-side priority is intentional, not a fit-inside rectangle. */
export function billImagePlan(width: number, height: number): BillImagePlan {
  if (![width, height].every((value) => Number.isSafeInteger(value) && value > 0)) throw new DomainError('IMAGE_DIMENSIONS_INVALID', '图片尺寸无法识别');
  const f32 = Math.fround, longer = Math.max(width, height), shorter = Math.min(width, height), huge = longer > 30000 || longer > 8000 && f32(f32(longer) / f32(shorter)) >= 3;
  const scale = huge ? 1 : longer >= 3200 ? f32(f32(longer) / 3200) : shorter > 1920 ? f32(f32(shorter) / 1920) : 1;
  return { width: huge ? width : Math.trunc(f32(f32(width) / scale)), height: huge ? height : Math.trunc(f32(f32(height) / scale)), huge, quality: 0.8, mime: 'image/jpeg' };
}
export function commonImagePlan(width: number, height: number): BillImagePlan { const value = billImagePlan(width, height), f32 = Math.fround, longer = Math.max(width, height), shorter = Math.min(width, height), scale = longer >= 3200 ? f32(f32(longer) / 3200) : shorter > 1920 ? f32(f32(shorter) / 1920) : 1; return { ...value, huge: false, width: Math.trunc(f32(f32(width) / scale)), height: Math.trunc(f32(f32(height) / scale)) }; }
