export type AttentionSeverity = 'red' | 'amber' | 'gold' | 'info';

export interface AttentionItem {
  id: string;
  label: string;
  detail: string;
  severity: AttentionSeverity;
  href: string;
  source: string;
}

export interface AttentionSource {
  id: string;
  label: string;
  status: 'ok' | 'unknown';
  detail: string;
}

export interface AttentionOverview {
  generatedAt: string;
  attention: {
    acknowledged: boolean;
    message: string;
    allClear: boolean;
    coverageComplete: boolean;
    items: AttentionItem[];
    sources: AttentionSource[];
  };
}
