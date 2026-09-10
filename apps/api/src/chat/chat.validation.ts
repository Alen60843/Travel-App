import { z } from 'zod';

import { ValidationError } from '../common/errors/app-error';

const sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
// Accept decimal HTTP query strings without coercing null, booleans or arrays.
const queryInteger = z.union([sequence, z.string().regex(/^\d{1,16}$/).transform(Number)])
  .pipe(sequence);
const limit = queryInteger.pipe(z.number().min(1).max(100)).default(50);
const text = (max: number) => z.string().min(1).max(max)
  // Reject lone UTF-16 surrogates: UTF-8 encoding would replace them and make
  // an otherwise identical retry differ from the persisted payload/key.
  .refine((value) => value.trim().length > 0 && !value.includes('\0') && !/[\uD800-\uDFFF]/u.test(value));

export const chatIdentitySchema = z.object({ userId: z.string().uuid(), roomId: z.string().uuid() });
export const sendChatMessageSchema = z.object({
  type: z.literal('TEXT'),
  clientMessageId: text(128),
  body: text(4000),
}).strict();
export const readChatSchema = z.object({ lastReadSeq: sequence }).strict();
export const listChatSchema = z.object({
  limit,
  afterRoomId: z.string().uuid().optional(),
}).strict();
export const historyChatSchema = z.object({
  limit,
  afterSeq: queryInteger.optional(),
  beforeSeq: queryInteger.pipe(z.number().min(1)).optional(),
}).strict().refine((value) => value.afterSeq === undefined || value.beforeSeq === undefined);

/** Shared by HTTP and future socket callers: transport validation is not authority. */
export function parseChat<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ValidationError('Invalid chat request.');
  return parsed.data;
}
