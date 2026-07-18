import iconGemini from '@/assets/icons/gemini.svg';
import iconClaude from '@/assets/icons/claude.svg';
import iconOpenaiLight from '@/assets/icons/openai-light.svg';
import iconOpenaiDark from '@/assets/icons/openai-dark.svg';
import iconQwen from '@/assets/icons/qwen.svg';
import iconKimiLight from '@/assets/icons/kimi-light.svg';
import iconKimiDark from '@/assets/icons/kimi-dark.svg';
import iconGlm from '@/assets/icons/glm.svg';
import iconGrok from '@/assets/icons/grok.svg';
import iconGrokDark from '@/assets/icons/grok-dark.svg';
import iconDeepseek from '@/assets/icons/deepseek.svg';
import iconMinimax from '@/assets/icons/minimax.svg';

export const MODEL_CATEGORY_ICONS: Record<string, string | { light: string; dark: string }> = {
  gpt: { light: iconOpenaiLight, dark: iconOpenaiDark },
  claude: iconClaude,
  gemini: iconGemini,
  qwen: iconQwen,
  kimi: { light: iconKimiDark, dark: iconKimiLight },
  glm: iconGlm,
  grok: { light: iconGrok, dark: iconGrokDark },
  deepseek: iconDeepseek,
  minimax: iconMinimax,
};

export const resolveModelCategoryIcon = (
  categoryId: string,
  theme: 'light' | 'dark' | string
): string | null => {
  const iconEntry = MODEL_CATEGORY_ICONS[categoryId];
  if (!iconEntry) return null;
  if (typeof iconEntry === 'string') return iconEntry;
  return theme === 'dark' ? iconEntry.dark : iconEntry.light;
};
