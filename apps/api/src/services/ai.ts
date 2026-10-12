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
  customHeaders: Array<{ name: string; value: string }>;
  maxOutputTokens: number;
}

export interface ChatCompletionResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  providerId: string;
}

export class LlmHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'LlmHttpError';
  }
}

function chatCompletionsUrl(apiUrl: string): string {
  const trimmed = apiUrl.replace(/\/$/, '');
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  if (trimmed.endsWith('/v1')) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
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
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${provider.apiKey}`,
  };
  for (const header of provider.customHeaders) {
    if (header.name.trim()) headers[header.name] = header.value;
  }

  let response: Response;
  try {
    response = await fetch(chatCompletionsUrl(provider.apiUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: provider.model,
        messages,
        max_tokens: options.maxTokens ?? provider.maxOutputTokens,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    throw new LlmHttpError(0, true, (error as Error).message);
  }

  const raw = await response.text();
  if (!response.ok) {
    const retryable =
      !isPolicyRefusal(response.status, raw) &&
      (response.status === 0 ||
        response.status === 401 ||
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500);
    throw new LlmHttpError(response.status, retryable, `Provider ${provider.name} returned ${response.status}`);
  }

  const payload = JSON.parse(raw) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = payload.choices?.[0]?.message?.content?.trim() ?? '';
  return {
    content,
    inputTokens: payload.usage?.prompt_tokens ?? 0,
    outputTokens: payload.usage?.completion_tokens ?? 0,
    providerId: provider.id,
  };
}

export async function completeWithCascade(
  providers: LlmProviderConfig[],
  messages: ChatMessage[],
  options: { maxTokens?: number } = {},
): Promise<ChatCompletionResult> {
  if (providers.length === 0) {
    throw new LlmHttpError(503, false, 'No LLM providers are configured');
  }
  let lastError: Error = new Error('No LLM providers responded');
  for (const provider of providers) {
    try {
      return await chatCompletion(provider, messages, options);
    } catch (error) {
      lastError = error as Error;
      if (error instanceof LlmHttpError && !error.retryable) throw error;
    }
  }
  throw lastError;
}
