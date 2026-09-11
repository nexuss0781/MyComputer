import { PathError } from '@nexuss0781/shared';

export function normalizePath(input: string): string {
  if (typeof input !== 'string' || input.length === 0) throw new PathError('path is required');
  if (input.length > 4096) throw new PathError('path too long');
  if (!input.startsWith('/')) throw new PathError('path must be absolute');
  if (input.includes('\0')) throw new PathError('path contains null byte');

  const segments = input.split('/');
  const clean: string[] = [];
  for (const segment of segments) {
    if (segment === '') continue;
    if (segment === '.' || segment === '..') {
      throw new PathError(`path must not contain '${segment}'`);
    }
    clean.push(segment);
  }
  return `/${clean.join('/')}`;
}

export function parentOf(path: string): string | null {
  if (path === '/') return null;
  const lastSlash = path.lastIndexOf('/');
  if (lastSlash <= 0) return '/';
  return path.slice(0, lastSlash);
}

export function basename(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

export function isSubpathOrEqual(child: string, ancestor: string): boolean {
  if (child === ancestor) return true;
  return child.startsWith(`${ancestor}/`);
}

export function isStrictSubpath(child: string, ancestor: string): boolean {
  if (ancestor === '/') return child !== '/';
  return child.startsWith(`${ancestor}/`);
}
