import { DomainError } from '../../shared/errors';
import type { UploadImageInput } from './contract';
import { MAX_IMAGE_BYTES, qiniuEtag } from './upload';
import { billImagePlan } from './preprocess';
export function imageDimensions(bytes: Uint8Array): { width: number; height: number; mime: 'image/jpeg' | 'image/png' } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 33 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && view.getUint32(12) === 0x49484452) { const width = view.getUint32(16), height = view.getUint32(20); if (width && height) return { width, height, mime: 'image/png' }; }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217) {
    let offset = 2; while (offset + 4 <= bytes.length) { if (bytes[offset] !== 255) break; while (bytes[offset] === 255) offset++; const marker = bytes[offset++]!; if (marker === 0xda || marker === 0xd9) break; if (marker === 1 || marker >= 0xd0 && marker <= 0xd7) continue; if (offset + 2 > bytes.length) break; const length = view.getUint16(offset); if (length < 2 || offset + length > bytes.length) break; if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) { const height = view.getUint16(offset + 3), width = view.getUint16(offset + 5); if (width && height) return { width, height, mime: 'image/jpeg' }; } offset += length; }
  }
  throw new DomainError('IMAGE_FORMAT_INVALID', '图片字节不是可识别的JPEG或PNG');
}
export async function decodeUpload(input: UploadImageInput) {
  if (!input.dataBase64) throw new DomainError('IMAGE_BYTES_REQUIRED', '未提供图片字节，请前往网页/attachments选择图片；普通URL不能作为上传成功证明');
  let bytes: Uint8Array; try { if (input.dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.dataBase64)) throw new Error(); const text = atob(input.dataBase64); if (!text.length || text.length > MAX_IMAGE_BYTES) throw new Error(); bytes = Uint8Array.from(text, (character) => character.charCodeAt(0)); } catch { throw new DomainError('IMAGE_BYTES_INVALID', '请提供8MiB以内图片的标准base64字节'); }
  const dimensions = imageDimensions(bytes); if (dimensions.mime !== input.mime || input.purpose === 'category' && input.mime !== 'image/png' || input.purpose !== 'category' && input.mime !== 'image/jpeg') throw new DomainError('IMAGE_PREPROCESS_REQUIRED', '请前往网页/attachments完成图片预处理；账单和封面使用JPEG，分类图标使用PNG');
  const plan = billImagePlan(dimensions.width, dimensions.height); if (input.purpose !== 'category' && (!plan.huge || input.purpose !== 'bill') && (Math.max(dimensions.width, dimensions.height) > 3200 || plan.width !== dimensions.width || plan.height !== dimensions.height)) throw new DomainError('IMAGE_PREPROCESS_REQUIRED', '图片尺寸尚未按原生规则处理，请前往网页/attachments选择图片');
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))), (value) => value.toString(16).padStart(2, '0')).join(''), etag = await qiniuEtag(bytes); return { bytes, intent: { purpose: input.purpose, ...dimensions, bytesLength: bytes.length, sha256, etag } };
}
