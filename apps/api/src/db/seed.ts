import { eq, and } from 'drizzle-orm';
import type { Address, MembershipRole } from '@nio/shared';
import { env } from '../env.js';
import { closeDb, withPlatformScope } from './client.js';
import {
  businessUnits,
  marketingPages,
  memberships,
  packageTestTypes,
  packages,
  platformAdmins,
  testTypes,
  users,
} from './schema.js';
import type { Tx } from './client.js';

const LAB_ADDRESS: Address = {
  line1: '2100 Analyte Way',
  line2: 'Receiving Dock B',
  city: 'Austin',
  region: 'TX',
  postalCode: '78701',
  country: 'US',
};

interface SeedMember {
  email: string;
  name: string;
  role: MembershipRole;
}

interface SeedBusinessUnit {
  name: string;
  slug: string;
  labName: string;
  headline: string;
  members: SeedMember[];
}

const BUSINESS_UNITS: SeedBusinessUnit[] = [
  {
    name: 'Vitality Health',
    slug: 'vitality',
    labName: 'Vitality Reference Laboratory',
    headline: 'Metabolic health testing, read by real clinicians.',
    members: [
      { email: 'admin@vitality.test', name: 'Val Ortiz', role: 'bu_admin' },
      { email: 'fulfillment@vitality.test', name: 'Fran Delgado', role: 'fulfillment' },
      { email: 'lab@vitality.test', name: 'Lena Park', role: 'lab' },
      { email: 'doctor@vitality.test', name: 'Dr. Dana Reyes', role: 'doctor' },
      { email: 'patient@vitality.test', name: 'Pat Nguyen', role: 'patient' },
    ],
  },
  {
    // A second tenant exists so cross-tenant isolation is exercised rather than assumed.
    name: 'Metabolic Co',
    slug: 'metabolic',
    labName: 'Metabolic Co Labs',
    headline: 'Know your baseline.',
    members: [
      { email: 'admin@metabolic.test', name: 'Morgan Vale', role: 'bu_admin' },
      { email: 'lab@metabolic.test', name: 'Leo Sun', role: 'lab' },
      { email: 'patient@metabolic.test', name: 'Perry Adams', role: 'patient' },
    ],
  },
];

async function upsertUser(tx: Tx, email: string, name: string) {
  const [user] = await tx
    .insert(users)
    .values({ email, name, auth0UserId: `dev|${email}`, status: 'active' })
    .onConflictDoUpdate({ target: users.email, set: { name } })
    .returning();
  return user!;
}

async function seedBusinessUnit(tx: Tx, definition: SeedBusinessUnit) {
  const [businessUnit] = await tx
    .insert(businessUnits)
    .values({
      name: definition.name,
      slug: definition.slug,
      auth0OrgId: `org_dev_${definition.slug}`,
      status: 'active',
      labName: definition.labName,
      labReturnAddress: LAB_ADDRESS,
    })
    .onConflictDoUpdate({
      target: businessUnits.slug,
      set: {
        name: definition.name,
        labName: definition.labName,
        labReturnAddress: LAB_ADDRESS,
        updatedAt: new Date(),
      },
    })
    .returning();

  const buId = businessUnit!.id;

  for (const member of definition.members) {
    const user = await upsertUser(tx, member.email, member.name);
    await tx
      .insert(memberships)
      .values({ userId: user.id, businessUnitId: buId, role: member.role })
      .onConflictDoNothing();
  }

  const [existingPage] = await tx
    .select({ id: marketingPages.id })
    .from(marketingPages)
    .where(eq(marketingPages.businessUnitId, buId))
    .limit(1);

  if (!existingPage) {
    await tx.insert(marketingPages).values({
      businessUnitId: buId,
      version: 1,
      title: `${definition.name} — At-home testing`,
      headline: definition.headline,
      bodyHtml: `<section><h2>${definition.headline}</h2><p>Order a kit, mail your sample, and get results you can act on.</p></section>`,
      isPublished: true,
    });
  }

  return buId;
}

async function seedCatalog(tx: Tx, businessUnitId: string, slug: string) {
  const [existing] = await tx
    .select({ id: packages.id })
    .from(packages)
    .where(eq(packages.businessUnitId, businessUnitId))
    .limit(1);
  if (existing) return;

  const [metabolic] = await tx
    .insert(testTypes)
    .values({
      businessUnitId,
      name: 'Metabolic Panel',
      description: 'Fasting glucose, HbA1c, insulin and lipid fractions.',
      sampleType: 'blood',
      turnaroundDays: 5,
    })
    .returning();

  const [hormone] = await tx
    .insert(testTypes)
    .values({
      businessUnitId,
      name: 'Hormone Panel',
      description: 'Thyroid, cortisol and sex hormone markers.',
      sampleType: 'blood',
      turnaroundDays: 7,
    })
    .returning();

  // Requires a clinician: results stop in the doctor queue before the patient sees them.
  const [reviewed] = await tx
    .insert(packages)
    .values({
      businessUnitId,
      name: 'Metabolic Reset Program',
      description: 'Two-panel workup reviewed by a clinician before you are cleared to start.',
      focusArea: 'metabolic health',
      priceCents: 34900,
      requiresClinician: true,
      status: 'active',
    })
    .returning();

  await tx.insert(packageTestTypes).values([
    { packageId: reviewed!.id, testTypeId: metabolic!.id, quantity: 1 },
    { packageId: reviewed!.id, testTypeId: hormone!.id, quantity: 1 },
  ]);

  // No clinician: raw results go straight back to the patient dashboard.
  const [direct] = await tx
    .insert(packages)
    .values({
      businessUnitId,
      name: 'Baseline Metabolic Check',
      description: 'A single panel with raw results delivered straight to your dashboard.',
      focusArea: 'general wellness',
      priceCents: 12900,
      requiresClinician: false,
      status: 'active',
    })
    .returning();

  await tx
    .insert(packageTestTypes)
    .values([{ packageId: direct!.id, testTypeId: metabolic!.id, quantity: 1 }]);

  console.log(`  catalog seeded for ${slug}`);
}

async function main() {
  await withPlatformScope(async (tx) => {
    const [admin] = await tx
      .insert(platformAdmins)
      .values({ email: env.PLATFORM_ADMIN_EMAIL, name: 'Platform Superadmin', isActive: true })
      .onConflictDoUpdate({ target: platformAdmins.email, set: { isActive: true } })
      .returning();

    console.log(`Platform admin: ${admin!.email}`);

    for (const definition of BUSINESS_UNITS) {
      const businessUnitId = await seedBusinessUnit(tx, definition);
      await seedCatalog(tx, businessUnitId, definition.slug);
      console.log(`Business unit: ${definition.name} (/${definition.slug})`);
    }

    // Cross-tenant membership: proves one human can hold roles in more than one business unit.
    const [multiTenantUser] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'lab@vitality.test'))
      .limit(1);
    const [metabolicBu] = await tx
      .select({ id: businessUnits.id })
      .from(businessUnits)
      .where(eq(businessUnits.slug, 'metabolic'))
      .limit(1);

    if (multiTenantUser && metabolicBu) {
      const [already] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, multiTenantUser.id),
            eq(memberships.businessUnitId, metabolicBu.id),
          ),
        )
        .limit(1);
      if (!already) {
        await tx.insert(memberships).values({
          userId: multiTenantUser.id,
          businessUnitId: metabolicBu.id,
          role: 'doctor',
        });
      }
    }
  });

  console.log('\nSeed complete. Log in from the dev login screen with any of:');
  console.log(`  ${env.PLATFORM_ADMIN_EMAIL} (platform superadmin)`);
  for (const bu of BUSINESS_UNITS) {
    for (const member of bu.members) {
      console.log(`  ${member.email} (${member.role} @ ${bu.slug})`);
    }
  }
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
