import { vi } from 'vitest';

// Completing a kit schedules extraction, and the tiny fixture PDFs fall through to OCR. Real
// Tesseract would download language data mid-test, so OCR yields nothing unless a suite stubs
// `pdfOcr.ocrPdfPages` itself. A module mock survives `vi.restoreAllMocks()`.
vi.mock('tesseract.js', () => ({
  createWorker: async () => ({
    recognize: async () => ({ data: { text: '' } }),
    terminate: async () => undefined,
  }),
}));
