import { eq } from 'drizzle-orm';
import { extractText } from 'unpdf';
import type { Tx } from '../db/client.js';
import { fileExtractions, files } from '../db/schema.js';
import { storage } from './storage.js';

const CHARS_PER_PAGE_FOR_TEXT = 100;

export interface ExtractionResult {
  text: string;
  method: 'pdf_text' | 'ocr';
  pageCount: number;
  charCount: number;
}

export function needsOcr(text: string, pageCount: number): boolean {
  const pages = Math.max(pageCount, 1);
  return text.replace(/\s+/g, '').length < CHARS_PER_PAGE_FOR_TEXT * pages;
}

export async function extractDigitalText(buffer: Buffer): Promise<{ text: string; pageCount: number }> {
  const result = await extractText(new Uint8Array(buffer), { mergePages: true });
  const text = Array.isArray(result.text) ? result.text.join('\n') : (result.text ?? '');
  return { text: text.trim(), pageCount: result.totalPages || 1 };
}

export const pdfText = { extractDigitalText };

/**
 * OCR path for scanned reports. Isolated so tests can stub it without downloading Tesseract WASM.
 */
export async function ocrPdfPages(buffer: Buffer): Promise<string> {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('eng');
  try {
    const result = await worker.recognize(buffer);
    return result.data.text.trim();
  } finally {
    await worker.terminate();
  }
}

export const pdfOcr = { ocrPdfPages };

export async function extractPdf(buffer: Buffer): Promise<ExtractionResult> {
  let text = '';
  let pageCount = 1;
  try {
    const digital = await pdfText.extractDigitalText(buffer);
    text = digital.text;
    pageCount = digital.pageCount;
  } catch {
    text = '';
  }

  let method: 'pdf_text' | 'ocr' = 'pdf_text';
  if (needsOcr(text, pageCount)) {
    method = 'ocr';
    try {
      const ocrText = await pdfOcr.ocrPdfPages(buffer);
      if (ocrText) text = ocrText;
    } catch {
      // Keep whatever digital text we had; method still records that OCR was required.
    }
  }

  return { text, method, pageCount, charCount: text.length };
}

export async function getOrCreateExtraction(
  tx: Tx,
  businessUnitId: string,
  fileId: string,
): Promise<ExtractionResult> {
  const [cached] = await tx
    .select({
      extractedText: fileExtractions.extractedText,
      method: fileExtractions.method,
      pageCount: fileExtractions.pageCount,
      charCount: fileExtractions.charCount,
    })
    .from(fileExtractions)
    .where(eq(fileExtractions.fileId, fileId))
    .limit(1);

  if (cached) {
    return {
      text: cached.extractedText,
      method: cached.method,
      pageCount: cached.pageCount,
      charCount: cached.charCount,
    };
  }

  const [file] = await tx
    .select({ storageKey: files.storageKey })
    .from(files)
    .where(eq(files.id, fileId))
    .limit(1);
  if (!file) throw new Error('File not found');

  const bytes = await storage.get(file.storageKey);
  const extracted = await extractPdf(bytes);

  await tx.insert(fileExtractions).values({
    businessUnitId,
    fileId,
    extractedText: extracted.text,
    method: extracted.method,
    pageCount: extracted.pageCount,
    charCount: extracted.charCount,
  });

  return extracted;
}
