/**
 * Deterministic prompt-hijack checks. These run before any model call so a jailbreak
 * does not cost tokens and does not reach the report context.
 */

const HIJACK_PATTERNS = [
  /ignore (all |any )?(previous|prior|above) (instructions|prompts|rules)/i,
  /disregard (your )?(system|developer) (prompt|instructions)/i,
  /reveal (your )?(system|hidden|developer) prompt/i,
  /you are now (dan|unrestricted|jailbroken)/i,
  /\bjailbreak\b/i,
  /\bdeveloper mode\b/i,
  /pretend you (are|have) no (restrictions|rules|guidelines)/i,
  /<<\s*SYS\s*>>/i,
  /\[\/?INST\]/i,
  /###\s*(system|instruction)/i,
  /new (system|developer) (message|prompt)/i,
  /override (the )?(platform|safety) (rules|rails)/i,
];

function looksLikeInstructionBlob(decoded: string): boolean {
  return HIJACK_PATTERNS.some((pattern) => pattern.test(decoded));
}

export function detectPromptHijack(prompt: string): boolean {
  if (HIJACK_PATTERNS.some((pattern) => pattern.test(prompt))) return true;

  const blobs = prompt.match(/[A-Za-z0-9+/]{48,}={0,2}/g) ?? [];
  for (const blob of blobs) {
    try {
      const decoded = Buffer.from(blob, 'base64').toString('utf8');
      if (decoded.length > 16 && looksLikeInstructionBlob(decoded)) return true;
    } catch {
      // Not valid base64; ignore.
    }
  }
  return false;
}
