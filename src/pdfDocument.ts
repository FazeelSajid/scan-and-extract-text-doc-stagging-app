/**
 * PDF support: pick a PDF, render its pages to images and read the expiry
 * date from them.
 *
 * ML Kit only reads images, so each page is rendered to a JPEG first
 * (react-native-pdf-thumbnail, patched to upscale: see
 * patches/react-native-pdf-thumbnail+2.0.0.patch). The page images then go
 * through exactly the same OCR + extractor path as photos.
 *
 * Pages are read one at a time and the loop stops at the first conclusive
 * result, so a one-page ID scan costs one render and one OCR call, and a long
 * policy document doesn't render 40 pages.
 */

import {
  errorCodes,
  isErrorWithCode,
  keepLocalCopy,
  pick,
  types,
} from '@react-native-documents/picker';
import TextRecognition from '@react-native-ml-kit/text-recognition';
import PdfThumbnail, {
  PdfThumbnailErrorCodes,
} from 'react-native-pdf-thumbnail';
import type { ThumbnailResult } from 'react-native-pdf-thumbnail';
import {
  extractExpirationDate,
  isConclusiveExtraction,
  pickBestPageExtraction,
} from './expirationExtractor';
import type { PageExtraction } from './expirationExtractor';

/**
 * Longest side of a rendered page, in pixels. Same budget as photos
 * (PICKER_OPTIONS in App.tsx): an A4 page becomes about 1770 x 2500, roughly
 * 215 dpi, which keeps 8-point print readable for ML Kit. The patched library
 * upscales small pages (an ID card saved as a PDF) to this size too.
 */
export const PDF_RENDER_SIZE = 2500;

/** Expiry dates sit near the start of a document; stop after this many pages. */
export const MAX_PDF_PAGES = 5;

/** JPEG quality for rendered pages. High, because JPEG artefacts hurt OCR. */
const RENDER_QUALITY = 90;

export type PickedPdf = { uri: string; name: string };

export type PdfReadResult = {
  /** Best result across the pages that were read, or null if the PDF had no pages. */
  best: PageExtraction | null;
  /** Rendered page images, in page order (only the pages that were read). */
  pageImages: ThumbnailResult[];
  /** True when the PDF has more pages than were read. */
  morePages: boolean;
};

/** A PDF problem worth showing to the user as-is. */
export class PdfReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfReadError';
  }
}

/**
 * Opens the system file picker for PDFs and copies the chosen file into the
 * app cache, so it has a plain file:// path on both platforms (the renderer
 * needs one on iOS, and Android content:// URIs can expire). Returns null when
 * the user cancels.
 */
export async function pickPdf(): Promise<PickedPdf | null> {
  let picked;
  try {
    [picked] = await pick({ type: [types.pdf], mode: 'import' });
  } catch (err) {
    if (isErrorWithCode(err) && err.code === errorCodes.OPERATION_CANCELED) {
      return null;
    }
    throw err;
  }

  const name = picked.name ?? 'document.pdf';
  const [copy] = await keepLocalCopy({
    // A unique name, so picking two files called "scan.pdf" doesn't mix them up.
    files: [{ uri: picked.uri, fileName: `expiry-${Date.now()}.pdf` }],
    destination: 'cachesDirectory',
  });
  if (copy.status !== 'success') {
    throw new PdfReadError(`Could not open “${name}”: ${copy.copyError}`);
  }
  return { uri: copy.localUri, name };
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

/** Renders one page, or returns null when the PDF has no page with this index. */
async function renderPage(
  uri: string,
  page: number,
  size: number = PDF_RENDER_SIZE,
): Promise<ThumbnailResult | null> {
  try {
    return await PdfThumbnail.generate(uri, page, {
      quality: RENDER_QUALITY,
      maxWidth: size,
      maxHeight: size,
    });
  } catch (err) {
    const code = errorCode(err);
    if (code === PdfThumbnailErrorCodes.INVALID_PAGE) return null;
    if (code === PdfThumbnailErrorCodes.PASSWORD_PROTECTED) {
      throw new PdfReadError(
        'This PDF is password protected. Remove the password or take a photo of the document instead.',
      );
    }
    if (code === PdfThumbnailErrorCodes.INVALID_FILE) {
      throw new PdfReadError('This file is damaged or is not a PDF.');
    }
    if (code === PdfThumbnailErrorCodes.OUT_OF_MEMORY) {
      throw new PdfReadError('This PDF page is too large to read. Try a photo of the document instead.');
    }
    throw err;
  }
}

/**
 * Reads the expiry date from a PDF already on disk (see `pickPdf`). Renders
 * and reads one page at a time, up to MAX_PDF_PAGES, stopping early at a
 * conclusive result. `onPage` is called before each page (1-based) so the UI
 * can show progress.
 */
export async function readPdfExpiry(
  uri: string,
  onPage?: (pageNumber: number) => void,
  now?: Date,
): Promise<PdfReadResult> {
  const results: PageExtraction[] = [];
  const pageImages: ThumbnailResult[] = [];

  for (let page = 0; page < MAX_PDF_PAGES; page++) {
    onPage?.(page + 1);
    const image = await renderPage(uri, page);
    if (!image) break; // past the last page

    pageImages.push(image);
    const ocr = await TextRecognition.recognize(image.uri);
    const extraction = extractExpirationDate(ocr.blocks, { now });
    results.push({ ...extraction, pageIndex: page });
    if (__DEV__) {
      console.log(`PDF page ${page + 1}:`, extraction.strategy, extraction.iso, extraction.sourceLine);
    }
    if (isConclusiveExtraction(extraction)) break;
  }

  if (pageImages.length === 0) {
    throw new PdfReadError('This PDF has no pages.');
  }

  // Only check for an unread page when the loop stopped at the page limit.
  // A tiny render is enough to learn whether the page exists.
  const morePages =
    pageImages.length === MAX_PDF_PAGES &&
    !isConclusiveExtraction(results[results.length - 1]) &&
    (await renderPage(uri, MAX_PDF_PAGES, 16)) !== null;

  return { best: pickBestPageExtraction(results), pageImages, morePages };
}
