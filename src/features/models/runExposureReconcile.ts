/**
 * 从当前后端别名 + 本地挂起 + 访问行，投影后 reconcile 原名隐藏。
 * 映射保存/删除后调用。
 */

import type { AuthFileModelItem } from '@/features/authFiles/constants';
import type { ProviderResource } from '@/features/providers/types';
import type { OAuthModelAliasEntry } from '@/types';
import type { ModelAccessRow } from './modelAccessRows';
import {
  accessRowsToExposureModels,
  federatedRowsToManualMappings,
  projectExposure,
} from './exposureProjection';
import { listManualMappingClaims } from './mappingClaims';
import { listAllSuspended, mergeSuspendedIntoFederatedRows } from './mappingSuspend';
import {
  assembleManualAndAutoMappingRows,
  buildFederatedMappingRows,
  buildOauthDisplayNameMap,
} from './modelMapping';
import {
  reconcileExposureNatives,
  type ReconcileExposureResult,
} from './reconcileExposureNatives';

export async function runExposureReconcile(input: {
  apiBase: string;
  modelAlias: Record<string, OAuthModelAliasEntry[]>;
  resources: ProviderResource[];
  accessRows: ModelAccessRow[];
  oauthModels?: Record<string, AuthFileModelItem[]>;
  providerLabels: {
    oauth: (channel: string) => string;
    apiKey: (resource: ProviderResource) => string;
  };
}): Promise<ReconcileExposureResult> {
  const enabledKeySet = new Set(
    input.accessRows.filter((r) => r.enabled).map((r) => r.key)
  );
  const oauthDisplayNames = buildOauthDisplayNameMap(input.oauthModels ?? {});

  const baseRows = buildFederatedMappingRows({
    modelAlias: input.modelAlias,
    resources: input.resources,
    oauthDisplayNames,
    enabledKeySet,
    providerLabels: input.providerLabels,
  });

  const suspended = listAllSuspended(input.apiBase);
  const resourceById = new Map(input.resources.map((r) => [r.id, r]));
  const withSuspended = mergeSuspendedIntoFederatedRows(baseRows, suspended, {
    oauthDisplayNames,
    providerLabels: {
      oauth: input.providerLabels.oauth,
      apiKey: (resourceId, brand) => {
        const resource = resourceById.get(resourceId);
        if (resource) return input.providerLabels.apiKey(resource);
        return brand;
      },
    },
  });

  const claims = listManualMappingClaims(input.apiBase);
  const { manualRows } = assembleManualAndAutoMappingRows(
    withSuspended,
    input.accessRows,
    claims
  );

  const manual = federatedRowsToManualMappings(manualRows);
  const access = accessRowsToExposureModels(input.accessRows);
  const projection = projectExposure({ access, manual });

  return reconcileExposureNatives({
    apiBase: input.apiBase,
    nativeHide: projection.nativeHide,
    resources: input.resources,
  });
}
