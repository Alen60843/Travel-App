import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

import ts from 'typescript';

const DEFAULT_MAX_HINTS = 12;
const MAX_SCANNED_SOURCE_FILES = 4_000;
const OWNERSHIP_SEED_LIMIT = 4;
const MAX_GRAPH_DEPTH = 2;
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.turbo',
  '.agent-orchestrator',
  'coverage',
  'dist',
  'dist-test',
  'node_modules',
]);
const TOP_LEVEL_SCAN_ROOTS = ['apps', 'packages', 'tools'] as const;

export interface RepositoryContextHint {
  readonly path: string;
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface RepositoryContextHints {
  readonly hints: readonly RepositoryContextHint[];
  readonly scannedFileCount: number;
  readonly truncated: boolean;
  readonly maxHints: number;
}

interface ParsedSourceFile {
  readonly path: string;
  readonly absolutePath: string;
  readonly imports: readonly string[];
  readonly declarations: readonly string[];
}

interface WorkspacePackage {
  readonly root: string;
  readonly sourceEntryCandidates: readonly string[];
}

interface ScannedRepository {
  readonly files: ReadonlyMap<string, ParsedSourceFile>;
  readonly workspacePackages: ReadonlyMap<string, WorkspacePackage>;
  readonly truncated: boolean;
}

interface MutableHint {
  score: number;
  reasons: Set<string>;
}

export function resolveRepositoryContextHints(
  repositoryRoot: string,
  taskSpecification: unknown,
  maxHints = DEFAULT_MAX_HINTS,
): RepositoryContextHints | null {
  if (!Number.isSafeInteger(maxHints) || maxHints < 1) return null;
  if (!existsSync(repositoryRoot)) return null;
  const task = extractTask(taskSpecification);
  if (task === null) return null;

  try {
    const scanned = scanRepository(repositoryRoot);
    const scored = new Map<string, MutableHint>();
    const contextText = [task.title, task.instructions].filter(Boolean).join('\n');
    const contextIdentifiers = new Set(contextText.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []);
    const explicitPaths = new Set<string>();

    for (const path of extractRepositoryPaths(contextText)) explicitPaths.add(path);
    for (const ownership of task.files) {
      if (!containsGlob(ownership)) explicitPaths.add(ownership);
    }

    for (const explicitPath of explicitPaths) {
      const normalized = normalizeRepositoryPath(repositoryRoot, explicitPath);
      if (normalized === null || !existsSync(resolve(repositoryRoot, normalized))) continue;
      addHint(scored, normalized, 100, 'explicit task reference');
    }

    for (const ownership of task.files) {
      const prefix = staticGlobPrefix(ownership);
      if (prefix === '') continue;
      const normalizedPrefix = normalizeRepositoryPath(repositoryRoot, prefix);
      if (normalizedPrefix === null) continue;
      const candidates = [...scanned.files.keys()]
        .filter((path) => path === normalizedPrefix || path.startsWith(`${normalizedPrefix}/`))
        .slice(0, OWNERSHIP_SEED_LIMIT);
      for (const path of candidates) addHint(scored, path, 80, 'inside task ownership scope');
    }

    for (const file of scanned.files.values()) {
      const matched = file.declarations.filter((symbol) => contextIdentifiers.has(symbol));
      if (matched.length === 0) continue;
      addHint(
        scored,
        file.path,
        90,
        `declares referenced symbol${matched.length === 1 ? '' : 's'} ${matched.slice(0, 3).join(', ')}`,
      );
    }

    const outgoing = new Map<string, Set<string>>();
    const incoming = new Map<string, Set<string>>();
    for (const file of scanned.files.values()) {
      for (const specifier of file.imports) {
        const target = resolveImportTarget(repositoryRoot, file, specifier, scanned);
        if (target === null || !scanned.files.has(target)) continue;
        mapSet(outgoing, file.path).add(target);
        mapSet(incoming, target).add(file.path);
      }
    }

    const frontier = [...scored.keys()]
      .filter((path) => scanned.files.has(path))
      .map((path) => ({ path, depth: 0 }));
    const expanded = new Set(frontier.map((entry) => entry.path));
    for (let index = 0; index < frontier.length; index += 1) {
      const current = frontier[index]!;
      if (current.depth >= MAX_GRAPH_DEPTH) continue;
      const nextDepth = current.depth + 1;
      const outboundScore = 72 - (nextDepth - 1) * 18;
      const inboundScore = 68 - (nextDepth - 1) * 18;

      for (const target of outgoing.get(current.path) ?? []) {
        addHint(scored, target, outboundScore, `${current.path} imports this file`);
        if (!expanded.has(target)) {
          expanded.add(target);
          frontier.push({ path: target, depth: nextDepth });
        }
      }
      for (const source of incoming.get(current.path) ?? []) {
        addHint(scored, source, inboundScore, `imports ${current.path}`);
        if (!expanded.has(source)) {
          expanded.add(source);
          frontier.push({ path: source, depth: nextDepth });
        }
      }
    }

    const ordered = [...scored.entries()]
      .map(([path, value]) => ({ path, score: value.score, reasons: [...value.reasons].sort() }))
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));

    return {
      hints: ordered.slice(0, maxHints),
      scannedFileCount: scanned.files.size,
      truncated: scanned.truncated || ordered.length > maxHints,
      maxHints,
    };
  } catch {
    // Graph Context is a navigation optimization only. A resolver failure must
    // never become a correctness or availability dependency for an agent run.
    return null;
  }
}

export function formatRepositoryContextHints(context: RepositoryContextHints): string {
  const header = [
    'Repository context hints (deterministic read-only navigation; NOT authority):',
    '- Verify every material claim against current repository evidence. These hints may be incomplete or stale relative to changes made during this agent run.',
    '- You may inspect files outside this list when the task requires it; never treat absence from the graph as evidence that a dependency does not exist.',
    `- Resolver scanned ${context.scannedFileCount} source files and returned ${context.hints.length}/${context.maxHints} bounded hints${context.truncated ? ' (bounded/truncated)' : ''}.`,
  ];
  if (context.hints.length === 0) {
    return [...header, '- No relevant bounded hints were resolved; inspect the repository normally.'].join('\n');
  }
  return [
    ...header,
    ...context.hints.map((hint) => `- ${hint.path} — ${hint.reasons.join('; ')}`),
  ].join('\n');
}

function scanRepository(repositoryRoot: string): ScannedRepository {
  const workspacePackages = discoverWorkspacePackages(repositoryRoot);
  const paths: string[] = [];
  let truncated = false;
  for (const rootName of TOP_LEVEL_SCAN_ROOTS) {
    const absoluteRoot = join(repositoryRoot, rootName);
    if (!existsSync(absoluteRoot)) continue;
    walkSourceFiles(repositoryRoot, absoluteRoot, paths, () => {
      truncated = true;
    });
    if (paths.length >= MAX_SCANNED_SOURCE_FILES) break;
  }

  const files = new Map<string, ParsedSourceFile>();
  for (const path of paths.slice(0, MAX_SCANNED_SOURCE_FILES)) {
    const absolutePath = resolve(repositoryRoot, path);
    const source = readFileSync(absolutePath, 'utf8');
    const parsed = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      false,
      scriptKindForPath(path),
    );
    const imports: string[] = [];
    const declarations = new Set<string>();
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier !== undefined
        && ts.isStringLiteralLike(node.moduleSpecifier)) {
        imports.push(node.moduleSpecifier.text);
      }
      if (
        ts.isClassDeclaration(node)
        || ts.isFunctionDeclaration(node)
        || ts.isInterfaceDeclaration(node)
        || ts.isTypeAliasDeclaration(node)
        || ts.isEnumDeclaration(node)
      ) {
        if (node.name !== undefined) declarations.add(node.name.text);
      } else if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) declarations.add(declaration.name.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    files.set(path, {
      path,
      absolutePath,
      imports,
      declarations: [...declarations],
    });
  }

  return { files, workspacePackages, truncated: truncated || paths.length > MAX_SCANNED_SOURCE_FILES };
}

function walkSourceFiles(
  repositoryRoot: string,
  directory: string,
  output: string[],
  markTruncated: () => void,
): void {
  if (output.length >= MAX_SCANNED_SOURCE_FILES) {
    markTruncated();
    return;
  }
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (output.length >= MAX_SCANNED_SOURCE_FILES) {
      markTruncated();
      return;
    }
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      walkSourceFiles(repositoryRoot, join(directory, entry.name), output, markTruncated);
      continue;
    }
    if (!entry.isFile() || !SOURCE_EXTENSIONS.has(extname(entry.name))) continue;
    output.push(toPosix(relative(repositoryRoot, join(directory, entry.name))));
  }
}

function discoverWorkspacePackages(repositoryRoot: string): ReadonlyMap<string, WorkspacePackage> {
  const packages = new Map<string, WorkspacePackage>();
  for (const rootName of TOP_LEVEL_SCAN_ROOTS) {
    const root = join(repositoryRoot, rootName);
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packageRoot = join(root, entry.name);
      const packageJsonPath = join(packageRoot, 'package.json');
      if (!existsSync(packageJsonPath)) continue;
      try {
        const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as unknown;
        if (!isRecord(parsed) || typeof parsed.name !== 'string' || parsed.name.trim() === '') continue;
        const sourceEntryCandidates = [
          join(packageRoot, 'src', 'index.ts'),
          join(packageRoot, 'src', 'index.tsx'),
          join(packageRoot, 'index.ts'),
        ]
          .filter((candidate) => existsSync(candidate))
          .map((candidate) => toPosix(relative(repositoryRoot, candidate)));
        packages.set(parsed.name, {
          root: toPosix(relative(repositoryRoot, packageRoot)),
          sourceEntryCandidates,
        });
      } catch {
        // Malformed unrelated package metadata is not a graph authority issue.
      }
    }
  }
  return packages;
}

function resolveImportTarget(
  repositoryRoot: string,
  file: ParsedSourceFile,
  specifier: string,
  scanned: ScannedRepository,
): string | null {
  if (specifier.startsWith('.')) {
    return firstExistingSourceCandidate(repositoryRoot, resolve(dirname(file.absolutePath), specifier), scanned.files);
  }
  for (const [packageName, workspacePackage] of scanned.workspacePackages) {
    if (specifier !== packageName && !specifier.startsWith(`${packageName}/`)) continue;
    const subpath = specifier === packageName ? '' : specifier.slice(packageName.length + 1);
    if (subpath === '') {
      return workspacePackage.sourceEntryCandidates.find((candidate) => scanned.files.has(candidate)) ?? null;
    }
    const base = resolve(repositoryRoot, workspacePackage.root, 'src', subpath);
    return firstExistingSourceCandidate(repositoryRoot, base, scanned.files);
  }
  return null;
}

function firstExistingSourceCandidate(
  repositoryRoot: string,
  unresolved: string,
  files: ReadonlyMap<string, ParsedSourceFile>,
): string | null {
  const extension = extname(unresolved);
  const withoutRuntimeExtension = ['.js', '.jsx', '.mjs', '.cjs'].includes(extension)
    ? unresolved.slice(0, -extension.length)
    : unresolved;
  const candidates = extension !== '' && SOURCE_EXTENSIONS.has(extension)
    ? [unresolved, withoutRuntimeExtension]
    : [unresolved];
  for (const base of candidates) {
    for (const suffix of ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '/index.ts', '/index.tsx']) {
      const path = toPosix(relative(repositoryRoot, `${base}${suffix}`));
      if (!path.startsWith('../') && files.has(path)) return path;
    }
  }
  return null;
}

function extractTask(taskSpecification: unknown): {
  readonly title: string;
  readonly instructions: string;
  readonly files: readonly string[];
} | null {
  if (!isRecord(taskSpecification) || !isRecord(taskSpecification.task)) return null;
  const task = taskSpecification.task;
  const title = typeof task.title === 'string' ? task.title : '';
  const instructions = typeof task.instructions === 'string' ? task.instructions : '';
  const files = Array.isArray(task.files)
    ? task.files.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return { title, instructions, files };
}

function extractRepositoryPaths(text: string): readonly string[] {
  const matches = text.match(/\b(?:apps|packages|tools|docs|infra|scripts)\/[A-Za-z0-9_./*?@-]+/g) ?? [];
  return matches.map((path) => path.replace(/[),.;:]+$/g, ''));
}

function normalizeRepositoryPath(repositoryRoot: string, candidate: string): string | null {
  const withoutGlob = staticGlobPrefix(candidate).replace(/\/$/, '');
  if (withoutGlob === '') return null;
  const absolute = resolve(repositoryRoot, withoutGlob);
  const relativePath = relative(repositoryRoot, absolute);
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`)) return null;
  return toPosix(relativePath);
}

function staticGlobPrefix(pattern: string): string {
  const wildcard = pattern.search(/[?*\[]/);
  const prefix = wildcard === -1 ? pattern : pattern.slice(0, wildcard);
  return prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
}

function containsGlob(pattern: string): boolean {
  return /[?*\[]/.test(pattern);
}

function addHint(
  target: Map<string, MutableHint>,
  path: string,
  score: number,
  reason: string,
): void {
  const current = target.get(path);
  if (current === undefined) {
    target.set(path, { score, reasons: new Set([reason]) });
    return;
  }
  current.score = Math.max(current.score, score);
  current.reasons.add(reason);
}

function mapSet(target: Map<string, Set<string>>, key: string): Set<string> {
  const current = target.get(key);
  if (current !== undefined) return current;
  const created = new Set<string>();
  target.set(key, created);
  return created;
}

function scriptKindForPath(path: string): ts.ScriptKind {
  switch (extname(path)) {
    case '.tsx': return ts.ScriptKind.TSX;
    case '.jsx': return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs': return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
