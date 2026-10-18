export class DomainError extends Error {
  constructor(readonly code: string, readonly detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'DomainError';
  }
}
