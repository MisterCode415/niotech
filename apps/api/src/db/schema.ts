import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  bigserial,
  boolean,
  timestamp,
  jsonb,
  numeric,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import {
  MEMBERSHIP_ROLES,
  ACTOR_ROLES,
  BUSINESS_UNIT_STATUSES,
  USER_STATUSES,
  ORDER_STATUSES,
  KIT_STATUSES,
  SHIPPING_METHODS,
  ORDER_ISSUE_REASONS,
  CLINICIAN_DECISIONS,
  type Address,
  type OrderPackageSnapshot,
} from '@nio/shared';

/* ---------------------------------- Enums ---------------------------------- */

export const membershipRoleEnum = pgEnum('membership_role', MEMBERSHIP_ROLES);
export const actorRoleEnum = pgEnum('actor_role', ACTOR_ROLES);
export const businessUnitStatusEnum = pgEnum('business_unit_status', BUSINESS_UNIT_STATUSES);
export const userStatusEnum = pgEnum('user_status', USER_STATUSES);
export const orderStatusEnum = pgEnum('order_status', ORDER_STATUSES);
export const kitStatusEnum = pgEnum('kit_status', KIT_STATUSES);
export const shippingMethodEnum = pgEnum('shipping_method', SHIPPING_METHODS);
export const orderIssueReasonEnum = pgEnum('order_issue_reason', ORDER_ISSUE_REASONS);
export const clinicianDecisionEnum = pgEnum('clinician_decision', CLINICIAN_DECISIONS);
export const paymentStatusEnum = pgEnum('payment_status', [
  'unpaid',
  'pending',
  'processing',
  'paid',
  'partially_refunded',
  'refunded',
  'disputed',
  'failed',
  'cancelled',
  'expired',
]);
export const packageStatusEnum = pgEnum('package_status', ['draft', 'active', 'archived']);
export const shipmentDirectionEnum = pgEnum('shipment_direction', [
  'outbound_to_patient',
  'inbound_to_lab',
]);
export const issueStatusEnum = pgEnum('issue_status', ['open', 'resolved']);
export const chargeStatusEnum = pgEnum('charge_status', ['pending', 'batched', 'paid']);
export const payoutAccountTypeEnum = pgEnum('payout_account_type', ['ach', 'wire', 'invoice']);
export const paymentAccountStatusEnum = pgEnum('payment_account_status', [
  'disconnected',
  'pending',
  'restricted',
  'active',
]);
export const catalogSyncStatusEnum = pgEnum('catalog_sync_status', [
  'pending',
  'syncing',
  'synced',
  'failed',
]);
export const fileExtractionMethodEnum = pgEnum('file_extraction_method', ['pdf_text', 'ocr']);
export const reportMessageRoleEnum = pgEnum('report_message_role', ['user', 'assistant']);
export const PHI_RESOURCE_TYPES = [
  'order_detail',
  'result_file',
  'result_text',
  'conversation',
  'review',
] as const;
export const PHI_ACCESS_ACTIONS = ['view', 'download', 'extract', 'chat'] as const;
export type PhiResourceType = (typeof PHI_RESOURCE_TYPES)[number];
export type PhiAccessAction = (typeof PHI_ACCESS_ACTIONS)[number];
export const phiResourceTypeEnum = pgEnum('phi_resource_type', PHI_RESOURCE_TYPES);
export const phiAccessActionEnum = pgEnum('phi_access_action', PHI_ACCESS_ACTIONS);

/* --------------------------------- Platform --------------------------------- */

/**
 * The alpha superuser table. The privileged deployment bootstrap owns this root-of-trust row;
 * no authenticated application route can grant platform administration.
 */
export const platformAdmins = pgTable(
  'platform_admins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    auth0UserId: text('auth0_user_id'),
    name: text('name'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('platform_admins_email_key').on(t.email),
    uniqueIndex('platform_admins_auth0_key').on(t.auth0UserId),
  ],
);

export const businessUnits = pgTable(
  'business_units',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    auth0OrgId: text('auth0_org_id'),
    status: businessUnitStatusEnum('status').notNull().default('active'),
    /** Printed on the prepaid return label that ships inside every kit. */
    labName: text('lab_name'),
    labReturnAddress: jsonb('lab_return_address').$type<Address>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('business_units_slug_key').on(t.slug)],
);

/* --------------------------------- Identity --------------------------------- */

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    auth0UserId: text('auth0_user_id'),
    status: userStatusEnum('status').notNull().default('active'),
    /** Synthetic patients created by the mock flow; never emailed, removed by "Clear mock data". */
    isMock: boolean('is_mock').notNull().default(false),
    /** First proof an invitee activated: the API only accepts verified, completed sign-ins. */
    lastSignInAt: timestamp('last_sign_in_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_key').on(t.email),
    uniqueIndex('users_auth0_key').on(t.auth0UserId),
  ],
);

/** One human can hold several roles, and hold them across several business units. */
export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    businessUnitId: uuid('business_unit_id')
      .notNull()
      .references(() => businessUnits.id, { onDelete: 'cascade' }),
    role: membershipRoleEnum('role').notNull(),
    status: userStatusEnum('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('memberships_user_bu_role_key').on(t.userId, t.businessUnitId, t.role),
    index('memberships_bu_role_idx').on(t.businessUnitId, t.role),
  ],
);

/* ---------------------------------- Catalog ---------------------------------- */

export const marketingPages = pgTable(
  'marketing_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessUnitId: uuid('business_unit_id')
      .notNull()
      .references(() => businessUnits.id, { onDelete: 'cascade' }),
    version: integer('version').notNull().default(1),
    title: text('title').notNull(),
    headline: text('headline'),
    bodyHtml: text('body_html').notNull(),
    isPublished: boolean('is_published').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('marketing_pages_bu_version_key').on(t.businessUnitId, t.version),
    index('marketing_pages_bu_published_idx').on(t.businessUnitId, t.isPublished),
  ],
);

export const testTypes = pgTable(
  'test_types',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessUnitId: uuid('business_unit_id')
      .notNull()
      .references(() => businessUnits.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    sampleType: text('sample_type').notNull().default('blood'),
    turnaroundDays: integer('turnaround_days').notNull().default(5),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('test_types_bu_idx').on(t.businessUnitId)],
);

export const packages = pgTable(
  'packages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessUnitId: uuid('business_unit_id')
      .notNull()
      .references(() => businessUnits.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    focusArea: text('focus_area'),
    internalReference: text('internal_reference'),
    externalProductId: text('external_product_id'),
    externalPurchaseUrl: text('external_purchase_url'),
    priceCents: integer('price_cents').notNull(),
    /** Drives the branch after lab completion: doctor queue vs. straight to the patient. */
    requiresClinician: boolean('requires_clinician').notNull().default(false),
    status: packageStatusEnum('status').notNull().default('active'),
    version: integer('version').notNull().default(1),
    supersedesPackageId: uuid('supersedes_package_id').references((): AnyPgColumn => packages.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('packages_bu_status_idx').on(t.businessUnitId, t.status),
    uniqueIndex('packages_bu_internal_reference_version_key').on(
      t.businessUnitId,
      t.internalReference,
      t.version,
    ),
    uniqueIndex('packages_bu_external_product_key').on(t.businessUnitId, t.externalProductId),
  ],
);

/** How many kits of each test type a package ships. */
export const packageTestTypes = pgTable(
  'package_test_types',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    packageId: uuid('package_id')
      .notNull()
      .references(() => packages.id, { onDelete: 'cascade' }),
    testTypeId: uuid('test_type_id')
      .notNull()
      .references(() => testTypes.id, { onDelete: 'restrict' }),
    quantity: integer('quantity').notNull().default(1),
  },
  (t) => [uniqueIndex('package_test_types_key').on(t.packageId, t.testTypeId)],
);

/* ----------------------------- Stripe Connect commerce ----------------------------- */

export const paymentAccounts = pgTable(
  'payment_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessUnitId: uuid('business_unit_id')
      .notNull()
      .references(() => businessUnits.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull().default('stripe'),
    providerAccountId: text('provider_account_id'),
    status: paymentAccountStatusEnum('status').notNull().default('disconnected'),
    chargesEnabled: boolean('charges_enabled').notNull().default(false),
    payoutsEnabled: boolean('payouts_enabled').notNull().default(false),
    detailsSubmitted: boolean('details_submitted').notNull().default(false),
    country: text('country'),
    defaultCurrency: text('default_currency'),
    disabledReason: text('disabled_reason'),
    oauthStateHash: text('oauth_state_hash'),
    oauthStateExpiresAt: timestamp('oauth_state_expires_at', { withTimezone: true }),
    disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
    lastSyncError: text('last_sync_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payment_accounts_bu_provider_key').on(t.businessUnitId, t.provider),
    uniqueIndex('payment_accounts_provider_account_key').on(t.provider, t.providerAccountId),
  ],
);

export const packagePaymentMappings = pgTable(
  'package_payment_mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessUnitId: uuid('business_unit_id')
      .notNull()
      .references(() => businessUnits.id, { onDelete: 'cascade' }),
    packageId: uuid('package_id')
      .notNull()
      .references(() => packages.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull().default('stripe'),
    providerProductId: text('provider_product_id'),
    providerPriceId: text('provider_price_id'),
    status: catalogSyncStatusEnum('status').notNull().default('pending'),
    lastError: text('last_error'),
    syncedAt: timestamp('synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('package_payment_mappings_package_provider_key').on(t.packageId, t.provider),
    index('package_payment_mappings_bu_status_idx').on(t.businessUnitId, t.status),
  ],
);

export const catalogSyncJobs = pgTable(
  'catalog_sync_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessUnitId: uuid('business_unit_id')
      .notNull()
      .references(() => businessUnits.id, { onDelete: 'cascade' }),
    packageId: uuid('package_id')
      .notNull()
      .references(() => packages.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull().default('stripe'),
    status: catalogSyncStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('catalog_sync_jobs_package_provider_key').on(t.packageId, t.provider),
    index('catalog_sync_jobs_bu_status_idx').on(t.businessUnitId, t.status),
  ],
);

/* ---------------------------------- Orders ---------------------------------- */

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessUnitId: uuid('business_unit_id')
      .notNull()
      .references(() => businessUnits.id, { onDelete: 'cascade' }),
    orderNumber: text('order_number').notNull(),
    patientUserId: uuid('patient_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    packageId: uuid('package_id')
      .notNull()
      .references(() => packages.id, { onDelete: 'restrict' }),
    status: orderStatusEnum('status').notNull().default('pending_payment'),
    priceCents: integer('price_cents').notNull(),
    paymentStatus: paymentStatusEnum('payment_status').notNull().default('unpaid'),
    paymentReference: text('payment_reference'),
    packageSnapshot: jsonb('package_snapshot').$type<OrderPackageSnapshot>().notNull(),
    orderSource: text('order_source').notNull().default('native'),
    externalOrderId: text('external_order_id'),
    externalPaymentId: text('external_payment_id'),
    shippingAddress: jsonb('shipping_address').$type<Address>().notNull(),
    shippingMethod: shippingMethodEnum('shipping_method').notNull().default('ground'),
    /** The fulfillment partner's own order id, entered by them so both ends reconcile. */
    externalFulfillmentId: text('external_fulfillment_id'),
    requiresClinician: boolean('requires_clinician').notNull().default(false),
    resultsReleasedAt: timestamp('results_released_at', { withTimezone: true }),
    /** Seeded by the mock flow for round-robin testing; removable in one step. */
    isMock: boolean('is_mock').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('orders_order_number_key').on(t.orderNumber),
    uniqueIndex('orders_bu_source_external_key').on(
      t.businessUnitId,
      t.orderSource,
      t.externalOrderId,
    ),
    index('orders_bu_status_idx').on(t.businessUnitId, t.status),
    index('orders_patient_idx').on(t.patientUserId),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessUnitId: uuid('business_unit_id')
      .notNull()
      .references(() => businessUnits.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id'),
    checkoutSessionId: text('checkout_session_id'),
    checkoutAttempt: integer('checkout_attempt').notNull().default(1),
    paymentIntentId: text('payment_intent_id'),
    chargeId: text('charge_id'),
    status: text('status').notNull().default('pending'),
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull().default('usd'),
    refundedCents: integer('refunded_cents').notNull().default(0),
    disputedCents: integer('disputed_cents').notNull().default(0),
    failureCode: text('failure_code'),
    failureMessage: text('failure_message'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payments_order_provider_key').on(t.orderId, t.provider),
    uniqueIndex('payments_checkout_session_key').on(t.checkoutSessionId),
    index('payments_bu_status_idx').on(t.businessUnitId, t.status),
  ],
);

export const paymentEvents = pgTable(
  'payment_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessUnitId: uuid('business_unit_id')
      .notNull()
      .references(() => businessUnits.id, { onDelete: 'cascade' }),
    paymentId: uuid('payment_id').references(() => payments.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    eventType: text('event_type').notNull(),
    livemode: boolean('livemode').notNull().default(false),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('payment_events_provider_event_key').on(t.provider, t.providerEventId)],
);

export const kits = pgTable(
  'kits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessUnitId: uuid('business_unit_id')
      .notNull()
      .references(() => businessUnits.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    testTypeId: uuid('test_type_id')
      .notNull()
      .references(() => testTypes.id, { onDelete: 'restrict' }),
    kitNumber: integer('kit_number').notNull(),
    /** Opaque 128-bit token printed on the QR sticker. Never a sequential identifier. */
    qrToken: text('qr_token').notNull(),
    /**
     * Human-readable `QK-XXXX-XXXX` printed under the QR code for manual entry. It only locates a
     * kit; access still requires membership in its business unit (and ownership, for patients).
     */
    serial: text('serial').notNull(),
    status: kitStatusEnum('status').notNull().default('awaiting_fulfillment'),
    externalKitId: text('external_kit_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('kits_qr_token_key').on(t.qrToken),
    uniqueIndex('kits_serial_key').on(t.serial),
    uniqueIndex('kits_order_number_key').on(t.orderId, t.kitNumber),
    index('kits_bu_status_idx').on(t.businessUnitId, t.status),
  ],
);

export const shipments = pgTable(
  'shipments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessUnitId: uuid('business_unit_id')
      .notNull()
      .references(() => businessUnits.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    direction: shipmentDirectionEnum('direction').notNull(),
    carrier: text('carrier'),
    trackingNumber: text('tracking_number'),
    toAddress: jsonb('to_address').$type<Address>(),
    shippedAt: timestamp('shipped_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('shipments_order_idx').on(t.orderId, t.direction)],
);

/** Append-only audit trail. Every status change writes exactly one row. */
export const orderEvents = pgTable(
  'order_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventSequence: bigserial('event_sequence', { mode: 'number' }).notNull(),
    businessUnitId: uuid('business_unit_id')
      .notNull()
      .references(() => businessUnits.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    kitId: uuid('kit_id').references(() => kits.id, { onDelete: 'set null' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorRole: actorRoleEnum('actor_role').notNull(),
    fromStatus: orderStatusEnum('from_status'),
    toStatus: orderStatusEnum('to_status'),
    message: text('message').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('order_events_order_idx').on(t.orderId, t.eventSequence)],
);

export const orderIssues = pgTable(
  'order_issues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessUnitId: uuid('business_unit_id')
      .notNull()
      .references(() => businessUnits.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    reportedByUserId: uuid('reported_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    reason: orderIssueReasonEnum('reason').notNull(),
    detail: text('detail'),
    status: issueStatusEnum('status').notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [index('order_issues_order_idx').on(t.orderId, t.status)],
);

/* ---------------------------------- Results ---------------------------------- */

/** Metadata only. Bytes live outside the web root under STORAGE_LOCAL_PATH (S3 later). */
export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessUnitId: uuid('business_unit_id')
      .notNull()
      .references(() => businessUnits.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull(),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('files_storage_key_key').on(t.storageKey)],
);

/** Cached text of a lab PDF so later chat turns do not re-run OCR. */
export const fileExtractions = pgTable(
  'file_extractions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessUnitId: uuid('business_unit_id')
      .notNull()
      .references(() => businessUnits.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    extractedText: text('extracted_text').notNull(),
    method: fileExtractionMethodEnum('method').notNull(),
    pageCount: integer('page_count').notNull().default(1),
    charCount: integer('char_count').notNull().default(0),
    extractedAt: timestamp('extracted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('file_extractions_file_key').on(t.fileId),
    index('file_extractions_bu_idx').on(t.businessUnitId),
  ],
);

export const labResults = pgTable(
  'lab_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessUnitId: uuid('business_unit_id')
      .notNull()
      .references(() => businessUnits.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    kitId: uuid('kit_id')
      .notNull()
      .references(() => kits.id, { onDelete: 'cascade' }),
    labUserId: uuid('lab_user_id').references(() => users.id, { onDelete: 'set null' }),
    fileId: uuid('file_id').references(() => files.id, { onDelete: 'set null' }),
    summary: text('summary'),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('lab_results_kit_key').on(t.kitId),
    index('lab_results_order_idx').on(t.orderId),
  ],
);

export const clinicianReviews = pgTable(
  'clinician_reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessUnitId: uuid('business_unit_id')
      .notNull()
      .references(() => businessUnits.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    doctorUserId: uuid('doctor_user_id').references(() => users.id, { onDelete: 'set null' }),
    decision: clinicianDecisionEnum('decision'),
    interpretation: text('interpretation'),
    recommendations: text('recommendations'),
    /** Optional AI first pass the doctor reviews rather than authors from scratch. */
    aiDraft: text('ai_draft'),
    aiModel: text('ai_model'),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('clinician_reviews_order_key').on(t.orderId),
    index('clinician_reviews_bu_pending_idx').on(t.businessUnitId, t.decidedAt),
  ],
);

/* ------------------------------------ Ops ------------------------------------ */

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessUnitId: uuid('business_unit_id')
      .notNull()
      .references(() => businessUnits.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    linkPath: text('link_path'),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'cascade' }),
    readAt: timestamp('read_at', { withTimezone: true }),
    emailSentAt: timestamp('email_sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.readAt)],
);

export const fulfillmentAccounts = pgTable(
  'fulfillment_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessUnitId: uuid('business_unit_id')
      .notNull()
      .references(() => businessUnits.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountName: text('account_name').notNull(),
    accountType: payoutAccountTypeEnum('account_type').notNull().default('invoice'),
    accountReference: text('account_reference').notNull(),
    billingEmail: text('billing_email').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('fulfillment_accounts_user_key').on(t.businessUnitId, t.userId)],
);

/** One row per shipped order so fulfillment cost can be reconciled in batches. */
export const fulfillmentCharges = pgTable(
  'fulfillment_charges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessUnitId: uuid('business_unit_id')
      .notNull()
      .references(() => businessUnits.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    fulfillmentUserId: uuid('fulfillment_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    fulfillmentAccountId: uuid('fulfillment_account_id').references(() => fulfillmentAccounts.id, {
      onDelete: 'set null',
    }),
    amountCents: integer('amount_cents').notNull(),
    status: chargeStatusEnum('status').notNull().default('pending'),
    batchReference: text('batch_reference'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('fulfillment_charges_order_key').on(t.orderId),
    index('fulfillment_charges_user_idx').on(t.businessUnitId, t.fulfillmentUserId),
    index('fulfillment_charges_batch_idx').on(t.businessUnitId, t.status),
  ],
);

/* ------------------------------------ AI ------------------------------------ */

export const platformAiSettings = pgTable('platform_ai_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  railsPrompt: text('rails_prompt').notNull().default(''),
  disclaimer: text('disclaimer').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const platformLlmProviders = pgTable(
  'platform_llm_providers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    apiUrl: text('api_url').notNull(),
    apiKeyCiphertext: text('api_key_ciphertext').notNull().default(''),
    model: text('model').notNull(),
    customHeaders: jsonb('custom_headers').$type<Array<{ name: string; value: string }>>().notNull().default([]),
    inputTokenCostPerMillion: numeric('input_token_cost_per_million', {
      precision: 12,
      scale: 6,
    })
      .notNull()
      .default('0'),
    outputTokenCostPerMillion: numeric('output_token_cost_per_million', {
      precision: 12,
      scale: 6,
    })
      .notNull()
      .default('0'),
    maxOutputTokens: integer('max_output_tokens').notNull().default(1024),
    sortOrder: integer('sort_order').notNull().default(0),
    enabled: boolean('enabled').notNull().default(true),
    /** A platform admin attests a BAA is on file; production PHI chat only uses approved rows. */
    phiApproved: boolean('phi_approved').notNull().default(false),
    phiApprovedAt: timestamp('phi_approved_at', { withTimezone: true }),
    phiApprovalNote: text('phi_approval_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('platform_llm_providers_sort_idx').on(t.sortOrder)],
);

export const businessUnitAiSettings = pgTable(
  'business_unit_ai_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessUnitId: uuid('business_unit_id')
      .notNull()
      .references(() => businessUnits.id, { onDelete: 'cascade' }),
    railsPrompt: text('rails_prompt').notNull().default(''),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('business_unit_ai_settings_bu_key').on(t.businessUnitId)],
);

export const reportConversations = pgTable(
  'report_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessUnitId: uuid('business_unit_id')
      .notNull()
      .references(() => businessUnits.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    patientUserId: uuid('patient_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('report_conversations_order_key').on(t.orderId),
    index('report_conversations_patient_idx').on(t.patientUserId),
  ],
);

export const reportMessages = pgTable(
  'report_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessUnitId: uuid('business_unit_id')
      .notNull()
      .references(() => businessUnits.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => reportConversations.id, { onDelete: 'cascade' }),
    role: reportMessageRoleEnum('role').notNull(),
    content: text('content').notNull(),
    providerId: uuid('provider_id').references(() => platformLlmProviders.id, {
      onDelete: 'set null',
    }),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('report_messages_conversation_idx').on(t.conversationId, t.createdAt)],
);

export const patientLlmUsage = pgTable(
  'patient_llm_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessUnitId: uuid('business_unit_id')
      .notNull()
      .references(() => businessUnits.id, { onDelete: 'cascade' }),
    patientUserId: uuid('patient_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    estimatedCostUsd: numeric('estimated_cost_usd', { precision: 14, scale: 8 })
      .notNull()
      .default('0'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('patient_llm_usage_patient_key').on(t.businessUnitId, t.patientUserId)],
);

/**
 * Append-only record of who opened which PHI. Intentionally no foreign keys: the trail must
 * outlive the rows it describes. UPDATE/DELETE are blocked by a trigger and revoked from nio_app.
 */
export const phiAccessEvents = pgTable(
  'phi_access_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessUnitId: uuid('business_unit_id').notNull(),
    actorUserId: uuid('actor_user_id'),
    actorRole: text('actor_role').notNull(),
    actingPlatformAdmin: boolean('acting_platform_admin').notNull().default(false),
    resourceType: phiResourceTypeEnum('resource_type').notNull(),
    resourceId: uuid('resource_id'),
    orderId: uuid('order_id'),
    action: phiAccessActionEnum('action').notNull(),
    requestId: text('request_id'),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('phi_access_events_bu_order_idx').on(t.businessUnitId, t.orderId, t.createdAt),
    index('phi_access_events_actor_idx').on(t.businessUnitId, t.actorUserId, t.createdAt),
  ],
);

/* --------------------------------- Relations --------------------------------- */

export const businessUnitsRelations = relations(businessUnits, ({ many }) => ({
  memberships: many(memberships),
  packages: many(packages),
  testTypes: many(testTypes),
  orders: many(orders),
}));

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(memberships),
  orders: many(orders),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  user: one(users, { fields: [memberships.userId], references: [users.id] }),
  businessUnit: one(businessUnits, {
    fields: [memberships.businessUnitId],
    references: [businessUnits.id],
  }),
}));

export const packagesRelations = relations(packages, ({ one, many }) => ({
  businessUnit: one(businessUnits, {
    fields: [packages.businessUnitId],
    references: [businessUnits.id],
  }),
  tests: many(packageTestTypes),
}));

export const packageTestTypesRelations = relations(packageTestTypes, ({ one }) => ({
  package: one(packages, { fields: [packageTestTypes.packageId], references: [packages.id] }),
  testType: one(testTypes, { fields: [packageTestTypes.testTypeId], references: [testTypes.id] }),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  businessUnit: one(businessUnits, {
    fields: [orders.businessUnitId],
    references: [businessUnits.id],
  }),
  patient: one(users, { fields: [orders.patientUserId], references: [users.id] }),
  package: one(packages, { fields: [orders.packageId], references: [packages.id] }),
  kits: many(kits),
  shipments: many(shipments),
  events: many(orderEvents),
  issues: many(orderIssues),
  labResults: many(labResults),
}));

export const kitsRelations = relations(kits, ({ one }) => ({
  order: one(orders, { fields: [kits.orderId], references: [orders.id] }),
  testType: one(testTypes, { fields: [kits.testTypeId], references: [testTypes.id] }),
}));

export const labResultsRelations = relations(labResults, ({ one }) => ({
  order: one(orders, { fields: [labResults.orderId], references: [orders.id] }),
  kit: one(kits, { fields: [labResults.kitId], references: [kits.id] }),
  file: one(files, { fields: [labResults.fileId], references: [files.id] }),
}));

export const clinicianReviewsRelations = relations(clinicianReviews, ({ one }) => ({
  order: one(orders, { fields: [clinicianReviews.orderId], references: [orders.id] }),
  doctor: one(users, { fields: [clinicianReviews.doctorUserId], references: [users.id] }),
}));
