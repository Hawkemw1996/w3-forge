// W3 Core v0.12.10 — Admin Console test harness entry.
//
// Bundled by frontend/command-center/tests/helpers/buildHarness.mjs (Vite SSR
// build, react externalized, `appRoot` = frontend/admin) so Node tests can
// mount the *real* UnifiedReleaseWorkflow + DarkSelect with react-dom/client.
// This file is test-only and is not part of the production bundle.

import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UnifiedReleaseWorkflow } from '../../src/pages/github/UnifiedReleaseWorkflow';
import { PipelineSharedStateProvider, usePipelineSharedState } from '../../src/pages/github/pipelineContext';
import { DarkSelect } from '../../src/components/ui/DarkSelect';
import * as devBranchVersion from '../../src/lib/devBranchVersion';
import * as uiSections from '../../src/pages/controls/uiSections';

export { UnifiedReleaseWorkflow, PipelineSharedStateProvider, usePipelineSharedState, DarkSelect, devBranchVersion, uiSections };

/** Exposes the shared pipeline branch so tests can assert the exact value kept in context. */
export function SharedBranchProbe(): React.ReactElement {
  const shared = usePipelineSharedState();
  return <span data-testid="shared-branch-probe">{shared.branch}</span>;
}

/** Wrap in the same providers the GitHub / Releases page uses (query client + pipeline shared state). */
export function withProviders(node: React.ReactNode, queryClient?: QueryClient): React.ReactElement {
  const qc =
    queryClient ??
    new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } } });
  return (
    <QueryClientProvider client={qc}>
      <PipelineSharedStateProvider>
        {node}
        <SharedBranchProbe />
      </PipelineSharedStateProvider>
    </QueryClientProvider>
  );
}

export { QueryClient };
