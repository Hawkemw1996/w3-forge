// Test-only entry for the real dashboard widget and its normal providers.
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AttentionRequiredWidget } from '../../src/components/widgets/AttentionRequiredWidget';

export { QueryClient };

export function widget(queryClient: QueryClient, density: 'standard' | 'compact' = 'standard') {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AttentionRequiredWidget density={density} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
