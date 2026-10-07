export interface PipelineOverrides {
  force?: boolean;
  allowDirty?: boolean;
}

// Only flags already supported by these installed wrappers may be requested.
const SUPPORTED_OVERRIDES: Record<keyof PipelineOverrides, readonly string[]> = {
  force: ['pipeline-package-dev', 'pipeline-promote-dev-to-main'],
  allowDirty: ['pipeline-pull-latest']
};

export function pipelineOverrideError(
  controlId: string,
  input: { force?: unknown; allowDirty?: unknown }
): string | undefined {
  for (const key of Object.keys(SUPPORTED_OVERRIDES) as Array<keyof PipelineOverrides>) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') return `Pipeline override ${key} must be a boolean.`;
    if (!SUPPORTED_OVERRIDES[key].includes(controlId)) {
      return `Pipeline override ${key} is not supported by ${controlId}.`;
    }
  }
  return undefined;
}
