import { Navigate, useRoutes, type Location } from 'react-router-dom';
import { DashboardPage } from '@/pages/DashboardPage';
import { ProvidersWorkbenchPage } from '@/features/providers/ProvidersWorkbenchPage';
import { ModelsPage } from '@/features/models/ModelsPage';
import { ModelExcludedEditPage } from '@/features/models/ModelExcludedEditPage';
import { ModelAliasEditPage } from '@/features/models/ModelAliasEditPage';
import { ApiKeyModelsEditPage } from '@/features/models/ApiKeyModelsEditPage';
import { QuotaPage } from '@/pages/QuotaPage';
import { PluginResourcePage } from '@/features/plugins/PluginResourcePage';
import { PluginsPage } from '@/features/plugins/PluginsPage';
import { PluginStorePage } from '@/features/plugins/PluginStorePage';
import { ConfigPage } from '@/pages/ConfigPage';
import { LogsPage } from '@/pages/LogsPage';
import { SystemPage } from '@/pages/SystemPage';
import { useAuthStore } from '@/stores';

const createMainRoutes = (supportsPlugin: boolean) => [
  { path: '/', element: <DashboardPage /> },
  { path: '/dashboard', element: <DashboardPage /> },
  { path: '/settings', element: <Navigate to="/config" replace /> },
  { path: '/api-keys', element: <Navigate to="/config" replace /> },
  { path: '/quick-start', element: <Navigate to="/ai-providers" replace /> },
  { path: '/quick-start/*', element: <Navigate to="/ai-providers" replace /> },
  { path: '/ai-providers', element: <ProvidersWorkbenchPage /> },
  { path: '/ai-providers/*', element: <Navigate to="/ai-providers" replace /> },
  // Legacy redirects: auth-files / oauth → ai-providers or models
  { path: '/auth-files', element: <Navigate to="/ai-providers" replace /> },
  { path: '/auth-files/oauth-excluded', element: <Navigate to="/models?tab=disabled" replace /> },
  {
    path: '/auth-files/oauth-model-alias',
    element: <Navigate to="/models?tab=mapping" replace />,
  },
  { path: '/auth-files/*', element: <Navigate to="/ai-providers" replace /> },
  { path: '/oauth', element: <Navigate to="/ai-providers" replace /> },
  { path: '/oauth/*', element: <Navigate to="/ai-providers" replace /> },
  // Models management
  { path: '/models', element: <ModelsPage /> },
  { path: '/models/excluded', element: <ModelExcludedEditPage /> },
  { path: '/models/mapping', element: <ModelAliasEditPage /> },
  { path: '/models/api-key', element: <ApiKeyModelsEditPage /> },
  { path: '/quota', element: <QuotaPage /> },
  ...(supportsPlugin
    ? [
        { path: '/plugin-pages/:pluginId/:menuIndex', element: <PluginResourcePage /> },
        { path: '/plugins', element: <PluginsPage /> },
        { path: '/plugin-store', element: <PluginStorePage /> },
        { path: '/plugins/*', element: <Navigate to="/plugins" replace /> },
      ]
    : [
        { path: '/plugin-pages/*', element: <Navigate to="/" replace /> },
        { path: '/plugins/*', element: <Navigate to="/" replace /> },
        { path: '/plugin-store', element: <Navigate to="/" replace /> },
      ]),
  { path: '/config', element: <ConfigPage /> },
  { path: '/logs', element: <LogsPage /> },
  { path: '/system', element: <SystemPage /> },
  { path: '*', element: <Navigate to="/" replace /> },
];

export function MainRoutes({ location }: { location?: Location }) {
  const supportsPlugin = useAuthStore((state) => state.supportsPlugin);
  return useRoutes(createMainRoutes(supportsPlugin), location);
}
