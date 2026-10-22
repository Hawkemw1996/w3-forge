import { readFile } from 'node:fs/promises';
const BOOT = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function bootRelation(recorded: unknown, current: unknown): 'same' | 'previous' | 'unknown' { if (typeof recorded !== 'string' || typeof current !== 'string' || !BOOT.test(recorded) || !BOOT.test(current))
    return 'unknown'; return recorded.toLowerCase() === current.toLowerCase() ? 'same' : 'previous'; }
export async function readBootId() { const id = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(); if (!BOOT.test(id))
    throw Error('Execution boot identity unavailable'); return id; }
