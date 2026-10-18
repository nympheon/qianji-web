import type { ActorScope } from '../../shared/model';
import { DomainError } from '../../shared/errors';

const encoder = new TextEncoder();
function base64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)); }
function bytes(text: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(text), (char) => char.charCodeAt(0)); }

export class CredentialVault {
  #key: Promise<CryptoKey> | undefined;
  constructor(private readonly secret: string | undefined, private readonly instanceId: string) {}
  private key(): Promise<CryptoKey> {
    return this.#key ??= (async () => {
      if (!this.secret) throw new DomainError('CREDENTIAL_KEY_REQUIRED', '请先配置凭证加密Secret');
      let material: Uint8Array<ArrayBuffer>;
      try { material = bytes(this.secret); if (material.length !== 32) throw new Error(); }
      catch { throw new DomainError('CREDENTIAL_KEY_INVALID', '凭证加密Secret必须是32字节随机值的Base64编码'); }
      const source = await crypto.subtle.importKey('raw', material, 'HKDF', false, ['deriveKey']);
      return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(this.instanceId), info: encoder.encode('qianji-credential-v1') }, source,
        { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    })();
  }
  async ready(): Promise<void> { await this.key(); }
  private aad(scope: ActorScope): Uint8Array<ArrayBuffer> { return encoder.encode(JSON.stringify(['qianji-credential-v1', scope.uid, scope.connectionEpoch])); }
  async encrypt(token: string, scope: ActorScope): Promise<string> {
    const key = await this.key(), iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: this.aad(scope) }, key, encoder.encode(token));
    return `v1.${base64(iv)}.${base64(new Uint8Array(cipher))}`;
  }
  async decrypt(cipher: string, scope: ActorScope): Promise<string> {
    const key = await this.key();
    try {
      const [version, iv, data, extra] = cipher.split('.');
      if (version !== 'v1' || !iv || !data || extra !== undefined || bytes(iv).length !== 12) throw new Error();
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(iv), additionalData: this.aad(scope) }, key, bytes(data));
      return new TextDecoder('utf-8', { fatal: true }).decode(plain);
    } catch { throw new DomainError('CREDENTIAL_DECRYPT_FAILED', '无法解密已存凭证，请恢复原Secret或重新登录'); }
  }
}
