// Import from the internal path to skip the test-file read side effect that
// the main pdf-parse entry point triggers at module load time in Next.js.
/* eslint-disable @typescript-eslint/no-require-imports */
const pdfParse = require('pdf-parse/lib/pdf-parse');

export interface PagedText {
  page: number;  // 1-indexed
  text: string;
}

export async function extractPages(buffer: Buffer): Promise<PagedText[]> {
  const pages: PagedText[] = [];

  await pdfParse(buffer, {
    pagerender(pdfPage: any): Promise<string> {
      // pdfPage is a pdfjs PDFPageProxy — pageNumber is 1-indexed and reliable
      // even when pages are processed in parallel (Promise.all internally).
      const pageNumber: number = pdfPage.pageNumber;

      return pdfPage.getTextContent().then((content: any) => {
        const raw = content.items
          .map((item: any) => (item.hasEOL ? item.str + '\n' : item.str))
          .join('');

        const text = cleanText(raw);
        if (text.trim().length > 0) {
          pages.push({ page: pageNumber, text });
        }
        return raw;
      });
    },
  });

  // Pages may arrive out of order if pdfjs processes them concurrently.
  pages.sort((a, b) => a.page - b.page);
  return pages;
}

function cleanText(raw: string): string {
  return raw
    .replace(/\f/g, ' ')                       // form feeds → space
    .replace(/\r\n/g, '\n')                    // normalize line endings
    .replace(/([a-z])-\n([a-z])/g, '$1$2')    // rejoin hyphenated line-break words
    .replace(/\n{3,}/g, '\n\n')               // collapse 3+ blank lines to 2
    .replace(/[ \t]{2,}/g, ' ')               // collapse runs of spaces/tabs
    .trim();
}
