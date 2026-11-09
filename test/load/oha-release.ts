import process from 'node:process';
import { resolve } from 'node:path';
export const OHA_VERSION = '1.16.0';
const releases: Record<string, { asset: string; sha256: string }> = {
  'darwin-arm64': {
    asset: 'oha-macos-arm64',
    sha256: '7dea53ecb8342a7a067e1976fd0aef44ac33d9cc6b1e65c53637ffb932da63c4',
  },
  'darwin-x64': {
    asset: 'oha-macos-amd64',
    sha256: '5ecbfc5233e3f1d30384e142a9a8dd7ebf9d3298ab22476fabac44a8f2117e08',
  },
  'linux-arm64': {
    asset: 'oha-linux-arm64',
    sha256: '99a790eb8c3e0feaca974bd6b32f0f8d4426a0c5b289f39e833e5b2c7529cd39',
  },
  'linux-x64': {
    asset: 'oha-linux-amd64',
    sha256: '620bb9e16fb53eabc9a3fc45f88bdb41fefa3fee5c05e75892011ce320391716',
  },
};
export function ohaRelease() {
  const release = releases[`${process.platform}-${process.arch}`];
  if (!release)
    throw new Error(
      'Unsupported platform for local oha installer; set OHA_BIN to oha 1.16.0',
    );
  return release;
}
export function localOhaPath(): string {
  return resolve('.tools', `oha-${OHA_VERSION}`);
}
export function ohaPath(): string {
  return process.env.OHA_BIN ?? localOhaPath();
}
