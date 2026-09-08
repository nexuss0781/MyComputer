export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const WORKSPACE_TOOL_DECLARATIONS: ToolDefinition[] = [
  {
    name: 'bash',
    description:
      'Execute a shell command (e.g. git, npm, docker, curl, etc.) in the workspace terminal environment.',
    parameters: {
      type: 'OBJECT',
      properties: {
        command: { type: 'STRING', description: 'The complete command line string to execute' },
        workdir: {
          type: 'STRING',
          description: 'Working directory relative to project root (defaults to workspace root)',
        },
        timeout: {
          type: 'INTEGER',
          description: 'Execution timeout in milliseconds (defaults to 30000 ms)',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'run_command',
    description:
      'Execute a shell or linux command (e.g. bash, git, npm, curl, echo, cat, ls, sudo, find, grep, etc.) in the workspace container environment.',
    parameters: {
      type: 'OBJECT',
      properties: {
        command: {
          type: 'STRING',
          description:
            "The complete command-line string to execute (e.g., 'git status', 'npm test', 'find . -name \"*.tsx\"', 'ls -la')",
        },
        cwd: {
          type: 'STRING',
          description:
            'Optional working directory relative to project root to execute the command in (defaults to workspace root).',
        },
        timeout: {
          type: 'INTEGER',
          description:
            'Optional execution timeout in milliseconds (defaults to 30000 ms / 30 seconds).',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'read',
    description: 'Read a file or directory from the local filesystem with line numbers.',
    parameters: {
      type: 'OBJECT',
      properties: {
        filePath: { type: 'STRING', description: 'The path to the file or directory to read' },
        offset: { type: 'INTEGER', description: 'The line number to start from (1-indexed)' },
        limit: {
          type: 'INTEGER',
          description: 'The maximum number of lines to read (defaults to 2000)',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'view_file',
    description:
      'Read contents of a file in the workspace with line numbers and optional line bounds.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: {
          type: 'STRING',
          description:
            "Relative or absolute path to the file in the workspace (e.g. 'src/App.tsx' or 'package.json')",
        },
        startLine: { type: 'INTEGER', description: '1-indexed starting line number (optional)' },
        endLine: { type: 'INTEGER', description: '1-indexed ending line number (optional)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write',
    description: 'Writes a file to the local filesystem. Automatically creates parent directories.',
    parameters: {
      type: 'OBJECT',
      properties: {
        filePath: { type: 'STRING', description: 'The path to the file to write' },
        content: { type: 'STRING', description: 'The content to write to the file' },
      },
      required: ['filePath', 'content'],
    },
  },
  {
    name: 'create_file',
    description:
      'Create a new file with content in the workspace. Automatically creates parent directories.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'Path where the file should be created' },
        content: { type: 'STRING', description: 'The complete content to write into the file' },
        overwrite: {
          type: 'BOOLEAN',
          description: 'Set to true to overwrite an existing file. Defaults to false.',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit',
    description: 'Performs exact string replacements in files.',
    parameters: {
      type: 'OBJECT',
      properties: {
        filePath: { type: 'STRING', description: 'The path to the file to edit' },
        oldString: { type: 'STRING', description: 'The exact character sequence to replace' },
        newString: { type: 'STRING', description: 'The replacement content' },
        replaceAll: {
          type: 'BOOLEAN',
          description: 'Whether to replace all occurrences of oldString in the file',
        },
      },
      required: ['filePath', 'oldString', 'newString'],
    },
  },
  {
    name: 'edit_file',
    description: 'Perform an exact substring replacement inside an existing workspace file.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'Path to the file to modify' },
        targetContent: {
          type: 'STRING',
          description:
            'The exact character-sequence to be replaced (must match existing content exactly)',
        },
        replacementContent: {
          type: 'STRING',
          description: 'The replacement content to substitute in place of targetContent',
        },
        replaceAll: { type: 'BOOLEAN', description: 'Set to true to replace all occurrences' },
      },
      required: ['path', 'targetContent', 'replacementContent'],
    },
  },
  {
    name: 'glob',
    description:
      "Fast file pattern matching tool that works with any codebase size. Supports glob patterns like '**/*.js' or 'src/**/*.ts'. Returns matching file paths.",
    parameters: {
      type: 'OBJECT',
      properties: {
        pattern: {
          type: 'STRING',
          description:
            "The glob pattern to match files against (e.g. '**/*.ts', 'src/components/**/*.tsx', '*.json')",
        },
        path: {
          type: 'STRING',
          description: 'The directory to search in. Defaults to the current working directory.',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description:
      "Fast content search tool that works with any codebase size. Searches file contents using regular expressions. Filter files by pattern with the include parameter (e.g. '*.js', '*.{ts,tsx}'). Returns file paths and line numbers with matching lines.",
    parameters: {
      type: 'OBJECT',
      properties: {
        pattern: {
          type: 'STRING',
          description: 'The regex pattern to search for in file contents',
        },
        path: {
          type: 'STRING',
          description: 'The directory to search in. Defaults to current working directory.',
        },
        include: {
          type: 'STRING',
          description:
            "File pattern to include in the search (e.g. '*.js', '*.{ts,tsx}', '*.json')",
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'todowrite',
    description:
      'Create and maintain a structured task list for the current coding session. Tracks progress, organizes multi-step work, and surfaces status to the user.',
    parameters: {
      type: 'OBJECT',
      properties: {
        todos: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              content: { type: 'STRING', description: 'The description of the todo item' },
              status: {
                type: 'STRING',
                description: 'Status: pending, in_progress, completed, or cancelled',
              },
              priority: { type: 'STRING', description: 'Priority: high, medium, or low' },
            },
            required: ['content'],
          },
          description: 'The updated todo list [{content, status, priority}]',
        },
      },
      required: ['todos'],
    },
  },
  {
    name: 'task',
    description:
      "Launch a new agent to handle complex, multistep tasks autonomously. Subagent types: 'explore' for codebase discovery, 'general' for multi-step tasks.",
    parameters: {
      type: 'OBJECT',
      properties: {
        description: { type: 'STRING', description: 'A short (3-5 words) description of the task' },
        prompt: { type: 'STRING', description: 'The task for the agent to perform autonomously' },
        subagent_type: {
          type: 'STRING',
          description: "The type of specialized agent to use for this task ('explore' | 'general')",
        },
        task_id: {
          type: 'STRING',
          description: 'Optional task_id if resuming a previous subagent session',
        },
        command: { type: 'STRING', description: 'Optional command that triggered this task' },
      },
      required: ['description', 'prompt', 'subagent_type'],
    },
  },
  {
    name: 'question',
    description:
      'Ask the user clarifying questions, gather requirements, or offer choices during execution.',
    parameters: {
      type: 'OBJECT',
      properties: {
        questions: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              question: { type: 'STRING', description: 'The question to ask the user' },
              header: {
                type: 'STRING',
                description: 'Optional header or category for the question',
              },
              options: {
                type: 'ARRAY',
                items: { type: 'STRING' },
                description: 'Array of available options for user selection',
              },
              multiple: { type: 'BOOLEAN', description: 'Whether multiple selections are allowed' },
            },
            required: ['question'],
          },
          description: 'Array of question objects [{question, header, options, multiple?}]',
        },
      },
      required: ['questions'],
    },
  },
  {
    name: 'generate_architecture_plan',
    description:
      'Generates a structured system architecture specification, component interaction blueprint, and step-by-step milestone roadmap.',
    parameters: {
      type: 'OBJECT',
      properties: {
        projectName: { type: 'STRING', description: 'Name of the system, feature, or project' },
        requirements: {
          type: 'ARRAY',
          items: { type: 'STRING' },
          description: 'Key functional and non-functional requirements',
        },
        constraints: {
          type: 'ARRAY',
          items: { type: 'STRING' },
          description:
            'Technical or environment constraints (e.g. client-only, offline, performance limits)',
        },
      },
      required: ['projectName', 'requirements'],
    },
  },
];
