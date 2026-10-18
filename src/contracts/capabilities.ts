export interface CapabilityView {
  action: string; kind: 'read' | 'connection' | 'sync' | 'reconciliation' | 'write';
  evidence: 'local' | 'apk-static' | 'native-vector' | 'live-verified';
  enabled: boolean; reason: string | null;
}
