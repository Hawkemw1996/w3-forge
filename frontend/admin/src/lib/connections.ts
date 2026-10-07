export interface Connections {
  core: { configured: boolean; publicUrl: string | null };
  github: { repositoryUrl: string | null; workspace: string; defaultDevBranch: string };
  terminal: { enabled: boolean };
  materialPricing: {
    enabled: boolean; configured: boolean; maxProducts: number;
    maxRequestChargeCents: number; maxDailyChargeCents: number;
  };
  ollama: { configured: boolean; model: string | null };
  n8n: { configured: boolean; url: string | null };
  chat: { status: 'planned' };
  businessAutomations: { status: 'planned' };
}
