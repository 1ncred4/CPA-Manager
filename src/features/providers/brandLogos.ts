import claudeLogo from '@/assets/icons/claude.svg';
import codexLogo from '@/assets/icons/codex.svg';
import geminiLogo from '@/assets/icons/gemini.svg';
import openaiLightLogo from '@/assets/icons/openai-light.svg';
import openaiDarkLogo from '@/assets/icons/openai-dark.svg';
import vertexLogo from '@/assets/icons/vertex.svg';
import xaiLightLogo from '@/assets/icons/grok.svg';
import xaiDarkLogo from '@/assets/icons/grok-dark.svg';
import type { ProviderBrand } from './types';

export interface ProviderBrandLogo {
  src: string;
  darkSrc?: string;
  transparent?: boolean;
  themeSurface?: boolean;
  invertOnDark?: boolean;
}

export const PROVIDER_LOGOS: Record<ProviderBrand, ProviderBrandLogo> = {
  gemini: { src: geminiLogo },
  claude: { src: claudeLogo },
  codex: { src: codexLogo },
  xai: { src: xaiLightLogo, darkSrc: xaiDarkLogo, transparent: true },
  vertex: { src: vertexLogo },
  openaiCompatibility: { src: openaiLightLogo, darkSrc: openaiDarkLogo, transparent: true },
};
