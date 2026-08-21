import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';

export async function findExecutable(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (!name || name.includes('\0') || /[\r\n]/.test(name)) {
    throw new TypeError('Executable name must be non-empty and contain no NUL/newline');
  }
  const candidates = isAbsolute(name) || name.includes('/')
    ? [name]
    : (environment.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, name));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT'
        && (error as NodeJS.ErrnoException).code !== 'EACCES') {
        throw error;
      }
    }
  }
  return null;
}
