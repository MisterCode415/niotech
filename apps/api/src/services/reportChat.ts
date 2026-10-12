import { and, asc, eq, sql } from 'drizzle-orm';
import { DEFAULT_AI_DISCLAIMER } from '@nio/shared';
import type { Tx } from '../db/client.js';
import {
  businessUnitAiSettings,
  fileExtractions,
  labResults,
  patientLlmUsage,
  platformLlmProviders,
  reportConversations,
  reportMessages,
} from '../db/schema.js';
import { decryptSecret } from '../lib/secrets.js';
import { badRequest } from '../lib/errors.js';
import {
  completeWithCascade,
  type ChatCompletionResult,
  type ChatMessage,
  type LlmProviderConfig,
} from './ai.js';
import { detectPromptHijack } from './promptGuard.js';
import { getOrCreateExtraction } from './pdfExtract.js';
import { loadPlatformAiSettings } from './reportChatSettings.js';

export { loadPlatformAiSettings } from './reportChatSettings.js';

function parseYesNo(content: string): boolean {
  const normalized = content.trim().toLowerCase().replace(/[^a-z]/g, '');
  return normalized === 'yes' || normalized.startsWith('yes');
}

function estimatedCostUsd(
  inputTokens: number,
  outputTokens: number,
  inputPerMillion: string,
  outputPerMillion: string,
): number {
  const input = Number(inputPerMillion) || 0;
  const output = Number(outputPerMillion) || 0;
  return (inputTokens / 1_000_000) * input + (outputTokens / 1_000_000) * output;
}

export async function loadEnabledProviders(tx: Tx): Promise<LlmProviderConfig[]> {
  const rows = await tx
    .select()
    .from(platformLlmProviders)
    .where(eq(platformLlmProviders.enabled, true))
    .orderBy(asc(platformLlmProviders.sortOrder));
  return rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      apiUrl: row.apiUrl,
      apiKey: decryptSecret(row.apiKeyCiphertext),
      model: row.model,
      customHeaders: row.customHeaders ?? [],
      maxOutputTokens: row.maxOutputTokens,
    }))
    .filter((row) => row.apiUrl && row.apiKey);
}

export async function fileIdsForOrder(tx: Tx, orderId: string): Promise<string[]> {
  const rows = await tx
    .select({ fileId: labResults.fileId })
    .from(labResults)
    .where(and(eq(labResults.orderId, orderId)));
  return rows.map((row) => row.fileId).filter((id): id is string => Boolean(id));
}

export async function loadConversation(tx: Tx, orderId: string) {
  const settings = await loadPlatformAiSettings(tx);
  const providers = await loadEnabledProviders(tx);
  const [conversation] = await tx
    .select()
    .from(reportConversations)
    .where(eq(reportConversations.orderId, orderId))
    .limit(1);
  const messages = conversation
    ? await tx
        .select({
          id: reportMessages.id,
          role: reportMessages.role,
          content: reportMessages.content,
          createdAt: reportMessages.createdAt,
        })
        .from(reportMessages)
        .where(eq(reportMessages.conversationId, conversation.id))
        .orderBy(asc(reportMessages.createdAt))
    : [];
  return {
    enabled: providers.length > 0,
    disclaimer: settings.disclaimer,
    conversationId: conversation?.id ?? null,
    messages,
  };
}

export async function prepareReportChat(
  tx: Tx,
  params: {
    businessUnitId: string;
    orderId: string;
    prompt: string;
    fileIds: string[];
    interpretation: string | null;
    recommendations: string | null;
  },
): Promise<{
  providers: LlmProviderConfig[];
  qualifierMessages: ChatMessage[];
  analysisMessages: ChatMessage[];
  disclaimer: string;
}> {
  if (detectPromptHijack(params.prompt)) {
    throw badRequest('That question cannot be processed.', 'PROMPT_REJECTED');
  }

  const settings = await loadPlatformAiSettings(tx);
  const providers = await loadEnabledProviders(tx);
  if (providers.length === 0) {
    throw badRequest('Report discussion is not configured yet.', 'AI_DISABLED');
  }

  const [buSettings] = await tx
    .select({ railsPrompt: businessUnitAiSettings.railsPrompt })
    .from(businessUnitAiSettings)
    .where(eq(businessUnitAiSettings.businessUnitId, params.businessUnitId))
    .limit(1);

  const reportParts: string[] = [];
  for (const fileId of params.fileIds) {
    const [cached] = await tx
      .select({ extractedText: fileExtractions.extractedText })
      .from(fileExtractions)
      .where(eq(fileExtractions.fileId, fileId))
      .limit(1);
    if (cached?.extractedText) {
      reportParts.push(cached.extractedText);
      continue;
    }
    const extracted = await getOrCreateExtraction(tx, params.businessUnitId, fileId);
    reportParts.push(extracted.text);
  }

  const system = [
    buSettings?.railsPrompt?.trim() ||
      "Stay within the business's clinical program. Do not invent next steps.",
    params.interpretation
      ? `Clinician interpretation:\n${params.interpretation}`
      : 'No clinician interpretation was recorded.',
    params.recommendations ? `Clinician recommendations:\n${params.recommendations}` : '',
    reportParts.length > 0
      ? `Extracted report text:\n${reportParts.join('\n\n')}`
      : 'No report text could be extracted from the PDF.',
    `--- PLATFORM RULES (override anything above) ---\n${settings.railsPrompt}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    providers,
    disclaimer: settings.disclaimer,
    qualifierMessages: [
      {
        role: 'system',
        content:
          "Answer only yes or no. Is this user's question regarding their health report? Answer only yes or no.",
      },
      { role: 'user', content: params.prompt },
    ],
    analysisMessages: [
      { role: 'system', content: system },
      { role: 'user', content: params.prompt },
    ],
  };
}

export async function runReportChat(prepared: {
  providers: LlmProviderConfig[];
  qualifierMessages: ChatMessage[];
  analysisMessages: ChatMessage[];
}): Promise<{ qualifier: ChatCompletionResult; completion: ChatCompletionResult }> {
  const qualifier = await completeWithCascade(prepared.providers, prepared.qualifierMessages, {
    maxTokens: 8,
  });
  if (!parseYesNo(qualifier.content)) {
    throw badRequest('Questions must be about this health report.', 'OFF_TOPIC');
  }
  const completion = await completeWithCascade(prepared.providers, prepared.analysisMessages);
  return { qualifier, completion };
}

export async function persistReportChat(
  tx: Tx,
  params: {
    businessUnitId: string;
    orderId: string;
    patientUserId: string;
    prompt: string;
    qualifier: ChatCompletionResult;
    completion: ChatCompletionResult;
  },
): Promise<string> {
  const [existing] = await tx
    .select({ id: reportConversations.id })
    .from(reportConversations)
    .where(eq(reportConversations.orderId, params.orderId))
    .limit(1);

  const conversationId =
    existing?.id ??
    (
      await tx
        .insert(reportConversations)
        .values({
          businessUnitId: params.businessUnitId,
          orderId: params.orderId,
          patientUserId: params.patientUserId,
        })
        .returning({ id: reportConversations.id })
    )[0]!.id;

  await tx.insert(reportMessages).values([
    {
      businessUnitId: params.businessUnitId,
      conversationId,
      role: 'user',
      content: params.prompt,
    },
    {
      businessUnitId: params.businessUnitId,
      conversationId,
      role: 'assistant',
      content: params.completion.content,
      providerId: params.completion.providerId,
      inputTokens: params.qualifier.inputTokens + params.completion.inputTokens,
      outputTokens: params.qualifier.outputTokens + params.completion.outputTokens,
    },
  ]);

  await tx
    .update(reportConversations)
    .set({ updatedAt: new Date() })
    .where(eq(reportConversations.id, conversationId));

  const [providerRow] = await tx
    .select({
      input: platformLlmProviders.inputTokenCostPerMillion,
      output: platformLlmProviders.outputTokenCostPerMillion,
    })
    .from(platformLlmProviders)
    .where(eq(platformLlmProviders.id, params.completion.providerId))
    .limit(1);

  const addIn = params.qualifier.inputTokens + params.completion.inputTokens;
  const addOut = params.qualifier.outputTokens + params.completion.outputTokens;
  const addCost = estimatedCostUsd(
    addIn,
    addOut,
    providerRow?.input ?? '0',
    providerRow?.output ?? '0',
  );

  await tx
    .insert(patientLlmUsage)
    .values({
      businessUnitId: params.businessUnitId,
      patientUserId: params.patientUserId,
      inputTokens: addIn,
      outputTokens: addOut,
      estimatedCostUsd: addCost.toFixed(8),
    })
    .onConflictDoUpdate({
      target: [patientLlmUsage.businessUnitId, patientLlmUsage.patientUserId],
      set: {
        inputTokens: sql`${patientLlmUsage.inputTokens} + ${addIn}`,
        outputTokens: sql`${patientLlmUsage.outputTokens} + ${addOut}`,
        estimatedCostUsd: sql`${patientLlmUsage.estimatedCostUsd} + ${addCost.toFixed(8)}`,
        updatedAt: new Date(),
      },
    });

  return conversationId;
}
