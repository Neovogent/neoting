/// <reference types="vite/client" />

/**
 * A markdown import is a legal document rendered at build time by the
 * `neoting-legal-docs` plugin in `vite.config.ts` — see
 * `src/views/legal/markdown.ts` for the shape's meaning.
 */
declare module '*.md' {
  export const html: string;
  export const title: string;
  export const placeholderCount: number;
}
