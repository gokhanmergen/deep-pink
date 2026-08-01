import { parentPort } from 'node:worker_threads'
import { runRepoFind, runRepoRead, runRepoSearch, runRepoTree, treeSummary } from './repo'

/**
 * Runs repository reads on their own thread.
 *
 * Walking a directory is unavoidably synchronous work — a fruitless search over
 * a large repository reads every file — and on the main thread that stalls
 * streaming, IPC and the window along with it. Here it stalls nothing but
 * itself.
 */

export type RepoOp = 'tree' | 'read' | 'search' | 'find' | 'summary'

export interface RepoRequest {
  id: number
  op: RepoOp
  roots: string[]
  args: Record<string, unknown>
}

export type RepoResponse =
  | { id: number; ok: true; result: string }
  | { id: number; ok: false; error: string }

parentPort?.on('message', (request: RepoRequest) => {
  try {
    const { roots, args } = request
    const result =
      request.op === 'tree'
        ? runRepoTree(roots, args)
        : request.op === 'read'
          ? runRepoRead(roots, args)
          : request.op === 'search'
            ? runRepoSearch(roots, args)
            : request.op === 'find'
              ? runRepoFind(roots, args)
              : treeSummary(roots, (args.depth as number) ?? 3, (args.limit as number) ?? 400)

    parentPort?.postMessage({ id: request.id, ok: true, result } satisfies RepoResponse)
  } catch (err) {
    parentPort?.postMessage({
      id: request.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    } satisfies RepoResponse)
  }
})
