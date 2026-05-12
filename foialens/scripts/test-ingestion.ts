/**
 * Smoke test for the ingestion pipeline.
 * Usage: ts-node --project tsconfig.scripts.json scripts/test-ingestion.ts <path-to-pdf>
 *
 * Tests extraction + chunking without API keys.
 * If OPENAI_API_KEY is set, also runs the embedder against the first 3 chunks.
 */
import * as fs from 'fs';
import * as path from 'path';
import { extractPages } from '../lib/ingestion/pdf-extractor';
import { chunkPages } from '../lib/ingestion/chunker';

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) {
    console.error('Usage: ts-node scripts/test-ingestion.ts <path-to-pdf>');
    process.exit(1);
  }

  const buffer = fs.readFileSync(path.resolve(pdfPath));
  console.log(`\nFile: ${path.basename(pdfPath)} (${(buffer.length / 1024).toFixed(1)} KB)\n`);

  // ── Extract ──────────────────────────────────────────────────────────────────
  console.log('Extracting pages...');
  const pages = await extractPages(buffer);
  console.log(`  Pages with text: ${pages.length}`);
  if (pages.length === 0) {
    console.error('  No text extracted. PDF may be image-only (needs OCR).');
    process.exit(1);
  }
  const totalChars = pages.reduce((n, p) => n + p.text.length, 0);
  console.log(`  Total characters: ${totalChars.toLocaleString()}`);
  console.log(`  Sample (page ${pages[0].page}, first 200 chars):`);
  console.log(`    "${pages[0].text.slice(0, 200).replace(/\n/g, '↵')}"`);

  // ── Chunk ────────────────────────────────────────────────────────────────────
  console.log('\nChunking...');
  const chunks = chunkPages(pages);
  console.log(`  Chunks: ${chunks.length}`);
  const avgLen = Math.round(chunks.reduce((n, c) => n + c.content.length, 0) / chunks.length);
  console.log(`  Avg chunk length: ${avgLen} chars (~${Math.round(avgLen / 4)} tokens)`);
  console.log(`  Page range coverage: p.${chunks[0].startPage} – p.${chunks[chunks.length - 1].endPage}`);

  console.log('\nFirst 3 chunks:');
  for (const chunk of chunks.slice(0, 3)) {
    console.log(`  [${chunk.chunkIndex}] p.${chunk.startPage}–${chunk.endPage} | ${chunk.content.length} chars`);
    console.log(`    "${chunk.content.slice(0, 120).replace(/\n/g, '↵')}..."`);
  }

  // ── Embed (optional) ─────────────────────────────────────────────────────────
  if (process.env.OPENAI_API_KEY) {
    console.log('\nEmbedding first 3 chunks (OPENAI_API_KEY found)...');
    const { embedTexts } = await import('../lib/ingestion/embedder');
    const sample = chunks.slice(0, 3).map(c => c.content);
    const embeddings = await embedTexts(sample);
    for (let i = 0; i < embeddings.length; i++) {
      const e = embeddings[i];
      console.log(`  Chunk ${i}: ${e.length} dims, first 4 values: [${e.slice(0, 4).map(v => v.toFixed(4)).join(', ')}]`);
    }
  } else {
    console.log('\nSkipping embedding test (OPENAI_API_KEY not set).');
  }

  console.log('\nDone.\n');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
