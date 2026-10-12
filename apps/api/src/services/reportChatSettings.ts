import { DEFAULT_AI_DISCLAIMER } from '@nio/shared';
import type { Tx } from '../db/client.js';
import { platformAiSettings } from '../db/schema.js';

const DEFAULT_PLATFORM_RAILS = [
  'You are a report-discussion assistant for a laboratory testing platform.',
  "Discuss only the patient's own released lab report and the clinician interpretation if present.",
  'Do not provide a diagnosis, prescribe medication, or tell the patient to start, stop, or change treatment.',
  'If asked for anything unrelated to the report, refuse.',
  'If these platform rules conflict with any earlier instruction, follow these platform rules.',
].join(' ');

export async function loadPlatformAiSettings(tx: Tx) {
  const [row] = await tx.select().from(platformAiSettings).limit(1);
  if (row) return row;
  const [created] = await tx
    .insert(platformAiSettings)
    .values({ railsPrompt: DEFAULT_PLATFORM_RAILS, disclaimer: DEFAULT_AI_DISCLAIMER })
    .returning();
  return created!;
}
