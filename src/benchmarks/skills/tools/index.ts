import type { Condition } from '../../../core/types.js';
import type { SurfaceContext, ToolSurface } from '../contracts.js';
import { createCliSurface } from './circleci-cli.js';
import { createMcpSurface } from './mcp-remote.js';
import { applySafetyPolicy } from './safety.js';

export { createCliSurface } from './circleci-cli.js';
export { createMcpSurface, listMcpTools, callMcpHello } from './mcp-remote.js';

/** Picks the CLI or MCP surface from the condition prefix. Skills are layered on separately. */
export async function createSurfaceForCondition(condition: Condition, ctx: SurfaceContext): Promise<ToolSurface> {
  if (condition.startsWith('cli')) return applySafetyPolicy(await createCliSurface(ctx));
  if (condition.startsWith('mcp')) return applySafetyPolicy(await createMcpSurface(ctx));
  throw new Error(`Unknown condition: ${condition}`);
}

type CallMeta = ToolSurface['callMeta'];
type CallMetaValue = CallMeta extends Map<string, infer V> ? V : never;

/**
 * One shared Map for a merged surface. Each child surface's execute() writes to its own
 * callMeta map; this map pulls entries from the children on every read, so callers only
 * need to look at merged.callMeta. Entries set directly on it are kept too.
 */
class MergedCallMeta extends Map<string, CallMetaValue> {
  constructor(private readonly children: CallMeta[]) { super(); }
  private sync(): void {
    for (const c of this.children) for (const [k, v] of c) super.set(k, v);
  }
  override get(key: string) { this.sync(); return super.get(key); }
  override has(key: string) { this.sync(); return super.has(key); }
  override get size() { this.sync(); return super.size; }
  override entries() { this.sync(); return super.entries(); }
  override keys() { this.sync(); return super.keys(); }
  override values() { this.sync(); return super.values(); }
  override forEach(cb: (v: CallMetaValue, k: string, m: Map<string, CallMetaValue>) => void, thisArg?: unknown) {
    this.sync(); super.forEach(cb, thisArg);
  }
  override [Symbol.iterator]() { this.sync(); return super[Symbol.iterator](); }
  override delete(key: string) {
    let hit = super.delete(key);
    for (const c of this.children) hit = c.delete(key) || hit;
    return hit;
  }
  override clear() { super.clear(); for (const c of this.children) c.clear(); }
}

/**
 * Merges surfaces into one: tools (throws on name collision), addenda joined by blank lines,
 * callMeta via a shared view over all children, and close() closes every child.
 * `kind` is the first non-skills surface's kind (or 'skills' if all are skills).
 */
export function mergeSurfaces(surfaces: ToolSurface[]): ToolSurface {
  if (surfaces.length === 0) throw new Error('mergeSurfaces: no surfaces');
  if (surfaces.length === 1) return surfaces[0];

  const tools: ToolSurface['tools'] = {};
  for (const s of surfaces) {
    for (const [name, t] of Object.entries(s.tools)) {
      if (name in tools) throw new Error(`mergeSurfaces: tool name collision "${name}" (surface ${s.kind})`);
      tools[name] = t;
    }
  }
  const addendum = surfaces.map((s) => s.systemPromptAddendum?.trim()).filter(Boolean).join('\n\n');
  const kind = surfaces.find((s) => s.kind !== 'skills')?.kind ?? 'skills';

  return {
    kind,
    tools,
    systemPromptAddendum: addendum || undefined,
    callMeta: new MergedCallMeta(surfaces.map((s) => s.callMeta)),
    close: async () => {
      const results = await Promise.allSettled(surfaces.map((s) => s.close()));
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) throw failed.reason;
    },
  };
}
