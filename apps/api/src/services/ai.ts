import { isNativeGeminiUrl } from '@nio/shared';
import { HttpError } from '../lib/errors.js';

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

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmProviderConfig {
  id: string;
  name: string;
  apiUrl: string;
  apiKey: string;
  model: string;
  authStyle: 'bearer' | 'header';
  authHeaderName: string | null;
  customHeaders: Array<{ name: string; value: string }>;
  maxOutputTokens: number;
  inputCostPerMillion: number;
  outputCostPerMillion: number;
}

export interface ChatCompletionResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  providerId: string;
  costUsd: number;
}

export function tokenCostUsd(
  provider: Pick<LlmProviderConfig, 'inputCostPerMillion' | 'outputCostPerMillion'>,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (inputTokens / 1_000_000) * provider.inputCostPerMillion +
    (outputTokens / 1_000_000) * provider.outputCostPerMillion
  );
}

/** Longest slice of a provider's error body kept for logs and the platform test button. */
const ERROR_DETAIL_CHARS = 300;

export class LlmHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryable: boolean,
    message: string,
    /** Where the request went (host and path only) and what the provider said back. */
    public readonly endpoint: string = '',
    public readonly detail: string = '',
  ) {
    super(message);
    this.name = 'LlmHttpError';
  }
}

/**
 * Resolves the chat-completions endpoint from a provider's base URL:
 * a full `.../chat/completions` URL is used as-is, a bare host gets `/v1/chat/completions`, and
 * any other path (`/v1`, `/v1beta/openai`, ...) gets `/chat/completions`.
 */
export function chatCompletionsUrl(apiUrl: string): string {
  const url = new URL(apiUrl);
  const path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/chat/completions')) return url.toString();
  url.pathname = path === '' ? '/v1/chat/completions' : `${path}/chat/completions`;
  return url.toString();
}

function endpointLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return '';
  }
}

export function providerRequestHeaders(provider: LlmProviderConfig): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  for (const header of provider.customHeaders) {
    if (header.name.trim()) headers[header.name] = header.value;
  }
  if (provider.authStyle === 'header' && provider.authHeaderName) {
    headers[provider.authHeaderName] = provider.apiKey;
  } else {
    headers.authorization = `Bearer ${provider.apiKey}`;
  }
  return headers;
}

function isPolicyRefusal(status: number, body: string): boolean {
  if (status !== 400 && status !== 403) return false;
  return /content[_ ]?filter|policy|safety|moderation/i.test(body);
}

export async function chatCompletion(
  provider: LlmProviderConfig,
  messages: ChatMessage[],
  options: { maxTokens?: number } = {},
): Promise<ChatCompletionResult> {
  if (isNativeGeminiUrl(provider.apiUrl)) {
    throw new LlmHttpError(
      0,
      true,
      `Provider ${provider.name} uses Google's native Gemini URL; use the OpenAI-compatible endpoint`,
      endpointLabel(provider.apiUrl),
    );
  }
  const url = chatCompletionsUrl(provider.apiUrl);
  const endpoint = endpointLabel(url);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: providerRequestHeaders(provider),
      body: JSON.stringify({
        model: provider.model,
        messages,
        max_tokens: options.maxTokens ?? provider.maxOutputTokens,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    throw new LlmHttpError(0, true, `Provider ${provider.name} unreachable`, endpoint, (error as Error).message);
  }

  const raw = await response.text();
  if (!response.ok) {
    // A broken provider should not take chat down when a backup is configured; only a content
    // refusal is final, because the next provider would be asked the same thing.
    throw new LlmHttpError(
      response.status,
      !isPolicyRefusal(response.status, raw),
      `Provider ${provider.name} returned ${response.status}`,
      endpoint,
      raw.slice(0, ERROR_DETAIL_CHARS),
    );
  }

  let payload: {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new LlmHttpError(
      response.status,
      true,
      `Provider ${provider.name} returned a non-JSON body`,
      endpoint,
      raw.slice(0, ERROR_DETAIL_CHARS),
    );
  }
  const content = payload.choices?.[0]?.message?.content?.trim() ?? '';
  if (!content) {
    throw new LlmHttpError(
      response.status,
      true,
      `Provider ${provider.name} returned an empty reply`,
      endpoint,
      `finish_reason: ${payload.choices?.[0]?.finish_reason ?? 'unknown'}`,
    );
  }
  const inputTokens = payload.usage?.prompt_tokens ?? 0;
  const outputTokens = payload.usage?.completion_tokens ?? 0;
  return {
    content,
    inputTokens,
    outputTokens,
    providerId: provider.id,
    costUsd: tokenCostUsd(provider, inputTokens, outputTokens),
  };
}

function logProviderFailure(provider: LlmProviderConfig, error: unknown): void {
  // Status, endpoint, and the provider's own error text only; never the prompt or report.
  const failure =
    error instanceof LlmHttpError
      ? { status: error.status, endpoint: error.endpoint, detail: error.detail, message: error.message }
      : { message: error instanceof Error ? error.message : String(error) };
  console.warn(JSON.stringify({ level: 'warn', msg: 'LLM provider failed', provider: provider.name, ...failure }));
}

export const AI_PROVIDER_ERROR_MESSAGE = 'The AI service could not answer right now. Please try again.';

export async function completeWithCascade(
  providers: LlmProviderConfig[],
  messages: ChatMessage[],
  options: { maxTokens?: number } = {},
): Promise<ChatCompletionResult> {
  if (providers.length === 0) {
    throw new HttpError(503, 'Report discussion is not configured yet.', 'AI_DISABLED');
  }
  for (const provider of providers) {
    try {
      return await chatCompletion(provider, messages, options);
    } catch (error) {
      logProviderFailure(provider, error);
      if (error instanceof LlmHttpError && !error.retryable) break;
    }
  }
  throw new HttpError(502, AI_PROVIDER_ERROR_MESSAGE, 'AI_PROVIDER_ERROR');
}

export interface ProviderProbe {
  ok: boolean;
  status: number;
  latencyMs: number;
  endpoint: string;
  detail: string;
  reply: string;
}

/** One fixed, PHI-free request so a platform admin can see exactly how a provider responds. */
export async function probeProvider(provider: LlmProviderConfig): Promise<ProviderProbe> {
  const started = Date.now();
  try {
    const result = await chatCompletion(
      provider,
      [
        { role: 'system', content: 'You are a connectivity check.' },
        { role: 'user', content: 'Reply with the single word OK.' },
      ],
      { maxTokens: 256 },
    );
    return {
      ok: true,
      status: 200,
      latencyMs: Date.now() - started,
      endpoint: endpointLabel(chatCompletionsUrl(provider.apiUrl)),
      detail: '',
      reply: result.content.slice(0, 200),
    };
  } catch (error) {
    const llm = error instanceof LlmHttpError ? error : null;
    return {
      ok: false,
      status: llm?.status ?? 0,
      latencyMs: Date.now() - started,
      endpoint: llm?.endpoint ?? '',
      detail: llm ? [llm.message, llm.detail].filter(Boolean).join(': ') : (error as Error).message,
      reply: '',
    };
  }
}
