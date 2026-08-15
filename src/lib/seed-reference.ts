import { prisma } from "@/lib/db";
import { RUBRIC, THEMES, RULES, FIELD_MAPPINGS } from "@/lib/reference-data";
import { defaultPolicies } from "@/lib/provenance/policy";
import { getSystemActor, SYSTEM_ACTORS } from "@/lib/provenance/actors";

/**
 * Idempotent. Safe to run on every boot and after every migration — upserts
 * rather than inserts, so an operator who has edited a rule in the UI does not
 * lose that edit the next time this runs.
 */
export async function seedReferenceData(): Promise<void> {
  for (const dim of RUBRIC) {
    await prisma.rubricDimension.upsert({
      where: { slug: dim.slug },
      create: dim,
      update: {
        label: dim.label,
        description: dim.description,
        weight: dim.weight,
        sortOrder: dim.sortOrder,
      },
    });
  }

  for (const theme of THEMES) {
    await prisma.theme.upsert({
      where: { slug: theme.slug },
      create: theme,
      update: {
        label: theme.label,
        description: theme.description,
        category: theme.category,
        sortOrder: theme.sortOrder,
      },
    });
  }

  // Rules have generated ids, so match on name to stay idempotent. Existing
  // rules are left alone: an operator may have tuned the pattern deliberately.
  for (const rule of RULES) {
    const existing = await prisma.rule.findFirst({ where: { name: rule.name } });
    if (!existing) {
      await prisma.rule.create({ data: rule });
    }
  }

  for (const policy of defaultPolicies()) {
    await prisma.autonomyPolicy.upsert({
      where: { actionType: policy.actionType },
      create: policy,
      // Never overwrite a decision an admin has deliberately loosened.
      update: { customerFacing: policy.customerFacing },
    });
  }

  for (const mapping of FIELD_MAPPINGS) {
    await prisma.crmFieldMapping.upsert({
      where: {
        attributeKey_sObject: {
          attributeKey: mapping.attributeKey,
          sObject: mapping.sObject,
        },
      },
      create: mapping,
      update: {
        fieldName: mapping.fieldName,
        sensitive: mapping.sensitive,
        notes: mapping.notes,
      },
    });
  }

  // Ensure the non-human actors exist before anything tries to attribute to them.
  await Promise.all(
    Object.values(SYSTEM_ACTORS).map((name) => getSystemActor(name)),
  );
}
