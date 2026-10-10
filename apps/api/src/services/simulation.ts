import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { OrderStatus } from '@nio/shared';
import { withPlatformScope, withTenant, type Tx } from '../db/client.js';
import {
  files,
  kits,
  labResults,
  memberships,
  orders,
  packageTestTypes,
  packages,
  shipments,
  testTypes,
  users,
} from '../db/schema.js';
import { env } from '../env.js';
import { forbidden } from '../lib/errors.js';
import { generateOrderNumber, generateStorageKey } from '../lib/ids.js';
import { dispatchPaidOrder } from './paidOrder.js';
import {
  recordEvent,
  routeAfterLabCompletion,
  setKitStatus,
  syncOrderFromKits,
  type WorkflowActor,
} from './orderWorkflow.js';
import { storage } from './storage.js';

/** Where a seeded order stops. Each is the first stage a given queue acts on. */
const STAGES = [
  { stop: 'dispatched_to_fulfillment', clinician: true, queue: 'Fulfillment: ship the kit' },
  { stop: 'kit_shipped', clinician: true, queue: 'Patient: confirm the kit arrived' },
  { stop: 'kit_received_by_patient', clinician: true, queue: 'Patient: send the sample' },
  { stop: 'sample_in_transit', clinician: true, queue: 'Lab: check the sample in' },
  { stop: 'received_by_lab', clinician: true, queue: 'Lab: start analysis' },
  { stop: 'lab_processing', clinician: true, queue: 'Lab: upload results and complete' },
  { stop: 'awaiting_clinician_review', clinician: true, queue: 'Doctor: review results' },
  { stop: 'results_released', clinician: false, queue: 'Patient: read released results' },
] as const satisfies ReadonlyArray<{ stop: OrderStatus; clinician: boolean; queue: string }>;

type Stage = (typeof STAGES)[number]['stop'];

const MOCK_REFERENCE = { clinician: 'QINIO-MOCK-DOCTOR', direct: 'QINIO-MOCK-DIRECT' } as const;

const MOCK_ADDRESS = {
  line1: '100 Simulation Way',
  city: 'Testville',
  region: 'CA',
  postalCode: '94000',
  country: 'US',
};

/** A one-page PDF so the doctor and patient result viewers have something real to open. */
const PLACEHOLDER_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R' +
    '/Resources<</Font<</F1 5 0 R>>>>>>endobj\n' +
    '4 0 obj<</Length 62>>stream\nBT /F1 18 Tf 72 720 Td (Qinio MOCK result - not real data) Tj ET\n' +
    'endstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
);

export function assertSimulationEnabled(): void {
  if (!env.SIMULATION_ENABLED) {
    throw forbidden('The mock flow is disabled in this environment (SIMULATION_ENABLED=false)');
  }
}

export interface SimulationOperator {
  businessUnitId: string;
  businessUnitSlug: string;
  userId: string;
  actingAsPlatformAdmin: string | null;
}

function operatorScope(operator: SimulationOperator) {
  return {
    businessUnitId: operator.businessUnitId,
    userId: operator.userId,
    actorRole: 'system' as const,
    actingAsPlatformAdmin: operator.actingAsPlatformAdmin,
  };
}

export interface SeedResult {
  orders: Array<{ orderNumber: string; status: Stage; queue: string; patient: string }>;
}

/**
 * Seeds one order at the start of every queue, each driven through the real workflow helpers so
 * its event trail and kit states look exactly like a genuine order's. The operator also gets an
 * order of their own so "Patient view" has something to act on.
 */
export async function seedMockFlow(operator: SimulationOperator): Promise<SeedResult> {
  assertSimulationEnabled();

  const resultKey = generateStorageKey(operator.businessUnitId, 'mock-result.pdf');
  await storage.put(resultKey, PLACEHOLDER_PDF);

  return withTenant(
    operatorScope(operator),
    async (tx) => {
      const packageIds = await ensureMockPackages(tx, operator.businessUnitId);
      const [file] = await tx
        .insert(files)
        .values({
          businessUnitId: operator.businessUnitId,
          storageKey: resultKey,
          filename: 'mock-result.pdf',
          mimeType: 'application/pdf',
          sizeBytes: PLACEHOLDER_PDF.byteLength,
          uploadedByUserId: operator.userId,
        })
        .returning({ id: files.id });

      const run = Date.now().toString(36);
      const seeded: SeedResult['orders'] = [];
      for (const [index, stage] of STAGES.entries()) {
        const patient = await ensureMockPatient(tx, operator, `${run}-${index + 1}`);
        const order = await driveOrder(tx, operator, {
          patientUserId: patient.id,
          packageId: stage.clinician ? packageIds.clinician : packageIds.direct,
          stop: stage.stop,
          fileId: file!.id,
        });
        seeded.push({ orderNumber: order, status: stage.stop, queue: stage.queue, patient: patient.name });
      }

      for (const stop of ['kit_shipped', 'results_released'] as const) {
        const order = await driveOrder(tx, operator, {
          patientUserId: operator.userId,
          packageId: stop === 'results_released' ? packageIds.direct : packageIds.clinician,
          stop,
          fileId: file!.id,
        });
        seeded.push({
          orderNumber: order,
          status: stop,
          queue: 'Your own patient view',
          patient: 'You',
        });
      }

      return { orders: seeded };
    },
  );
}

/** Removes every mock order and anything only they used: results, mock patients, mock packages. */
export async function clearMockFlow(operator: SimulationOperator): Promise<{ removedOrders: number }> {
  assertSimulationEnabled();

  return withTenant(
    operatorScope(operator),
    async (tx) => {
      const mockOrders = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(eq(orders.isMock, true));
      const orderIds = mockOrders.map((order) => order.id);

      const resultFiles = orderIds.length
        ? await tx
            .select({ fileId: labResults.fileId })
            .from(labResults)
            .where(and(inArray(labResults.orderId, orderIds), isNotNull(labResults.fileId)))
        : [];

      if (orderIds.length) await tx.delete(orders).where(inArray(orders.id, orderIds));

      const fileIds = [...new Set(resultFiles.map((row) => row.fileId!))];
      if (fileIds.length) await tx.delete(files).where(inArray(files.id, fileIds));

      await tx
        .delete(packages)
        .where(
          inArray(packages.internalReference, [MOCK_REFERENCE.clinician, MOCK_REFERENCE.direct]),
        );

      const mockPatients = await tx
        .select({ userId: memberships.userId })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(users.isMock, true));
      const mockUserIds = [...new Set(mockPatients.map((row) => row.userId))];
      if (mockUserIds.length) {
        await tx.delete(memberships).where(inArray(memberships.userId, mockUserIds));
      }

      return { removedOrders: orderIds.length, mockUserIds };
    },
  ).then(async ({ removedOrders, mockUserIds }) => {
    if (mockUserIds.length) await deleteOrphanMockUsers(mockUserIds);
    return { removedOrders };
  });
}

/** `users` is platform-wide, so orphaned mock patients are removed outside the tenant scope. */
async function deleteOrphanMockUsers(userIds: string[]): Promise<void> {
  await withPlatformScope(async (tx) => {
    for (const userId of userIds) {
      const [stillMember] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(eq(memberships.userId, userId))
        .limit(1);
      const [stillOrdering] = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(eq(orders.patientUserId, userId))
        .limit(1);
      if (!stillMember && !stillOrdering) {
        await tx.delete(users).where(and(eq(users.id, userId), eq(users.isMock, true)));
      }
    }
  });
}

async function ensureMockPackages(
  tx: Tx,
  businessUnitId: string,
): Promise<{ clinician: string; direct: string }> {
  let [testType] = await tx
    .select({ id: testTypes.id })
    .from(testTypes)
    .where(eq(testTypes.isActive, true))
    .limit(1);
  if (!testType) {
    [testType] = await tx
      .insert(testTypes)
      .values({ businessUnitId, name: 'Mock blood panel', sampleType: 'blood', turnaroundDays: 3 })
      .returning({ id: testTypes.id });
  }

  const ensure = async (reference: string, requiresClinician: boolean) => {
    const [existing] = await tx
      .select({ id: packages.id })
      .from(packages)
      .where(eq(packages.internalReference, reference))
      .limit(1);
    if (existing) return existing.id;
    // Draft keeps mock packages off the public storefront.
    const [created] = await tx
      .insert(packages)
      .values({
        businessUnitId,
        name: requiresClinician ? '[Mock] Doctor-reviewed panel' : '[Mock] Direct-results panel',
        description: 'Created by the mock flow. Removed by "Clear mock data".',
        internalReference: reference,
        priceCents: 9900,
        requiresClinician,
        status: 'draft',
      })
      .returning({ id: packages.id });
    await tx
      .insert(packageTestTypes)
      .values({ packageId: created!.id, testTypeId: testType!.id, quantity: 1 });
    return created!.id;
  };

  return {
    clinician: await ensure(MOCK_REFERENCE.clinician, true),
    direct: await ensure(MOCK_REFERENCE.direct, false),
  };
}

async function ensureMockPatient(tx: Tx, operator: SimulationOperator, suffix: string) {
  const name = `Mock Patient ${suffix}`;
  const email = `mock+${operator.businessUnitSlug}-${suffix}@qinio.invalid`;
  const [user] = await tx
    .insert(users)
    .values({ email, name, status: 'active', isMock: true })
    .returning({ id: users.id, name: users.name });
  await tx
    .insert(memberships)
    .values({ userId: user!.id, businessUnitId: operator.businessUnitId, role: 'patient' })
    .onConflictDoNothing();
  return user!;
}

const ORDER_PROGRESSION: OrderStatus[] = [
  'dispatched_to_fulfillment',
  'kit_shipped',
  'kit_received_by_patient',
  'sample_in_transit',
  'received_by_lab',
  'lab_processing',
  'awaiting_clinician_review',
];

/** Creates one mock order and walks it forward, step by step, until it reaches `stop`. */
async function driveOrder(
  tx: Tx,
  operator: SimulationOperator,
  input: { patientUserId: string; packageId: string; stop: Stage; fileId: string },
): Promise<string> {
  const businessUnitId = operator.businessUnitId;
  const as = (actorRole: WorkflowActor['actorRole'], actorUserId: string): WorkflowActor => ({
    businessUnitId,
    actorRole,
    actorUserId,
  });
  const patient = as('patient', input.patientUserId);
  const fulfillment = as('fulfillment', operator.userId);
  const lab = as('lab', operator.userId);
  const reached = (status: OrderStatus) =>
    input.stop === 'results_released' ||
    ORDER_PROGRESSION.indexOf(input.stop) >= ORDER_PROGRESSION.indexOf(status);

  const [pkg] = await tx.select().from(packages).where(eq(packages.id, input.packageId)).limit(1);
  const composition = await tx
    .select({
      testTypeId: testTypes.id,
      name: testTypes.name,
      sampleType: testTypes.sampleType,
      turnaroundDays: testTypes.turnaroundDays,
      quantity: packageTestTypes.quantity,
    })
    .from(packageTestTypes)
    .innerJoin(testTypes, eq(testTypes.id, packageTestTypes.testTypeId))
    .where(eq(packageTestTypes.packageId, pkg!.id));

  const [order] = await tx
    .insert(orders)
    .values({
      businessUnitId,
      orderNumber: generateOrderNumber(),
      patientUserId: input.patientUserId,
      packageId: pkg!.id,
      status: 'pending_payment',
      priceCents: pkg!.priceCents,
      paymentStatus: 'unpaid',
      packageSnapshot: {
        packageName: pkg!.name,
        packageVersion: pkg!.version,
        priceCents: pkg!.priceCents,
        requiresClinician: pkg!.requiresClinician,
        internalReference: pkg!.internalReference,
        externalProductId: pkg!.externalProductId,
        tests: composition,
      },
      shippingAddress: MOCK_ADDRESS,
      shippingMethod: 'ground',
      requiresClinician: pkg!.requiresClinician,
      orderSource: 'mock',
      isMock: true,
    })
    .returning();
  const orderId = order!.id;

  await recordEvent(tx, {
    businessUnitId,
    orderId,
    actorUserId: input.patientUserId,
    actorRole: 'patient',
    toStatus: 'pending_payment',
    message: `Mock order placed for ${pkg!.name}`,
  });

  // Notification intents are discarded on purpose: mock orders never email anyone.
  await dispatchPaidOrder(tx, {
    businessUnitId,
    order: order!,
    paymentReference: `mock-${order!.orderNumber}`,
    actorRole: 'patient',
    actorUserId: input.patientUserId,
  });
  const kitIds = (
    await tx.select({ id: kits.id }).from(kits).where(eq(kits.orderId, orderId))
  ).map((kit) => kit.id);

  const advanceKits = async (
    actor: WorkflowActor,
    status: Parameters<typeof setKitStatus>[3],
    message: string,
  ) => {
    for (const kitId of kitIds) await setKitStatus(tx, actor, kitId, status);
    await syncOrderFromKits(tx, actor, orderId, message);
  };

  if (!reached('kit_shipped')) return order!.orderNumber;
  await tx.insert(shipments).values({
    businessUnitId,
    orderId,
    direction: 'outbound_to_patient',
    carrier: 'MockPost',
    trackingNumber: `MOCK${order!.orderNumber}`,
    toAddress: MOCK_ADDRESS,
    shippedAt: new Date(),
  });
  await advanceKits(fulfillment, 'shipped', 'Kit shipped via MockPost');

  if (!reached('kit_received_by_patient')) return order!.orderNumber;
  await advanceKits(patient, 'received_by_patient', 'All kits received by patient');

  if (!reached('sample_in_transit')) return order!.orderNumber;
  await tx.insert(shipments).values({
    businessUnitId,
    orderId,
    direction: 'inbound_to_lab',
    shippedAt: new Date(),
  });
  await advanceKits(patient, 'sample_in_transit', 'All samples are in transit to the lab');

  if (!reached('received_by_lab')) return order!.orderNumber;
  for (const kitId of kitIds) {
    await tx.insert(labResults).values({
      businessUnitId,
      orderId,
      kitId,
      labUserId: operator.userId,
      receivedAt: new Date(),
    });
  }
  await advanceKits(lab, 'received_by_lab', 'All samples received by the lab');

  if (!reached('lab_processing')) return order!.orderNumber;
  await advanceKits(lab, 'processing', 'Lab analysis under way');

  if (!reached('awaiting_clinician_review')) return order!.orderNumber;
  await tx
    .update(labResults)
    .set({
      fileId: input.fileId,
      summary: 'Mock result: all markers within reference range.',
      completedAt: new Date(),
    })
    .where(eq(labResults.orderId, orderId));
  await advanceKits(lab, 'lab_complete', 'Lab analysis complete for all kits');
  await routeAfterLabCompletion(tx, businessUnitId, orderId);

  return order!.orderNumber;
}
