import type { ImagePurpose } from '../../features/attachments/upload';
import { billImagePlan, commonImagePlan } from '../../features/attachments/preprocess';
export async function prepareImage(file: File, purpose: ImagePurpose, maxBytes: number) {
  if (file.size > 32 * 1024 * 1024) throw new Error('原图片超过32MiB，请裁剪后再上传'); let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { throw new Error('图片无法解码，请选择JPEG、PNG或浏览器支持的图片'); }
  const canvas = document.createElement('canvas');
  try { if (bitmap.width * bitmap.height > 100_000_000) throw new Error('图片像素过大，请裁剪后再上传'); const plan = purpose === 'bill' ? billImagePlan(bitmap.width, bitmap.height) : commonImagePlan(bitmap.width, bitmap.height);
    canvas.width = purpose === 'category' ? Math.min(512, bitmap.width, bitmap.height) : plan.width; canvas.height = purpose === 'category' ? canvas.width : plan.height; if (!canvas.width || !canvas.height) throw new Error('图片过窄，无法按原生规则处理'); const context = canvas.getContext('2d'); if (!context) throw new Error('当前浏览器无法处理图片');
    if (purpose === 'category') { const side = Math.min(bitmap.width, bitmap.height); context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height); }
    else { context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); }
    const mime = purpose === 'category' ? 'image/png' as const : 'image/jpeg' as const, blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('浏览器无法处理此尺寸的图片')), mime, 0.8)); if (blob.size > maxBytes) throw new Error('处理后的图片超过8MiB，请裁剪后再上传'); const bytes = await blob.arrayBuffer(), sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) => value.toString(16).padStart(2, '0')).join(''); return { file: new File([blob], purpose === 'category' ? 'image.png' : 'image.jpg', { type: mime }), sha256, mime, bytesLength: blob.size, fileName: file.name.slice(0, 200) };
  } finally { bitmap.close(); canvas.width = 0; canvas.height = 0; }
}
