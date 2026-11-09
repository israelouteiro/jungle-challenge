import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { downloadOha } from '../load/download-oha';

const content = 'verified fixture';
const release = {
  asset: 'oha-linux-arm64',
  sha256: createHash('sha256').update(content).digest('hex'),
};

test('oha direct download is verified without consulting the API', async () => {
  const calls: string[] = [];
  const result = await downloadOha(release, async (url) => {
    calls.push(url);
    return new Response(content);
  });
  expect(new TextDecoder().decode(result)).toBe(content);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain('https://github.com/hatoo/oha/releases/download/');
});

test('oha HTTP 504 falls back to the official API and verifies the same checksum', async () => {
  const calls: { url: string; accept: string | null }[] = [];
  const result = await downloadOha(release, async (url, init) => {
    calls.push({ url, accept: new Headers(init?.headers).get('Accept') });
    if (url.includes('github.com/hatoo/'))
      return new Response('Unavailable', { status: 504 });
    if (url.includes('/tags/'))
      return Response.json({ assets: [{ name: release.asset, id: 123 }] });
    return new Response(content);
  });
  expect(new TextDecoder().decode(result)).toBe(content);
  expect(calls).toHaveLength(3);
  expect(calls[2]).toEqual({
    url: 'https://api.github.com/repos/hatoo/oha/releases/assets/123',
    accept: 'application/octet-stream',
  });
});

test('oha rejects a corrupted download without bypassing checksum verification', async () => {
  await expect(
    downloadOha(release, async () => new Response('corrupted')),
  ).rejects.toThrow('oha checksum mismatch');
});

test('oha refuses to select another platform asset when the requested asset is absent', async () => {
  await expect(
    downloadOha(release, async (url) =>
      url.includes('/tags/')
        ? Response.json({ assets: [{ name: 'other-platform', id: 123 }] })
        : new Response('Unavailable', { status: 504 }),
    ),
  ).rejects.toThrow('oha asset not found');
});
