import { createHash } from 'node:crypto';
import { OHA_VERSION } from './oha-release';

type DownloadFetch = (url: string, init?: RequestInit) => Promise<Response>;
export async function downloadOha(
  release: { asset: string; sha256: string },
  fetcher: DownloadFetch = fetch,
): Promise<Uint8Array> {
  const headers = { 'X-GitHub-Api-Version': '2022-11-28' };
  async function get(url: string, accept?: string) {
    const response = await fetcher(url, {
      signal: AbortSignal.timeout(60000),
      headers: { ...headers, ...(accept && { Accept: accept }) },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`oha download failed: HTTP ${response.status}`);
    }
    return response;
  }
  let response: Response;
  try {
    response = await get(
      `https://github.com/hatoo/oha/releases/download/v${OHA_VERSION}/${release.asset}`,
    );
  } catch {
    console.log(
      'Direct oha download unavailable; trying the official GitHub release API.',
    );
    const metadata = await get(
      `https://api.github.com/repos/hatoo/oha/releases/tags/v${OHA_VERSION}`,
      'application/vnd.github+json',
    );
    const data = (await metadata.json()) as {
      assets?: { name: string; id: number }[];
    };
    const asset = data.assets?.find((item) => item.name === release.asset);
    if (!asset || !Number.isSafeInteger(asset.id) || asset.id <= 0)
      throw new Error(
        `oha asset not found in official release: ${release.asset}`,
      );
    response = await get(
      `https://api.github.com/repos/hatoo/oha/releases/assets/${asset.id}`,
      'application/octet-stream',
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== release.sha256)
    throw new Error('oha checksum mismatch');
  return bytes;
}
