import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AdminError } from '../admin/envelope';
import { CollectSchema, type CollectRequest, type Observation } from './types';

export interface WorkItem {
  state: 'queued' | 'starting' | 'running' | 'done';
  observation: Observation; keyValueStoreId?: string; asyncId?: string;
}
export interface Entry {
  hash: string; request: CollectRequest; reservedDay: string; reservedCents: number;
  perRunCents: number; items: WorkItem[];
}
export interface Ledger { version: 1; entries: Record<string, Entry>; }
export function requestHash(request: CollectRequest): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}
const providerId = z.string().regex(/^[A-Za-z0-9]{1,64}$/);
const price = z.number().int().positive().max(100_000_000);
const observationSchema = z.object({
  sourceId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), productId: z.string().regex(/^[0-9]{1,20}$/),
  storeId: z.literal('0088'), status: z.enum(['priced', 'pending', 'failed', 'not_available']),
  observedAt: z.string().datetime(), regularPriceCents: price.optional(), salePriceCents: price.optional(),
  bulkPriceCents: price.optional(), bulkQuantityRequired: z.number().int().min(2).max(100_000_000).optional(),
  quantityAvailable: z.number().int().min(0).max(100_000_000).optional(),
  productName: z.string().min(1).max(500).optional(), productUrl: z.string().max(2048).optional(),
  apifyRunId: providerId.optional(), datasetId: providerId.optional(), error: z.string().max(80).optional()
}).strict();
const entrySchema = z.object({
  hash: z.string().regex(/^[a-f0-9]{64}$/), request: CollectSchema,
  reservedDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reservedCents: z.number().int().min(1).max(100),
  perRunCents: z.number().int().min(1).max(100),
  items: z.array(z.object({
    state: z.enum(['queued', 'starting', 'running', 'done']), observation: observationSchema,
    keyValueStoreId: providerId.optional(), asyncId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional()
  }).strict()).min(1).max(20)
}).strict();
const ledgerSchema = z.object({ version: z.literal(1), entries: z.record(entrySchema) }).strict();

// No time-based eviction: forgetting an identity would permit a repeated paid POST.
// A stale lock deliberately blocks new work after an unclean shutdown.
export async function withLedger<T>(dataDir: string, work: (ledger: Ledger, save: () => void) => Promise<T>): Promise<T> {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dataDir).isSymbolicLink()) throw new AdminError(503, 'PRICING_LEDGER_UNAVAILABLE', 'The pricing request ledger is unavailable.');
  const filename = path.join(dataDir, 'requests.json');
  const lockPath = path.join(dataDir, 'requests.lock');
  let lock: number;
  try { lock = fs.openSync(lockPath, 'wx', 0o600); }
  catch { throw new AdminError(409, 'PRICING_BUSY', 'A pricing request is active or the durable lock needs operator review.'); }
  try {
    let ledger: Ledger = { version: 1, entries: Object.create(null) as Record<string, Entry> };
    if (fs.existsSync(filename)) {
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw new Error('ledger');
      ledger = ledgerSchema.parse(JSON.parse(fs.readFileSync(filename, 'utf8')));
      if (Object.keys(ledger.entries).length > 10000) throw new Error('ledger');
      for (const [key, entry] of Object.entries(ledger.entries)) {
        if (key !== entry.request.requestId || entry.hash !== requestHash(entry.request) ||
            entry.items.length !== entry.request.products.length ||
            entry.reservedCents > entry.request.maxTotalChargeCents ||
            entry.perRunCents !== Math.floor(entry.reservedCents / entry.items.length)) throw new Error('ledger');
        entry.items.forEach((item, index) => {
          const product = entry.request.products[index], observation = item.observation;
          if (observation.sourceId !== product.sourceId || observation.productId !== product.productId ||
              (item.state === 'running' && !observation.apifyRunId) ||
              (observation.status === 'priced' && (!observation.regularPriceCents || item.state !== 'done'))) throw new Error('ledger');
        });
      }
    }
    const save = () => {
      const serialized = JSON.stringify(ledger);
      if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024 * 1024) throw new Error('ledger capacity');
      const temp = path.join(dataDir, 'requests-' + randomUUID() + '.tmp');
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, serialized, 'utf8'); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temp, filename);
      if (process.platform !== 'win32') {
        const dir = fs.openSync(dataDir, 'r');
        try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      }
    };
    return await work(ledger, save);
  } catch (error) {
    if (error instanceof AdminError) throw error;
    throw new AdminError(503, 'PRICING_LEDGER_UNAVAILABLE', 'The pricing request ledger is unavailable; inspect recorded run state before retrying.');
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
}
