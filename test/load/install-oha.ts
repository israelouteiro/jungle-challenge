import { downloadOha } from './download-oha';
import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { OHA_VERSION, ohaRelease, localOhaPath } from './oha-release';
const release = ohaRelease();
const destination = localOhaPath();
const temporary = `${destination}.download`;
await mkdir(dirname(destination), { recursive: true });
try {
  const bytes = await downloadOha(release);
  await Bun.write(temporary, bytes);
  await chmod(temporary, 0o755);
  await rename(temporary, destination);
  console.log(
    `Installed oha ${OHA_VERSION}: ${destination} (SHA-256 verified)`,
  );
} finally {
  await rm(temporary, { force: true });
}
