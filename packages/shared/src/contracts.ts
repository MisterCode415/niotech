import { z } from 'zod';
import { membershipRoleSchema, businessUnitStatusSchema } from './roles.js';

export const SHIPPING_METHODS = ['ground', 'two_day', 'overnight'] as const;
export type ShippingMethod = (typeof SHIPPING_METHODS)[number];
export const shippingMethodSchema = z.enum(SHIPPING_METHODS);

export const SHIPPING_METHOD_LABELS: Record<ShippingMethod, string> = {
  ground: 'Ground',
  two_day: 'Two-day',
  overnight: 'Overnight',
};

export const addressSchema = z.object({
  line1: z.string().min(1),
  line2: z.string().optional(),
  city: z.string().min(1),
  region: z.string().min(1),
  postalCode: z.string().min(1),
  country: z.string().min(2).default('US'),
});
export type Address = z.infer<typeof addressSchema>;

const slugSchema = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and hyphens');

/* ---------------------------------- Platform ---------------------------------- */

export const createBusinessUnitSchema = z.object({
  name: z.string().min(2).max(120),
  slug: slugSchema,
  adminEmail: z.email(),
  adminName: z.string().min(1).max(120),
});
export type CreateBusinessUnitInput = z.infer<typeof createBusinessUnitSchema>;

export const updateBusinessUnitStatusSchema = z.object({
  status: businessUnitStatusSchema,
});

/* ------------------------------ Business unit config ------------------------------ */

export const upsertMarketingPageSchema = z.object({
  title: z.string().min(1).max(160),
  headline: z.string().max(200).optional(),
  bodyHtml: z.string().max(200_000),
  publish: z.boolean().default(false),
});
export type UpsertMarketingPageInput = z.infer<typeof upsertMarketingPageSchema>;

export const createTestTypeSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  sampleType: z.string().max(80).default('blood'),
  turnaroundDays: z.coerce.number().int().min(1).max(90).default(5),
});
export type CreateTestTypeInput = z.infer<typeof createTestTypeSchema>;

const packageFieldsSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(4000).optional(),
  priceCents: z.coerce.number().int().min(0),
  requiresClinician: z.boolean(),
  focusArea: z.string().max(120).optional(),
  internalReference: z.string().min(1).max(120).optional(),
  externalProductId: z.string().min(1).max(200).optional(),
  externalPurchaseUrl: z.url().max(2000).optional(),
  status: z.enum(['draft', 'active']).default('draft'),
  tests: z
    .array(
      z.object({
        testTypeId: z.uuid(),
        quantity: z.coerce.number().int().min(1).max(20),
      }),
    )
    .min(1, 'A package needs at least one test type'),
});
export const createPackageSchema = packageFieldsSchema;
export type CreatePackageInput = z.infer<typeof createPackageSchema>;
export const updatePackageSchema = packageFieldsSchema;
export type UpdatePackageInput = z.infer<typeof updatePackageSchema>;

export const createMemberSchema = z.object({
  email: z.email(),
  name: z.string().min(1).max(120),
  role: membershipRoleSchema,
});
export type CreateMemberInput = z.infer<typeof createMemberSchema>;

/* ---------------------------------- Patient ---------------------------------- */

export const registerPatientSchema = z.object({
  email: z.email(),
  name: z.string().min(1).max(120),
  /** Preserves a purchase-driven registration destination without accepting an arbitrary URL. */
  packageId: z.uuid().optional(),
});

export const createOrderSchema = z.object({
  packageId: z.uuid(),
  shippingAddress: addressSchema,
  shippingMethod: shippingMethodSchema.default('ground'),
});
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export interface OrderPackageSnapshot {
  packageName: string;
  packageVersion: number;
  priceCents: number;
  requiresClinician: boolean;
  internalReference: string | null;
  externalProductId: string | null;
  tests: Array<{
    testTypeId: string;
    name: string;
    sampleType: string;
    turnaroundDays: number;
    quantity: number;
  }>;
}

export const payOrderSchema = z.object({
  // The mock provider ignores this, but the shape matches what a real tokenized card gives us.
  paymentToken: z.string().default('mock-token'),
});

export const externalPurchaseSchema = z.object({
  source: z.string().min(1).max(80).regex(/^[a-z0-9_-]+$/),
  externalOrderId: z.string().min(1).max(200),
  externalPaymentId: z.string().min(1).max(200),
  packageReference: z.string().min(1).max(200),
  patient: z.object({
    email: z.email(),
    name: z.string().min(1).max(120),
  }),
  shippingAddress: addressSchema,
  shippingMethod: shippingMethodSchema.default('ground'),
});
export type ExternalPurchaseInput = z.infer<typeof externalPurchaseSchema>;

/* -------------------------------- Fulfillment -------------------------------- */

export const correlateOrderSchema = z.object({
  externalOrderId: z.string().min(1).max(120),
});

export const shipOrderSchema = z.object({
  carrier: z.string().min(1).max(80),
  trackingNumber: z.string().min(1).max(120),
});

export const ORDER_ISSUE_REASONS = [
  'address_invalid',
  'out_of_stock',
  'damaged_kit',
  'payment_query',
  'other',
] as const;
export const orderIssueReasonSchema = z.enum(ORDER_ISSUE_REASONS);
export const ORDER_ISSUE_REASON_LABELS: Record<(typeof ORDER_ISSUE_REASONS)[number], string> = {
  address_invalid: 'Address invalid',
  out_of_stock: 'Out of stock',
  damaged_kit: 'Damaged kit',
  payment_query: 'Payment query',
  other: 'Other',
};

export const flagOrderIssueSchema = z.object({
  reason: orderIssueReasonSchema,
  detail: z.string().max(2000).optional(),
});

export const fulfillmentAccountSchema = z.object({
  accountName: z.string().min(1).max(120),
  accountType: z.enum(['ach', 'wire', 'invoice']).default('invoice'),
  accountReference: z.string().min(1).max(120),
  billingEmail: z.email(),
});

/* ------------------------------------ Lab ------------------------------------ */

export const completeAnalysisSchema = z.object({
  fileId: z.uuid(),
  summary: z.string().max(4000).optional(),
});

/* ---------------------------------- Doctor ---------------------------------- */

export const CLINICIAN_DECISIONS = ['approved', 'rejected'] as const;
export type ClinicianDecision = (typeof CLINICIAN_DECISIONS)[number];
export const clinicianDecisionSchema = z.enum(CLINICIAN_DECISIONS);

export const submitReviewSchema = z.object({
  decision: clinicianDecisionSchema,
  interpretation: z.string().min(1).max(20_000),
  recommendations: z.string().max(20_000).optional(),
});
export type SubmitReviewInput = z.infer<typeof submitReviewSchema>;

/* ------------------------------------ Auth ------------------------------------ */

export const devLoginSchema = z.object({
  email: z.email(),
});
