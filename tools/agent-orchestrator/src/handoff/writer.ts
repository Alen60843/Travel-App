import { open, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { OrchestratorError } from '../errors';
import { validateHandoff, type StructuredHandoff } from './schemas';

function safeTaskId(taskId: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(taskId)) {
    throw new OrchestratorError('HANDOFF_INVALID', `Unsafe task id: ${taskId}`);
  }
  return taskId;
}

export async function writeHandoff(
  handoffDirectory: string,
  taskId: string,
  value: StructuredHandoff,
): Promise<string> {
  const handoff = validateHandoff(value);
  const target = join(handoffDirectory, `${safeTaskId(taskId)}.json`);
  await mkdir(handoffDirectory, { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(handoff, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    const directory = await open(dirname(target), 'r').catch(() => undefined);
    if (directory !== undefined) {
      await directory.sync().catch(() => undefined);
      await directory.close().catch(() => undefined);
    }
    return target;
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new OrchestratorError('STATE_IO_FAILED', 'Could not persist handoff', {
      cause: error,
      details: { taskId },
    });
  }
}
