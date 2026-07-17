/**
 * OAuth / 凭证渠道元数据：左侧分类、登录方式、图标映射
 */

import iconAntigravity from '@/assets/icons/antigravity.svg';
import iconClaude from '@/assets/icons/claude.svg';
import iconCodex from '@/assets/icons/codex.svg';
import iconGemini from '@/assets/icons/gemini.svg';
import iconGrok from '@/assets/icons/grok.svg';
import iconGrokDark from '@/assets/icons/grok-dark.svg';
import iconIflow from '@/assets/icons/iflow.svg';
import iconKimiDark from '@/assets/icons/kimi-dark.svg';
import iconKimiLight from '@/assets/icons/kimi-light.svg';
import iconQwen from '@/assets/icons/qwen.svg';
import iconVertex from '@/assets/icons/vertex.svg';
import { OAUTH_PROVIDER_PRESETS, normalizeProviderKey } from '@/features/authFiles/constants';
import type { BuiltInOAuthProvider } from '@/services/api/oauth';
import type { ProviderBrandLogo } from './brandLogos';

/** 登录 API 使用的 management OAuth provider key（anthropic 而非 claude） */
export type OAuthLoginMode = 'oauth' | 'vertex-import' | 'upload-only';

export interface OAuthChannelDescriptor {
  id: string;
  /** 映射到 oauthApi.startAuth 的 provider id；upload-only / vertex 无此字段 */
  loginProvider?: BuiltInOAuthProvider | string;
  loginMode: OAuthLoginMode;
  supportsCallback?: boolean;
  logo: ProviderBrandLogo;
}

const LOGO = {
  claude: { src: iconClaude } satisfies ProviderBrandLogo,
  codex: { src: iconCodex } satisfies ProviderBrandLogo,
  xai: { src: iconGrok, darkSrc: iconGrokDark, transparent: true } satisfies ProviderBrandLogo,
  antigravity: { src: iconAntigravity } satisfies ProviderBrandLogo,
  kimi: { src: iconKimiDark, darkSrc: iconKimiLight } satisfies ProviderBrandLogo,
  vertex: { src: iconVertex } satisfies ProviderBrandLogo,
  gemini: { src: iconGemini } satisfies ProviderBrandLogo,
  aistudio: { src: iconGemini } satisfies ProviderBrandLogo,
  qwen: { src: iconQwen } satisfies ProviderBrandLogo,
  iflow: { src: iconIflow } satisfies ProviderBrandLogo,
};

/** 内置 OAuth 渠道（固定顺序） */
export const OAUTH_CHANNEL_ORDER: string[] = [
  'claude',
  'codex',
  'xai',
  'antigravity',
  'kimi',
  'vertex',
  'aistudio',
  'gemini',
  'qwen',
  'iflow',
];

export const OAUTH_CHANNEL_DESCRIPTORS: Record<string, OAuthChannelDescriptor> = {
  claude: {
    id: 'claude',
    loginProvider: 'anthropic',
    loginMode: 'oauth',
    supportsCallback: true,
    logo: LOGO.claude,
  },
  codex: {
    id: 'codex',
    loginProvider: 'codex',
    loginMode: 'oauth',
    supportsCallback: true,
    logo: LOGO.codex,
  },
  xai: {
    id: 'xai',
    loginProvider: 'xai',
    loginMode: 'oauth',
    supportsCallback: true,
    logo: LOGO.xai,
  },
  antigravity: {
    id: 'antigravity',
    loginProvider: 'antigravity',
    loginMode: 'oauth',
    supportsCallback: true,
    logo: LOGO.antigravity,
  },
  kimi: {
    id: 'kimi',
    loginProvider: 'kimi',
    loginMode: 'oauth',
    supportsCallback: false,
    logo: LOGO.kimi,
  },
  vertex: {
    id: 'vertex',
    loginMode: 'vertex-import',
    logo: LOGO.vertex,
  },
  aistudio: {
    id: 'aistudio',
    loginMode: 'upload-only',
    logo: LOGO.aistudio,
  },
  gemini: {
    id: 'gemini',
    loginMode: 'upload-only',
    logo: LOGO.gemini,
  },
  qwen: {
    id: 'qwen',
    loginMode: 'upload-only',
    logo: LOGO.qwen,
  },
  iflow: {
    id: 'iflow',
    loginMode: 'upload-only',
    logo: LOGO.iflow,
  },
};

/** auth-file type / provider 字段 → 左侧 OAuth 渠道 id */
export const resolveAuthFileChannel = (file: {
  type?: string;
  provider?: string;
}): string | null => {
  const raw = file.type || file.provider || '';
  const key = normalizeProviderKey(String(raw));
  if (!key || key === 'unknown' || key === 'empty' || key === 'all') return null;
  return key;
};

export const getOAuthChannelDescriptor = (channel: string): OAuthChannelDescriptor => {
  const key = normalizeProviderKey(channel);
  return (
    OAUTH_CHANNEL_DESCRIPTORS[key] ?? {
      id: key,
      loginProvider: key,
      loginMode: 'oauth',
      supportsCallback: true,
      logo: { src: iconClaude },
    }
  );
};

export const getOAuthChannelLogo = (channel: string): ProviderBrandLogo =>
  getOAuthChannelDescriptor(channel).logo;

/** 合并预设渠道 + 当前 auth-files / plugin 动态出现的渠道 */
export const buildOAuthChannelList = (extraChannels: Iterable<string>): string[] => {
  const extras = new Set<string>();
  Array.from(extraChannels).forEach((value) => {
    const key = normalizeProviderKey(value);
    if (!key || key === 'unknown' || key === 'empty' || key === 'all') return;
    extras.add(key);
  });

  const base = OAUTH_CHANNEL_ORDER.length ? OAUTH_CHANNEL_ORDER : [...OAUTH_PROVIDER_PRESETS];
  const baseSet = new Set(base.map((v) => normalizeProviderKey(v)));
  const extraList = Array.from(extras)
    .filter((v) => !baseSet.has(v))
    .sort((a, b) => a.localeCompare(b));
  return [...base, ...extraList];
};

/** 登录 API 的 management provider key（claude 渠道 → anthropic） */
export const channelToLoginProvider = (channel: string): string | null => {
  const desc = getOAuthChannelDescriptor(channel);
  if (desc.loginMode !== 'oauth') return null;
  return desc.loginProvider ?? normalizeProviderKey(channel);
};
