import { constants } from 'node:fs';
import { mkdir, open, rename, lstat } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { parseDuplicateFreeJson } from '../../../dist/domain/src/index.js';

const children = new Set();
export function stopSubprocesses() {
  for (const child of children) child.kill('SIGTERM');
}

export class ServiceError extends Error {
  constructor(code, status = 409) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
export const sha256 = (bytes) =>
  createHash('sha256').update(bytes).digest('hex');
export const randomId = () => randomBytes(32).toString('hex');
export function check(condition, code = 'invalid_request', status = 400) {
  if (!condition) throw new ServiceError(code, status);
}
export function exact(value, keys) {
  check(value && typeof value === 'object' && !Array.isArray(value));
  check(
    Object.keys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)),
  );
  return value;
}
export function confined(root, path) {
  check(typeof path === 'string' && path.length > 0 && !isAbsolute(path));
  const full = resolve(root, path);
  check(!relative(root, full).startsWith('..'));
  return full;
}
export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  check(
    info.isDirectory() &&
      !info.isSymbolicLink() &&
      (info.mode & 0o077) === 0 &&
      info.uid === process.getuid(),
    'service_unavailable',
    503,
  );
}
export async function readOwned(path, maximum = 262144, privateOnly = true) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    check(
      info.isFile() &&
        info.uid === process.getuid() &&
        (!privateOnly || (info.mode & 0o077) === 0) &&
        info.size > 0 &&
        info.size <= maximum,
      'service_unavailable',
      503,
    );
    const bytes = Buffer.alloc(info.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    check(bytesRead === info.size, 'service_unavailable', 503);
    return bytes.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}
export async function readJson(path, maximum = 262144) {
  return parseDuplicateFreeJson(
    (await readOwned(path, maximum)).toString('utf8'),
    maximum,
  );
}
export async function writeNew(path, value) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(JSON.stringify(value) + '\n');
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  const parent = await open(dirname(path), 'r');
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}
export async function replaceJson(path, value) {
  const temporary = `${path}.${randomId()}.tmp`;
  await writeNew(temporary, value);
  await rename(temporary, path);
  const parent = await open(dirname(path), 'r');
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}
export async function optionalJson(path, maximum) {
  try {
    return await readJson(path, maximum);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
export async function runJson(
  binary,
  args,
  { env = {}, timeout = 120000 } = {},
) {
  let child;
  try {
    const pending = promisify(execFile)(binary, args, {
      timeout,
      maxBuffer: 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        ...env,
      },
    });
    child = pending.child;
    children.add(child);
    const result = await pending;
    return parseDuplicateFreeJson(result.stdout.trim(), 1024 * 1024);
  } catch {
    // Process errors may contain signed payloads, artifact URIs or credentials.
    throw new ServiceError('preparation_failed');
  } finally {
    if (child) children.delete(child);
  }
}
