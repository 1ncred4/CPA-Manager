/**
 * OAuth 受管「关闭原名」锚点：
 * { name: modelId, alias: "cpa.off.<modelId>", fork: 关 }
 * 用于同名 identity 目标渠道内禁用时关闭原生入口，又不把模型全局 excluded。
 */

const lower = (value: string): string => value.trim().toLowerCase();

export const MANAGED_NATIVE_OFF_ALIAS_PREFIX = 'cpa.off.';

export function managedNativeOffAlias(modelId: string): string {
  return `${MANAGED_NATIVE_OFF_ALIAS_PREFIX}${modelId.trim()}`;
}

export function isManagedNativeOffAlias(alias: string): boolean {
  return lower(alias).startsWith(lower(MANAGED_NATIVE_OFF_ALIAS_PREFIX));
}
