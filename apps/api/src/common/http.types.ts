/**
 * Minimal structural types for the parts of the request/response objects
 * this package touches.
 *
 * This workspace has neither `@types/express` nor a version of `express`
 * that bundles its own declarations (express 5.x here ships none) — so
 * `import type { Request, Response } from 'express'` does not resolve under
 * strict TypeScript. These narrow interfaces describe only what we actually
 * read or call, and match Express's runtime request/response shape (and
 * Node's `http.IncomingMessage`/`ServerResponse`) closely enough to be a
 * faithful, dependency-free stand-in.
 */
export interface HttpRequestLike {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

export interface HttpResponseLike {
  status(code: number): this;
  json(body: unknown): this;
  setHeader(name: string, value: string): this;
}
