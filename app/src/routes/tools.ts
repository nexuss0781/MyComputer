import type { Hono } from 'hono';
import { WORKSPACE_TOOL_DECLARATIONS } from '../ethco-tools.js';
import { type ToolExecutorDeps, executeWorkspaceTool } from '../tool-executor.js';

export function toolRoutes(deps: ToolExecutorDeps, app: Hono): void {
  app.get('/api/tools', (c) => {
    return c.json({ tools: WORKSPACE_TOOL_DECLARATIONS });
  });

  app.post('/api/tools/execute', async (c) => {
    try {
      const body: unknown = await c.req.json().catch(() => null);
      const { name, command, tool, action, args } = (body ?? {}) as Record<string, unknown>;
      const toolName = (name || command || tool || action) as string | undefined;
      if (!toolName) {
        return c.json({ error: 'Tool name is required' }, 400);
      }
      const result = await executeWorkspaceTool(
        toolName,
        (args as Record<string, unknown>) ?? {},
        deps,
      );
      return c.json({ success: !(result as Record<string, unknown>).error, result });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Tool execution failed';
      return c.json({ error: message }, 500);
    }
  });
}
