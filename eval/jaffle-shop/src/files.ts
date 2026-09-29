/* eslint-disable security/detect-non-literal-fs-filename -- the evaluator opens the paths given on its command line and the directories its tests scan */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function readBytes(path: string): Promise<Buffer> {
  return readFile(path);
}

export async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

export async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

export async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}
