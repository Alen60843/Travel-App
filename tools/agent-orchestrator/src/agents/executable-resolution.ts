import { constants as fsConstants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { OrchestratorError } from '../errors';
import { findExecutable } from '../executable';
import type { AgentName } from '../tasks/task-schema';

/**
 * §10/§11/§12: reliable Codex/Claude executable resolution.
 *
 * PATH-only discovery is not reliable across environments — on at least one
 * machine used to develop this, `codex` resolves to a real binary inside the
 * OpenAI ChatGPT/Codex VS Code extension rather than being on a shell's PATH
 * at all, while another session on the SAME machine reported
 * `codex: command not found`. The orchestrator must not assume one session's
 * shell configuration.
 */

export type ExecutableSource = 'override' | 'path' | 'vscode-extension';

export interface ExecutableResolution {
  readonly path: string;
  readonly source: ExecutableSource;
}

const ENV_VAR_BY_AGENT: Readonly<Record<AgentName, string>> = {
  codex: 'CODEX_EXECUTABLE',
  claude: 'CLAUDE_EXECUTABLE',
};

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * §12, conservative by design: only the platform/architecture combination
 * actually observed and verified (macOS arm64) is implemented. Reliability
 * matters more than coverage here — an unverified guess at a Linux or
 * Windows extension layout would be exactly the kind of fabricated capability
 * this whole correction pass exists to eliminate. Returns null (not an
 * error) on any unsupported platform, missing extensions directory, or no
 * matching candidate: this is a fallback, not a requirement.
 *
 * Scoped narrowly: only `$HOME/.vscode/extensions/`, only directories whose
 * name matches the OpenAI ChatGPT/Codex extension family, only their
 * documented per-platform binary path. Never a filesystem scan.
 */
async function discoverCodexViaVsCodeExtension(
  environment: NodeJS.ProcessEnv,
): Promise<ExecutableResolution | null> {
  const home = environment.HOME;
  if (home === undefined || home.trim() === '') return null;

  const platformDir =
    process.platform === 'darwin'
      ? process.arch === 'arm64'
        ? 'macos-aarch64'
        : process.arch === 'x64'
          ? 'macos-x64'
          : null
      : null;
  if (platformDir === null) return null;

  const extensionsRoot = join(home, '.vscode', 'extensions');
  let entries;
  try {
    entries = await readdir(extensionsRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidateDirs = entries
    .filter((entry) => entry.isDirectory() && /^openai\.chatgpt-/.test(entry.name))
    .map((entry) => entry.name);

  const candidates: Array<{ readonly dirName: string; readonly path: string; readonly mtimeMs: number }> = [];
  for (const dirName of candidateDirs) {
    const candidatePath = join(extensionsRoot, dirName, 'bin', platformDir, 'codex');
    if (!(await isExecutableFile(candidatePath))) continue;
    const info = await stat(join(extensionsRoot, dirName));
    candidates.push({ dirName, path: candidatePath, mtimeMs: info.mtimeMs });
  }
  if (candidates.length === 0) return null;

  // §12: prefer the newest compatible installed extension deterministically,
  // not solely lexical version-string ordering (a directory name like
  // "openai.chatgpt-0.9.0" sorts before "openai.chatgpt-0.10.0" lexically,
  // which is wrong). Directory mtime is what's actually available without
  // parsing each extension's own package.json, and ties break on directory
  // name for full determinism.
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.dirName.localeCompare(a.dirName));
  return { path: candidates[0]!.path, source: 'vscode-extension' };
}

/**
 * Resolution order (§11):
 *   1. `CODEX_EXECUTABLE` / `CLAUDE_EXECUTABLE`, if set — authoritative. An
 *      override that is set but not a valid executable fails loudly rather
 *      than silently falling back to a different binary the user did not
 *      ask for; that would defeat the point of setting it explicitly.
 *   2. PATH.
 *   3. (codex only) the conservative VS Code extension fallback above.
 *   4. Not found.
 */
export async function resolveAgentExecutable(
  name: AgentName,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ExecutableResolution | null> {
  const envVarName = ENV_VAR_BY_AGENT[name];
  const override = environment[envVarName];
  if (override !== undefined && override.trim() !== '') {
    const resolved = await findExecutable(override, environment);
    if (resolved === null) {
      throw new OrchestratorError(
        'AGENT_NOT_FOUND',
        `${envVarName} is set to "${override}" but it is not an executable file`,
        { details: { agent: name, envVar: envVarName, configuredPath: override } },
      );
    }
    return { path: resolved, source: 'override' };
  }

  const onPath = await findExecutable(name, environment);
  if (onPath !== null) return { path: onPath, source: 'path' };

  if (name === 'codex') {
    const viaExtension = await discoverCodexViaVsCodeExtension(environment);
    if (viaExtension !== null) return viaExtension;
  }

  return null;
}
