export interface InterpretationContext {
  packageName: string;
  focusArea: string | null;
  testTypeNames: string[];
  labSummary: string | null;
}

export interface InterpretationDraft {
  model: string;
  content: string;
}

/**
 * Placeholder for the model-backed first pass. It deliberately produces a draft that reads as
 * unreviewed so a clinician cannot mistake it for a finished interpretation, and the calling
 * code already stores it separately from the doctor's own words.
 */
export async function draftInterpretation(
  context: InterpretationContext,
): Promise<InterpretationDraft> {
  const focus = context.focusArea ? ` with a focus on ${context.focusArea}` : '';
  const tests = context.testTypeNames.join(', ');
  const summary = context.labSummary
    ? `Lab technician summary: ${context.labSummary}`
    : 'No technician summary was provided.';

  return {
    model: 'stub-draft-v0',
    content: [
      `DRAFT - NOT REVIEWED BY A CLINICIAN`,
      ``,
      `Package: ${context.packageName}${focus}.`,
      `Panels included: ${tests || 'not specified'}.`,
      summary,
      ``,
      `Suggested structure for review: confirm which markers fall outside reference range,`,
      `relate them to the package's stated focus, then state whether the patient is cleared`,
      `to proceed and what would change that answer.`,
    ].join('\n'),
  };
}
