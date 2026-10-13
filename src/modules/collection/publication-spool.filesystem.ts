import { promises as fs } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

export type SpoolFilesystem = 'tmpfs' | 'ramfs' | 'ext' | 'xfs' | 'btrfs' | 'overlay' | 'unknown';
export type SpoolStorage = 'memory_backed' | 'local_filesystem' | 'unknown';

/** Fixed-cardinality labels only: never report a path, mount options or an OS error. */
export interface PublicationSpoolFilesystem {
  spoolFilesystem: SpoolFilesystem;
  spoolStorage: SpoolStorage;
  spoolFilesystemProbe: 'statfs' | 'mountinfo' | 'unavailable' | 'timeout';
  spoolFreeBytes?: number;
}

export const SPOOL_FILESYSTEM_PROBE_TIMEOUT_MS = 100;
const MAX_MOUNTINFO_BYTES = 64 * 1024;
const UNKNOWN: PublicationSpoolFilesystem = {
  spoolFilesystem: 'unknown', spoolStorage: 'unknown', spoolFilesystemProbe: 'unavailable',
};

const MAGIC_TYPES = new Map<number, SpoolFilesystem>([
  [0x01021994, 'tmpfs'], [0x858458f6, 'ramfs'], [0xef53, 'ext'],
  [0x58465342, 'xfs'], [0x9123683e, 'btrfs'], [0x794c7630, 'overlay'],
]);

function storage(filesystem: SpoolFilesystem): SpoolStorage {
  if (filesystem === 'tmpfs' || filesystem === 'ramfs') return 'memory_backed';
  if (filesystem === 'ext' || filesystem === 'xfs' || filesystem === 'btrfs') return 'local_filesystem';
  // In particular, overlay's upper layer can itself be tmpfs. Do not call it disk.
  return 'unknown';
}

function mountFilesystem(name: string | undefined): SpoolFilesystem {
  if (name === 'ext2' || name === 'ext3' || name === 'ext4') return 'ext';
  if (name === 'tmpfs' || name === 'ramfs' || name === 'xfs' || name === 'btrfs' || name === 'overlay') return name;
  return 'unknown';
}

/** /proc/self/mountinfo escapes spaces, tabs, linefeeds and backslashes in paths. */
function unescapeMountPath(path: string): string {
  return path.replace(/\\(040|011|012|134)/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

export function filesystemFromMountInfo(directory: string, mountinfo: string): SpoolFilesystem {
  let nearestLength = -1;
  let nearest: SpoolFilesystem = 'unknown';
  for (const line of mountinfo.split('\n')) {
    const separator = line.indexOf(' - ');
    if (separator < 0) continue;
    const mount = line.slice(0, separator).split(' ')[4];
    if (!mount) continue;
    const mountPath = unescapeMountPath(mount);
    if (!isAbsolute(mountPath)) continue;
    const child = relative(mountPath, directory);
    if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) continue;
    if (mountPath.length === nearestLength) {
      // Stacked mounts at the same location are ambiguous without resolving
      // mount IDs. Never let an earlier disk entry hide a later memory mount.
      if (nearest !== mountFilesystem(line.slice(separator + 3).split(' ')[0])) nearest = 'unknown';
      continue;
    }
    if (mountPath.length < nearestLength) continue;
    nearestLength = mountPath.length;
    nearest = mountFilesystem(line.slice(separator + 3).split(' ')[0]);
  }
  return nearest;
}

async function inspectMount(directory: string): Promise<SpoolFilesystem> {
  if (process.platform !== 'linux') return 'unknown';
  // Bounded read: mount tables can be large in containers. If incomplete, do
  // not infer an ancestor mount while a more specific mount might be missing.
  const handle = await fs.open('/proc/self/mountinfo', 'r');
  try {
    const buffer = Buffer.allocUnsafe(MAX_MOUNTINFO_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > MAX_MOUNTINFO_BYTES) return 'unknown';
    return filesystemFromMountInfo(await fs.realpath(directory), buffer.subarray(0, size).toString('utf8'));
  } finally {
    await handle.close();
  }
}

/** Best-effort, bounded observation only. A missing, denied or stuck diagnostic
 * must never fail a collection or assert that temporary storage is disk-backed. */
export async function inspectPublicationSpoolFilesystem(
  directory: string,
  timeoutMs = SPOOL_FILESYSTEM_PROBE_TIMEOUT_MS,
): Promise<Readonly<PublicationSpoolFilesystem>> {
  let timer: NodeJS.Timeout | undefined;
  const inspect = async (): Promise<PublicationSpoolFilesystem> => {
    let result = { ...UNKNOWN };
    try {
      const stats = await fs.statfs(directory);
      const filesystem = Number.isInteger(stats.type) ? MAGIC_TYPES.get(stats.type >>> 0) ?? 'unknown' : 'unknown';
      const freeBytes = stats.bavail * stats.bsize;
      result = {
        spoolFilesystem: filesystem, spoolStorage: storage(filesystem), spoolFilesystemProbe: 'statfs',
        ...(Number.isSafeInteger(freeBytes) && freeBytes >= 0 ? { spoolFreeBytes: freeBytes } : {}),
      };
      if (filesystem !== 'unknown') return result;
    } catch { /* Preserve collection semantics if statfs is unsupported or denied. */ }
    try {
      const filesystem = await inspectMount(directory);
      if (filesystem !== 'unknown') return {
        ...result, spoolFilesystem: filesystem, spoolStorage: storage(filesystem), spoolFilesystemProbe: 'mountinfo',
      };
    } catch { /* No raw filesystem errors or mount paths leave this function. */ }
    return result;
  };
  try {
    return Object.freeze(await Promise.race([
      inspect().catch(() => ({ ...UNKNOWN })),
      new Promise<PublicationSpoolFilesystem>(resolve => {
        timer = setTimeout(() => resolve({ ...UNKNOWN, spoolFilesystemProbe: 'timeout' }), timeoutMs);
      }),
    ]));
  } finally {
    if (timer) clearTimeout(timer);
  }
}
