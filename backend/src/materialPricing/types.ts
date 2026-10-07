import { z } from 'zod';

export const RequestId = z.string().regex(/^[A-Za-z0-9_-]{16,80}$/);
const SourceId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const ProductId = z.string().regex(/^[0-9]{1,20}$/);
export const CollectSchema = z.object({
  schemaVersion: z.literal(1), requestId: RequestId,
  postalCode: z.literal('49221'), storeId: z.literal('0088'),
  maxTotalChargeCents: z.number().int().min(1).max(100),
  products: z.array(z.object({ sourceId: SourceId, productId: ProductId }).strict()).min(1).max(20)
}).strict().superRefine((value, ctx) => {
  if (new Set(value.products.map(p => p.sourceId)).size !== value.products.length ||
      new Set(value.products.map(p => p.productId)).size !== value.products.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate source or product ID.' });
  }
});
export type CollectRequest = z.infer<typeof CollectSchema>;
export interface Observation {
  sourceId: string; productId: string; storeId: string;
  status: 'priced' | 'pending' | 'failed' | 'not_available';
  regularPriceCents?: number; salePriceCents?: number; bulkPriceCents?: number;
  bulkQuantityRequired?: number; quantityAvailable?: number;
  productName?: string; productUrl?: string; observedAt: string;
  apifyRunId?: string; datasetId?: string; error?: string;
}
export interface CollectResult {
  schemaVersion: 1; requestId: string; postalCode: '49221'; storeId: '0088'; observations: Observation[];
}
const Text = z.string().trim().min(1).max(500);
export const MatchSchema = z.object({
  schemaVersion: z.literal(1), requestId: RequestId,
  material: z.object({ materialId: SourceId, requirements: z.array(Text).min(1).max(20) }).strict(),
  candidates: z.array(z.object({ productId: ProductId, name: Text, attributes: z.array(Text).max(20) }).strict()).min(1).max(10)
}).strict().superRefine((value, ctx) => {
  if (new Set(value.candidates.map(c => c.productId)).size !== value.candidates.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate candidate product ID.' });
  }
});
export type MatchRequest = z.infer<typeof MatchSchema>;
export const RecommendationSchema = z.object({
  recommendedProductId: ProductId.nullable(),
  discrepancies: z.array(Text).max(20), reason: Text
}).strict();
