/**
 * `heic-decode` ships no types (#23). Declared here rather than pulled from
 * DefinitelyTyped, because no @types package exists for it — and this is the
 * entire surface we use. A wider hand-written declaration would be a guess that
 * happens to typecheck, which is worse than no types at all.
 *
 * Shape verified against the package's README and its runtime exports.
 */
declare module 'heic-decode' {
  interface DecodedImage {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8ClampedArray;
  }

  /** Dimensions are known BEFORE decode() runs — what makes a decode-bomb check possible. */
  interface LazyImage {
    readonly width: number;
    readonly height: number;
    decode(): Promise<DecodedImage>;
  }

  interface LazyImageList extends Array<LazyImage> {
    /** Frees the WASM heap. Not optional on a long-running worker. */
    dispose(): void;
  }

  function decode(input: { buffer: Buffer }): Promise<DecodedImage>;

  namespace decode {
    function all(input: { buffer: Buffer }): Promise<LazyImageList>;
  }

  export default decode;
}
