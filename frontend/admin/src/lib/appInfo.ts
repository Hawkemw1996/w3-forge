import { consoleText } from "../../../../shared/consoleApp";
// W3 BuildCost application identity. VERSION (repo root) is the single source
// of truth for the application version, as in W3 Core.
import rawVersion from '../../../../VERSION?raw';

export const APP_NAME = consoleText('W3 BuildCost');
export const APP_ID = consoleText('w3buildcost');
export const APP_VERSION = rawVersion.trim();
/** v0.3.9 is developed on dev/v0.3.9 and has not been released. */
export const RELEASE_LABEL = 'Development build';
