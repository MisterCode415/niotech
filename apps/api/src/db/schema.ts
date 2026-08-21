import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
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
export const paymentStatusEnum = pgEnum('payment_status', ['unpaid', 'paid', 'refunded', 'failed']);
export const packageStatusEnum = pgEnum('package_status', ['draft', 'active', 'archived']);
export const shipmentDirectionEnum = pgEnum('shipment_direction', [
  'outbound_to_patient',
  'inbound_to_lab',
]);
export const issueStatusEnum = pgEnum('issue_status', ['open', 'resolved']);
export const chargeStatusEnum = pgEnum('charge_status', ['pending', 'batched', 'paid']);
export const payoutAccountTypeEnum = pgEnum('payout_account_type', ['ach', 'wire', 'invoice']);

/* --------------------------------- Platform --------------------------------- */

/**
 * The alpha superuser table. Membership here is a manual database insert by design: it is the
 * root of trust for the whole platform, so nothing in the application can grant it.
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
    priceCents: integer('price_cents').notNull(),
    /** Drives the branch after lab completion: doctor queue vs. straight to the patient. */
    requiresClinician: boolean('requires_clinician').notNull().default(false),
    status: packageStatusEnum('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('packages_bu_status_idx').on(t.businessUnitId, t.status)],
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
    shippingAddress: jsonb('shipping_address').$type<Address>().notNull(),
    shippingMethod: shippingMethodEnum('shipping_method').notNull().default('ground'),
    /** The fulfillment partner's own order id, entered by them so both ends reconcile. */
    externalFulfillmentId: text('external_fulfillment_id'),
    requiresClinician: boolean('requires_clinician').notNull().default(false),
    resultsReleasedAt: timestamp('results_released_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('orders_order_number_key').on(t.orderNumber),
    index('orders_bu_status_idx').on(t.businessUnitId, t.status),
    index('orders_patient_idx').on(t.patientUserId),
  ],
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
    status: kitStatusEnum('status').notNull().default('awaiting_fulfillment'),
    externalKitId: text('external_kit_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('kits_qr_token_key').on(t.qrToken),
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
  (t) => [index('order_events_order_idx').on(t.orderId, t.createdAt)],
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
    index('fulfillment_charges_batch_idx').on(t.businessUnitId, t.status),
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
