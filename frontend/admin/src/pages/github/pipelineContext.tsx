// =============================================================================
// W3 Core v0.5.31 - GitHub / Releases pipeline shared state context.
// =============================================================================
//
// This module exposes a small React context that lets the new v0.5.31
// readiness/help components observe the same "selected dev branch" and
// "selected staged package" values that the existing
// <ReleasePipelinePanel> tracks internally.
//
// Scope rules (v0.5.31):
//   - Frontend only. No backend contract change.
//   - No new fetches. All data is sourced from existing react-query keys
//     already populated by GitHubPage and ReleasePipelinePanel.
//   - The context value is OPTIONAL. If no provider is mounted, every
//     consumer hook still returns sensible defaults (empty string / null)
//     so the panel can also be rendered standalone for previews/tests.
//
// Nothing in this file talks to the network. Nothing changes registry,
// safeRunner, validators, scripts, auth, DB, schema, deps, CI, or
// production deploy logic.
// =============================================================================

import {
  createContext,
  Dispatch,
  ReactNode,
  SetStateAction,
  useContext,
  useMemo,
  useState
} from 'react';

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export interface PipelineSharedState {
  /** Currently selected dev/vX.Y.Z branch in the Release Pipeline panel. */
  branch: string;
  setBranch: Dispatch<SetStateAction<string>>;

  /** Currently selected staged package basename in the Release Pipeline panel. */
  packageBasename: string;
  setPackageBasename: Dispatch<SetStateAction<string>>;

  /**
   * controlId of the most recent run that ended in success.
   * Tracked at the page level so PipelineStateSummary can render
   * "Last successful action" without re-implementing the run map.
   */
  lastSuccessId: string | null;
  setLastSuccessId: Dispatch<SetStateAction<string | null>>;

  /**
   * controlId of the most recent run that ended in fail/refused/error.
   * Same purpose as lastSuccessId.
   */
  lastFailureId: string | null;
  setLastFailureId: Dispatch<SetStateAction<string | null>>;

  /**
   * Per-stage success bitmap derived from the same RunMap the panel maintains
   * locally. Stage keys: 'remote' | 'sync' | 'test' | 'package' | 'verify'
   * | 'deploy' | 'tag'. The bit is true when the stage's gate action
   * has reported success at least once this session.
   *
   * Stored as a plain object so subtree consumers can quickly observe
   * "did test pass yet?" without subscribing to the full run map.
   */
  stageSuccess: Record<string, boolean>;
  setStageSuccess: Dispatch<SetStateAction<Record<string, boolean>>>;
}

// ---------------------------------------------------------------------------
// Defaults (used both as initial state and as a fallback when no provider
// is mounted).
// ---------------------------------------------------------------------------

const FALLBACK: PipelineSharedState = {
  branch: '',
  setBranch: () => {},
  packageBasename: '',
  setPackageBasename: () => {},
  lastSuccessId: null,
  setLastSuccessId: () => {},
  lastFailureId: null,
  setLastFailureId: () => {},
  stageSuccess: {},
  setStageSuccess: () => {}
};

// ---------------------------------------------------------------------------
// Context + provider
// ---------------------------------------------------------------------------

const PipelineSharedStateContext = createContext<PipelineSharedState>(FALLBACK);

export function PipelineSharedStateProvider({ children }: { children: ReactNode }) {
  const [branch, setBranch] = useState<string>('');
  const [packageBasename, setPackageBasename] = useState<string>('');
  const [lastSuccessId, setLastSuccessId] = useState<string | null>(null);
  const [lastFailureId, setLastFailureId] = useState<string | null>(null);
  const [stageSuccess, setStageSuccess] = useState<Record<string, boolean>>({});

  const value = useMemo<PipelineSharedState>(
    () => ({
      branch,
      setBranch,
      packageBasename,
      setPackageBasename,
      lastSuccessId,
      setLastSuccessId,
      lastFailureId,
      setLastFailureId,
      stageSuccess,
      setStageSuccess
    }),
    [branch, packageBasename, lastSuccessId, lastFailureId, stageSuccess]
  );

  return (
    <PipelineSharedStateContext.Provider value={value}>
      {children}
    </PipelineSharedStateContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Consumer hook
// ---------------------------------------------------------------------------

export function usePipelineSharedState(): PipelineSharedState {
  return useContext(PipelineSharedStateContext);
}
