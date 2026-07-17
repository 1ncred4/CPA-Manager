import { isRecord } from '@/utils/helpers';
import { PROVIDER_BRAND_ORDER } from './descriptors';
import {
  PROVIDER_SORT_BY_VALUES,
  SORT_DIR_VALUES,
  parseCategoryKey,
  toCategoryKey,
  type ProviderBrand,
  type ProviderCategoryId,
  type ProviderCategoryKey,
  type ProviderSortBy,
  type SortDir,
} from './types';
import { OAUTH_CHANNEL_ORDER } from './oauthChannels';

const PROVIDERS_UI_STATE_KEY = 'providersPage.uiState';
const DEFAULT_ACTIVE_CATEGORY: ProviderCategoryId = { method: 'apiKey', brand: 'gemini' };
const DEFAULT_PROVIDER_FILTER_STATE: ProviderFilterState = {
  filter: '',
  sortBy: 'name',
  sortDir: 'asc',
  selectedModels: [],
};

const PROVIDER_BRAND_SET = new Set<ProviderBrand>(PROVIDER_BRAND_ORDER);
const PROVIDER_SORT_BY_SET = new Set<ProviderSortBy>(PROVIDER_SORT_BY_VALUES);
const SORT_DIR_SET = new Set<SortDir>(SORT_DIR_VALUES);

export interface ProviderFilterState {
  filter: string;
  sortBy: ProviderSortBy;
  sortDir: SortDir;
  selectedModels: string[];
}

export interface ProvidersWorkbenchUiState {
  /** 兼容旧字段：仅 apiKey brand */
  activeBrand: ProviderBrand;
  /** 当前选中分类（含 OAuth） */
  activeCategoryKey: ProviderCategoryKey;
  filtersByBrand: Partial<Record<ProviderBrand, ProviderFilterState>>;
  filtersByCategory: Partial<Record<ProviderCategoryKey, ProviderFilterState>>;
}

const isProviderBrand = (value: unknown): value is ProviderBrand =>
  typeof value === 'string' && PROVIDER_BRAND_SET.has(value as ProviderBrand);

const isProviderSortBy = (value: unknown): value is ProviderSortBy =>
  typeof value === 'string' && PROVIDER_SORT_BY_SET.has(value as ProviderSortBy);

const isSortDir = (value: unknown): value is SortDir =>
  typeof value === 'string' && SORT_DIR_SET.has(value as SortDir);

const normalizeSelectedModels = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  value.forEach((item) => {
    if (typeof item !== 'string') return;
    const name = item.trim();
    if (!name) return;
    seen.add(name);
  });
  return Array.from(seen);
};

const normalizeProviderFilterState = (value: unknown): ProviderFilterState => {
  if (!isRecord(value)) return { ...DEFAULT_PROVIDER_FILTER_STATE };
  return {
    filter: typeof value.filter === 'string' ? value.filter : '',
    sortBy: isProviderSortBy(value.sortBy) ? value.sortBy : 'name',
    sortDir: isSortDir(value.sortDir) ? value.sortDir : 'asc',
    selectedModels: normalizeSelectedModels(value.selectedModels),
  };
};

const defaultCategoryKey = (): ProviderCategoryKey => toCategoryKey(DEFAULT_ACTIVE_CATEGORY);

const createDefaultProvidersWorkbenchUiState = (): ProvidersWorkbenchUiState => ({
  activeBrand: DEFAULT_ACTIVE_CATEGORY.brand,
  activeCategoryKey: defaultCategoryKey(),
  filtersByBrand: {},
  filtersByCategory: {},
});

export const getActiveCategory = (state: ProvidersWorkbenchUiState): ProviderCategoryId => {
  const parsed = parseCategoryKey(state.activeCategoryKey);
  if (parsed) return parsed;
  if (isProviderBrand(state.activeBrand)) {
    return { method: 'apiKey', brand: state.activeBrand };
  }
  return DEFAULT_ACTIVE_CATEGORY;
};

export const getProviderFilterState = (
  state: ProvidersWorkbenchUiState,
  brand: ProviderBrand
): ProviderFilterState => {
  const key = toCategoryKey({ method: 'apiKey', brand });
  return (
    state.filtersByCategory[key] ?? state.filtersByBrand[brand] ?? DEFAULT_PROVIDER_FILTER_STATE
  );
};

export const getCategoryFilterState = (
  state: ProvidersWorkbenchUiState,
  category: ProviderCategoryId
): ProviderFilterState => {
  const key = toCategoryKey(category);
  if (category.method === 'apiKey') {
    return getProviderFilterState(state, category.brand);
  }
  return state.filtersByCategory[key] ?? DEFAULT_PROVIDER_FILTER_STATE;
};

export const readProvidersWorkbenchUiState = (): ProvidersWorkbenchUiState => {
  if (typeof window === 'undefined') return createDefaultProvidersWorkbenchUiState();

  try {
    const raw = window.localStorage.getItem(PROVIDERS_UI_STATE_KEY);
    if (!raw) return createDefaultProvidersWorkbenchUiState();

    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return createDefaultProvidersWorkbenchUiState();

    const brandSource = isRecord(parsed.filtersByBrand) ? parsed.filtersByBrand : {};
    const categorySource = isRecord(parsed.filtersByCategory) ? parsed.filtersByCategory : {};
    const filtersByBrand: ProvidersWorkbenchUiState['filtersByBrand'] = {};
    const filtersByCategory: ProvidersWorkbenchUiState['filtersByCategory'] = {};

    PROVIDER_BRAND_ORDER.forEach((brand) => {
      const filterState = brandSource[brand] ?? categorySource[`apiKey:${brand}`];
      if (filterState !== undefined) {
        const normalized = normalizeProviderFilterState(filterState);
        filtersByBrand[brand] = normalized;
        filtersByCategory[`apiKey:${brand}`] = normalized;
      }
    });

    OAUTH_CHANNEL_ORDER.forEach((channel) => {
      const key = `oauth:${channel}` as ProviderCategoryKey;
      const filterState = categorySource[key];
      if (filterState !== undefined) {
        filtersByCategory[key] = normalizeProviderFilterState(filterState);
      }
    });

    // 动态 oauth 渠道
    Object.keys(categorySource).forEach((key) => {
      if (!key.startsWith('oauth:')) return;
      if (filtersByCategory[key as ProviderCategoryKey]) return;
      filtersByCategory[key as ProviderCategoryKey] = normalizeProviderFilterState(
        categorySource[key]
      );
    });

    const activeBrand = isProviderBrand(parsed.activeBrand)
      ? parsed.activeBrand
      : DEFAULT_ACTIVE_CATEGORY.brand;

    let activeCategoryKey: ProviderCategoryKey = `apiKey:${activeBrand}`;
    if (typeof parsed.activeCategoryKey === 'string') {
      const parsedKey = parseCategoryKey(parsed.activeCategoryKey);
      if (parsedKey) {
        activeCategoryKey = toCategoryKey(parsedKey);
      }
    }

    return {
      activeBrand:
        parseCategoryKey(activeCategoryKey)?.method === 'apiKey'
          ? (parseCategoryKey(activeCategoryKey) as { brand: ProviderBrand }).brand
          : activeBrand,
      activeCategoryKey,
      filtersByBrand,
      filtersByCategory,
    };
  } catch {
    return createDefaultProvidersWorkbenchUiState();
  }
};

export const writeProvidersWorkbenchUiState = (state: ProvidersWorkbenchUiState) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PROVIDERS_UI_STATE_KEY, JSON.stringify(state));
  } catch {
    // ignore storage failures
  }
};
