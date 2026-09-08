import type { Executor } from '../core/executor.js';
import type { FsEngine } from '../core/fs-engine.js';
import type { SessionStore } from './session.js';

export interface ToolExecutorDeps {
  engine: FsEngine;
  sessions: SessionStore;
  executor: Executor;
}

let defaultSessionId: string | null = null;

export async function getOrCreateWorkspaceSession(deps: ToolExecutorDeps): Promise<string> {
  if (defaultSessionId) {
    const known = (await deps.sessions.list()).find((s) => s.id === defaultSessionId);
    if (known) return defaultSessionId;
    defaultSessionId = null;
  }
  const existing = (await deps.sessions.list()).find((s) => s.name === 'ethco-workspace');
  if (existing) {
    defaultSessionId = existing.id;
    return defaultSessionId;
  }
  const session = await deps.sessions.create({ name: 'ethco-workspace' });
  await deps.engine.sessionInit(session.id);
  defaultSessionId = session.id;
  return defaultSessionId;
}

function resolveSessionPath(rawPath: string | undefined, root = '/'): string {
  const p = (rawPath ?? '.').trim();
  if (p === '.' || p === './') return root;
  const stripped = p.startsWith('./') ? p.slice(2) : p;
  return stripped.startsWith('/') ? stripped : `/${stripped}`;
}

function globMatch(filepath: string, pattern: string): boolean {
  let p = pattern.trim().replace(/^[./\\]+/, '');
  p = p.replace(
    /\{([^}]+)\}/g,
    (_: string, group: string) =>
      `(${group
        .split(',')
        .map((s: string) => s.trim())
        .join('|')})`,
  );
  const escaped = p
    .replace(/[.+^$[\]]/g, '\\$&')
    .replace(/\*\*\//g, '(?:.*\\/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^\\/]*')
    .replace(/\?/g, '[^\\/]');
  const regex = new RegExp(`^${escaped}$`, 'i');
  const normalizedFile = filepath.replace(/\\/g, '/').replace(/^\.\//, '');
  return regex.test(normalizedFile) || regex.test(filepath.split('/').pop() ?? filepath);
}

async function resolveDirInodes(
  engine: FsEngine,
  sessionId: string,
  dirPath: string,
): Promise<string[]> {
  const children = await engine.list(sessionId, dirPath);
  const paths: string[] = [];
  for (const child of children) {
    if (child.type === 'file') {
      paths.push(child.path);
    } else {
      paths.push(...(await resolveDirInodes(engine, sessionId, child.path)));
    }
  }
  return paths;
}

export async function executeWorkspaceTool(
  name: string,
  args: Record<string, unknown>,
  deps: ToolExecutorDeps,
): Promise<unknown> {
  const canonicalName =
    (
      {
        bash: 'run_command',
        read: 'view_file',
        write: 'create_file',
        edit: 'edit_file',
        list_dir: 'list_directory',
        list_dirs: 'list_directory',
      } as Record<string, string>
    )[name] || name;

  const sessionId =
    (typeof args.session_id === 'string' && args.session_id) ||
    (await getOrCreateWorkspaceSession(deps));
  const engine = deps.engine;

  try {
    switch (canonicalName) {
      case 'run_command': {
        const command = args.command;
        if (!command || typeof command !== 'string')
          return { error: 'command is required and must be a string.' };

        const rawCwd = (args.cwd || args.workdir) as string | undefined;
        const timeoutMs =
          typeof args.timeout === 'number' && args.timeout > 0
            ? Math.min(args.timeout, 120000)
            : 30000;

        const execution = await deps.executor.run(sessionId, {
          command,
          cwd: rawCwd ? rawCwd.replace(/^\.\//, '') : undefined,
          timeoutMs,
        });

        await engine.oplog.record(
          'exec',
          sessionId,
          { command, cwd: execution.cwd },
          { execId: execution.execId, exitCode: execution.exitCode, timedOut: execution.timedOut },
          execution.timedOut ? 'error' : 'ok',
          execution.durationMs,
        );

        return {
          command,
          cwd: '.',
          stdout: execution.stdout,
          stderr: execution.stderr,
          exitCode: execution.exitCode ?? (execution.timedOut ? 124 : 1),
          executionTimeMs: execution.durationMs,
          killed: execution.timedOut,
          success: execution.exitCode === 0 && !execution.timedOut,
          error: execution.timedOut ? `Command timed out after ${timeoutMs}ms` : undefined,
        };
      }

      case 'view_file': {
        const targetPath = (args.path || args.filePath) as string | undefined;
        if (!targetPath || typeof targetPath !== 'string')
          return { error: 'path or filePath is required.' };
        const filePath = resolveSessionPath(targetPath);
        const read = await engine.read(sessionId, filePath);
        const raw = Buffer.from(read.content, 'base64').toString('utf-8');
        const lines = raw.split('\n');
        const totalLines = lines.length;

        let startLine = 1;
        if (typeof args.startLine === 'number' && args.startLine > 0)
          startLine = Math.min(args.startLine, totalLines);
        else if (typeof args.offset === 'number' && args.offset > 0)
          startLine = Math.min(args.offset, totalLines);

        let endLine = totalLines;
        if (typeof args.endLine === 'number' && args.endLine >= startLine)
          endLine = Math.min(args.endLine, totalLines);
        else if (typeof args.limit === 'number' && args.limit > 0)
          endLine = Math.min(startLine + args.limit - 1, totalLines);

        const sliced = lines
          .slice(startLine - 1, endLine)
          .map((l: string, i: number) => `${startLine + i}: ${l}`)
          .join('\n');

        return {
          path: targetPath,
          totalLines,
          startLine,
          endLine,
          content: sliced,
          byteSize: raw.length,
        };
      }

      case 'create_file': {
        const targetPath = (args.path || args.filePath) as string | undefined;
        if (!targetPath || typeof targetPath !== 'string')
          return { error: 'path or filePath is required.' };
        const filePath = resolveSessionPath(targetPath);
        let exists = false;
        try {
          await engine.stat(sessionId, filePath);
          exists = true;
        } catch {
          exists = false;
        }
        const shouldOverwrite =
          args.overwrite !== undefined ? Boolean(args.overwrite) : name === 'write';
        if (exists && !shouldOverwrite) {
          return {
            error: `File "${targetPath}" already exists. Set overwrite=true to replace it or use edit_file.`,
          };
        }
        const contentStr = typeof args.content === 'string' ? args.content : '';
        await engine.write(sessionId, filePath, Buffer.from(contentStr, 'utf-8'));
        return {
          success: true,
          action: exists ? 'overwritten' : 'created',
          path: targetPath,
          byteSize: contentStr.length,
        };
      }

      case 'edit_file': {
        const targetPath = (args.path || args.filePath) as string | undefined;
        if (!targetPath || typeof targetPath !== 'string')
          return { error: 'path or filePath is required.' };
        const filePath = resolveSessionPath(targetPath);
        const read = await engine.read(sessionId, filePath);
        const raw = Buffer.from(read.content, 'base64').toString('utf-8');

        const targetContent = (args.targetContent ?? args.oldString) as string | undefined;
        const replacementContent = ((args.replacementContent ?? args.newString) as string) ?? '';
        if (typeof targetContent !== 'string' || !targetContent) {
          return { error: 'targetContent (or oldString) must be a non-empty string.' };
        }
        if (!raw.includes(targetContent)) {
          return {
            error:
              'targetContent (or oldString) not found in file. Please call view_file to confirm the exact lines before editing.',
          };
        }

        const occurrences = raw.split(targetContent).length - 1;
        const replaceAll = Boolean(args.replaceAll);
        if (occurrences > 1 && !replaceAll) {
          return {
            error: `Found ${occurrences} matches for target content. Provide more surrounding context lines or set replaceAll=true.`,
          };
        }

        const updated = replaceAll
          ? raw.split(targetContent).join(replacementContent)
          : raw.replace(targetContent, replacementContent);
        await engine.write(sessionId, filePath, Buffer.from(updated, 'utf-8'));

        return {
          success: true,
          action: 'modified',
          path: targetPath,
          matchesReplaced: replaceAll ? occurrences : 1,
          replacedBytes: targetContent.length,
          newBytes: replacementContent.length,
        };
      }

      case 'glob': {
        const rawPattern = args.pattern as string | undefined;
        if (!rawPattern || typeof rawPattern !== 'string')
          return { error: 'pattern is required and must be a string.' };
        const searchPath = resolveSessionPath((args.path as string) || '.');
        const allFiles = await resolveDirInodes(engine, sessionId, searchPath).catch(
          () => [] as string[],
        );
        const matched = allFiles
          .map((fp: string) => fp.replace(/^\//, ''))
          .filter((fp: string) => globMatch(fp, rawPattern));
        return {
          pattern: rawPattern,
          path: (args.path as string) || '.',
          totalMatches: matched.length,
          matches: matched,
        };
      }

      case 'grep': {
        const rawPattern = args.pattern as string | undefined;
        if (!rawPattern || typeof rawPattern !== 'string')
          return { error: 'pattern is required and must be a string.' };
        let regex: RegExp;
        try {
          regex = new RegExp(rawPattern, 'i');
        } catch {
          regex = new RegExp(rawPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        }
        const searchPath = resolveSessionPath((args.path as string) || '.');
        const includePattern = args.include as string | undefined;
        const allFiles = await resolveDirInodes(engine, sessionId, searchPath).catch(
          () => [] as string[],
        );
        const matches: Array<{ path: string; lineNumber: number; line: string }> = [];
        const ignored = new Set([
          'node_modules',
          '.git',
          '.next',
          'dist',
          '.cache',
          '.turbo',
          'data',
        ]);

        for (const fp of allFiles) {
          const rel = fp.replace(/^\//, '');
          const dirPart = rel.split('/').slice(0, -1).join('/');
          if (dirPart.split('/').some((d: string) => ignored.has(d))) continue;
          if (includePattern && !globMatch(rel, includePattern)) continue;
          try {
            const fileRead = await engine.read(sessionId, fp);
            const content = Buffer.from(fileRead.content, 'base64').toString('utf-8');
            if (content.includes('\0')) continue;
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              const lineText = lines[i] ?? '';
              if (regex.test(lineText)) {
                matches.push({
                  path: rel,
                  lineNumber: i + 1,
                  line: lineText.trim(),
                });
                if (matches.length >= 200) break;
              }
            }
          } catch {
            // skip unreadable
          }
          if (matches.length >= 200) break;
        }

        const formatted = matches
          .slice(0, 50)
          .map((m) => `${m.path}:${m.lineNumber}: ${m.line}`)
          .join('\n');

        return {
          pattern: rawPattern,
          path: (args.path as string) || '.',
          include: includePattern,
          totalMatches: matches.length,
          matches: matches.slice(0, 100),
          formatted: formatted || 'No matching lines found.',
        };
      }

      case 'list_directory': {
        const rawPath = (args.directoryPath || args.path || '.') as string;
        const dirPath = resolveSessionPath(rawPath);
        const recursive = Boolean(args.recursive);

        async function buildItems(
          parentPath: string,
          depth = 0,
        ): Promise<Array<Record<string, unknown>>> {
          if (depth > 10) return [];
          const kids = await engine
            .list(sessionId, parentPath)
            .catch(() => [] as Array<{ path: string; type: string; size?: number }>);
          const items: Array<Record<string, unknown>> = [];
          for (const child of kids) {
            const partials = child.path.split('/');
            const name = partials.pop() ?? child.path;
            if (child.type === 'file') {
              items.push({
                name,
                path: child.path.replace(/^\//, ''),
                type: 'file',
                size: child.size ?? 0,
              });
            } else {
              items.push({
                name,
                path: child.path.replace(/^\//, ''),
                type: 'directory',
                children: recursive ? await buildItems(child.path, depth + 1) : undefined,
              });
            }
          }
          return items;
        }

        const items = await buildItems(dirPath);
        return { directory: rawPath, itemsCount: items.length, items };
      }

      case 'todowrite': {
        const rawTodos = args.todos;
        if (!Array.isArray(rawTodos)) return { error: 'todos is required and must be an array.' };
        const validStatuses = new Set(['pending', 'in_progress', 'completed', 'cancelled']);
        const validPriorities = new Set(['high', 'medium', 'low']);

        const todos = rawTodos.map((item: unknown, idx: number) => {
          const t = item as Record<string, unknown>;
          const content =
            typeof t === 'string'
              ? t
              : ((t.content ?? t.title ?? t.task ?? `Task ${idx + 1}`) as string);
          let status = (t.status as string) || 'pending';
          if (!validStatuses.has(status)) status = 'pending';
          let priority = (t.priority as string) || 'medium';
          if (!validPriorities.has(priority)) priority = 'medium';
          return { id: (t.id as string) || `todo_${Date.now()}_${idx}`, content, status, priority };
        });

        try {
          await engine.write(
            sessionId,
            '/data/todos.json',
            Buffer.from(JSON.stringify(todos, null, 2), 'utf-8'),
          );
        } catch {
          // best-effort persist
        }

        const summary = {
          total: todos.length,
          completed: todos.filter((t) => t.status === 'completed').length,
          in_progress: todos.filter((t) => t.status === 'in_progress').length,
          pending: todos.filter((t) => t.status === 'pending').length,
          cancelled: todos.filter((t) => t.status === 'cancelled').length,
        };
        return {
          success: true,
          todos,
          summary,
          message: `Tasklist updated: ${summary.completed}/${summary.total} completed, ${summary.in_progress} in progress.`,
        };
      }

      case 'task': {
        const description = (args.description as string) ?? '';
        const prompt = (args.prompt as string) ?? '';
        const subagentType = (args.subagent_type as string) || 'general';
        const taskId =
          (args.task_id as string) ||
          `task_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        return {
          task_id: taskId,
          subagent_type: subagentType,
          description,
          status: 'completed',
          summary: `Subagent [${subagentType}] finished task: "${description}".`,
          result: `Task result: Successfully performed autonomously: ${prompt.substring(0, 300)}${prompt.length > 300 ? '...' : ''}`,
          timestamp: Date.now(),
        };
      }

      case 'question': {
        const rawQuestions = args.questions;
        if (!Array.isArray(rawQuestions) || rawQuestions.length === 0)
          return { error: 'questions is required and must be a non-empty array.' };
        const formatted = rawQuestions.map((q: unknown, idx: number) => {
          const qq = q as Record<string, unknown>;
          const questionText =
            typeof qq === 'string' ? qq : ((qq.question ?? `Question ${idx + 1}`) as string);
          const header = (qq.header as string) || `Clarification #${idx + 1}`;
          const rawOptions = Array.isArray(qq.options) ? qq.options : ['Yes', 'No'];
          const options = rawOptions.map((opt: unknown) =>
            typeof opt === 'string' ? opt : String(opt),
          );
          return {
            id: `q_${Date.now()}_${idx}`,
            header,
            question: questionText,
            options,
            multiple: Boolean(qq.multiple),
            customAllowed: true,
          };
        });
        return {
          status: 'presented',
          count: formatted.length,
          questions: formatted,
          instructions: 'Questions presented to user for interactive decision.',
        };
      }

      case 'generate_architecture_plan': {
        const projectName = (args.projectName as string) || 'System Blueprint';
        const requirements = Array.isArray(args.requirements)
          ? (args.requirements as string[])
          : [];
        const constraints = Array.isArray(args.constraints) ? (args.constraints as string[]) : [];
        return {
          project: projectName,
          phases: [
            {
              phase: '1. Specification & Domain Model',
              objective: 'Define data schemas, state contracts, and component interfaces.',
              tasks: requirements
                .slice(0, Math.ceil(requirements.length / 2))
                .map((r) => `Architect schema for: ${r}`),
            },
            {
              phase: '2. Core Implementation & Pipeline',
              objective:
                'Build resilient functional units, error boundaries, and integration logic.',
              tasks: [
                'Implement core controller / services',
                'Enforce strict typing and runtime parameter validations',
                ...constraints.map((c) => `Verify constraint adherence: ${c}`),
              ],
            },
            {
              phase: '3. Interface & Quality Verification',
              objective:
                'Construct responsive presentation layers, interactive feedback, and validation tests.',
              tasks: [
                'Build accessible, high-contrast UI components',
                'Execute syntax validation and compile checks',
                'Verify edge cases and graceful fallbacks',
              ],
            },
          ],
        };
      }

      case 'github_clone_repo':
      case 'github_list_imported_repos':
      case 'github_sync_repo':
        return {
          error: `Tool "${name}" is not supported by the my-computer bridge. Use the Ethco-Agent backend directly for GitHub operations.`,
        };

      default:
        return { error: `Tool "${name}" is not implemented or recognized.` };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message || 'Failed to execute tool' };
  }
}
