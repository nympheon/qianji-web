export const ROUTES = {
  main: 'https://api.qianjiapp.com',
  backup: 'https://qianji.xxoojoke.com',
  overseas: 'https://qianjiga.litangkj.com',
} as const;
export type RouteId = keyof typeof ROUTES;

export interface ClientProfile {
  packageName: string;
  versionCode: number;
  versionName: string;
  market: string;
  osVersion: string;
  brand: string;
  deviceName: string;
  language: string;
  region: string;
  timezoneOffsetSeconds: string;
}

export const CLIENT_PROFILE: Readonly<ClientProfile> = Object.freeze({
  packageName: 'com.mutangtech.qianji', versionCode: 1234, versionName: '4.5.4',
  market: 'guanwang', osVersion: '35', brand: 'MCP', deviceName: 'Cloudflare Workers',
  language: 'zh', region: 'CN', timezoneOffsetSeconds: '28800',
});
