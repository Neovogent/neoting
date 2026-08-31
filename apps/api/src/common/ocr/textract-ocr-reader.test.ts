import { describe, expect, it } from 'vitest';
import type { Block, TextractClient } from '@aws-sdk/client-textract';

import { blocksToPages, blocksToWords, TextractOcrReader } from './textract-ocr-reader.js';
import type { Grid, OcrPage } from './document-ocr.js';

/** Every page's table rows, stacked in page order — what the statement lane reads. */
const gridOf = (pages: OcrPage[]): Grid => pages.flatMap((page) => page.grid);

/**
 * `blocksToGrid` is the one piece of the Textract path that is ours rather than
 * the service's, and it is where a statement gets silently mangled if it is
 * wrong. Every case here is a shape a real bank statement produces.
 */

/** A cell owning the words that make up its text. */
function cell(id: string, row: number, column: number, words: string[]): Block[] {
  const wordIds = words.map((_, index) => `${id}w${index}`);
  return [
    {
      Id: id,
      BlockType: 'CELL',
      RowIndex: row,
      ColumnIndex: column,
      Relationships: wordIds.length === 0 ? [] : [{ Type: 'CHILD', Ids: wordIds }],
    } as Block,
    ...words.map(
      (text, index) => ({ Id: wordIds[index], BlockType: 'WORD', Text: text }) as Block,
    ),
  ];
}

function table(id: string, page: number, cells: Block[]): Block[] {
  const cellIds = cells.filter((b) => b.BlockType === 'CELL').map((b) => b.Id ?? '');
  return [
    { Id: id, BlockType: 'TABLE', Page: page, Relationships: [{ Type: 'CHILD', Ids: cellIds }] } as Block,
    ...cells,
  ];
}

describe('blocksToPages', () => {
  it('reads a table into rows, in row and column order', () => {
    const cells = [
      ...cell('c1', 1, 1, ['Date']),
      ...cell('c2', 1, 2, ['Description']),
      ...cell('c3', 1, 3, ['Paid', 'out']),
      ...cell('c4', 2, 1, ['01/08/2026']),
      ...cell('c5', 2, 2, ['BIDFOOD', 'LTD']),
      ...cell('c6', 2, 3, ['124.50']),
    ];

    expect(gridOf(blocksToPages(table('t1', 1, cells)))).toEqual([
      ['Date', 'Description', 'Paid out'],
      ['01/08/2026', 'BIDFOOD LTD', '124.50'],
    ]);
  });

  it('keeps an EMPTY cell as an empty column rather than shifting the row left', () => {
    // The failure this pins is the one that made the hand-rolled PDF reader
    // unusable: a blank "Paid in" put the balance under the "Paid out" header,
    // so every credit was read as a debit and the books inverted.
    const cells = [
      ...cell('c1', 1, 1, ['01/08/2026']),
      ...cell('c2', 1, 2, ['SALARY']),
      // column 3 (Paid out) is absent from the block list entirely
      ...cell('c4', 1, 4, ['2,400.00']),
      ...cell('c5', 1, 5, ['3,120.55']),
    ];

    expect(gridOf(blocksToPages(table('t1', 1, cells)))).toEqual([
      ['01/08/2026', 'SALARY', '', '2,400.00', '3,120.55'],
    ]);
  });

  it('stacks a statement that continues across pages, in page order', () => {
    // Textract reports one table per page and does NOT promise page order in the
    // block list. A statement read out of order fails date monotonicity in the
    // D41 gate and reports a good file as broken.
    const second = table('t2', 2, [...cell('b1', 1, 1, ['02/08/2026'])]);
    const first = table('t1', 1, [...cell('a1', 1, 1, ['01/08/2026'])]);

    expect(gridOf(blocksToPages([...second, ...first]))).toEqual([['01/08/2026'], ['02/08/2026']]);
  });

  it('reads a selected checkbox as a mark and an unselected one as empty', () => {
    const blocks: Block[] = [
      { Id: 't', BlockType: 'TABLE', Page: 1, Relationships: [{ Type: 'CHILD', Ids: ['c1', 'c2'] }] } as Block,
      { Id: 'c1', BlockType: 'CELL', RowIndex: 1, ColumnIndex: 1, Relationships: [{ Type: 'CHILD', Ids: ['s1'] }] } as Block,
      { Id: 's1', BlockType: 'SELECTION_ELEMENT', SelectionStatus: 'SELECTED' } as Block,
      { Id: 'c2', BlockType: 'CELL', RowIndex: 1, ColumnIndex: 2, Relationships: [{ Type: 'CHILD', Ids: ['s2'] }] } as Block,
      { Id: 's2', BlockType: 'SELECTION_ELEMENT', SelectionStatus: 'NOT_SELECTED' } as Block,
    ];

    expect(gridOf(blocksToPages(blocks))).toEqual([['X', '']]);
  });

  it('is empty when the document contains no table at all', () => {
    // A cover letter, or a photograph of nothing. The caller turns this into a
    // named refusal; it must never read as a statement with no transactions.
    const blocks: Block[] = [
      { Id: 'p', BlockType: 'PAGE', Page: 1 } as Block,
      { Id: 'w', BlockType: 'WORD', Text: 'Dear customer' } as Block,
    ];

    expect(gridOf(blocksToPages(blocks))).toEqual([]);
  });
});

/** A WORD block with Textract's own normalised 0–1 geometry. */
function wordBlock(id: string, text: string, box: { Left: number; Top: number; Width: number; Height: number }, page?: number): Block {
  return {
    Id: id,
    BlockType: 'WORD',
    Text: text,
    ...(page === undefined ? {} : { Page: page }),
    Geometry: { BoundingBox: box },
  } as Block;
}

describe('blocksToWords', () => {
  it('carries each WORD through with its normalised box, Left/Top/Width/Height → x/y/width/height', () => {
    const blocks = [
      wordBlock('w1', 'Nexora', { Left: 0.1, Top: 0.2, Width: 0.08, Height: 0.02 }),
      wordBlock('w2', 'Solutions', { Left: 0.19, Top: 0.2, Width: 0.1, Height: 0.02 }, 2),
    ];

    expect(blocksToWords(blocks)).toEqual([
      // ⚠ A single-page synchronous read carries no `Page` — defaulting to 1
      // is the same rule blocksToPages pins above.
      { text: 'Nexora', pageNumber: 1, box: { x: 0.1, y: 0.2, width: 0.08, height: 0.02 } },
      { text: 'Solutions', pageNumber: 2, box: { x: 0.19, y: 0.2, width: 0.1, height: 0.02 } },
    ]);
  });

  it('skips a word with no geometry or no text rather than inventing a place', () => {
    const blocks: Block[] = [
      { Id: 'w1', BlockType: 'WORD', Text: 'orphan' } as Block, // no Geometry
      wordBlock('w2', '   ', { Left: 0.1, Top: 0.1, Width: 0.1, Height: 0.1 }), // no text
      { Id: 'l1', BlockType: 'LINE', Text: 'a line', Geometry: { BoundingBox: { Left: 0, Top: 0, Width: 1, Height: 0.1 } } } as Block,
    ];

    expect(blocksToWords(blocks)).toEqual([]);
  });
});

describe('TextractOcrReader.read', () => {
  it('returns the words alongside pages/grid/text, from the same blocks', async () => {
    const blocks = [
      { Id: 'l1', BlockType: 'LINE', Text: 'Nexora Solutions' } as Block,
      wordBlock('w1', 'Nexora', { Left: 0.1, Top: 0.2, Width: 0.08, Height: 0.02 }),
      wordBlock('w2', 'Solutions', { Left: 0.19, Top: 0.2, Width: 0.1, Height: 0.02 }),
    ];
    const client = { send: async () => ({ Blocks: blocks }) } as unknown as TextractClient;
    const reader = new TextractOcrReader({ client, bucket: 'b' });

    const read = await reader.read({ bytes: Buffer.from('png'), mimeType: 'image/png', s3Key: null });

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.ocr.pages[0]?.lines).toEqual(['Nexora Solutions']);
    expect(read.ocr.words).toEqual([
      { text: 'Nexora', pageNumber: 1, box: { x: 0.1, y: 0.2, width: 0.08, height: 0.02 } },
      { text: 'Solutions', pageNumber: 1, box: { x: 0.19, y: 0.2, width: 0.1, height: 0.02 } },
    ]);
  });
});
