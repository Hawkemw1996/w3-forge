import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Standard shadcn-style class merger.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Re-exports preserve callers from v0.5.0; new code should import from './format'.
export {
  formatBytes,
  formatDuration,
  formatRelative,
  formatTimestamp,
  formatDate,
  formatNumber
} from './format';
