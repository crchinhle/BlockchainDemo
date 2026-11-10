import { spawn } from 'node:child_process';
import { json } from './infrastructure.js';
export async function renderArtifact(
  data: unknown,
  format: 'pdf' | 'png',
): Promise<Buffer> {
  const python =
    process.env.RESEARCH_PYTHON ??
    (process.platform === 'win32'
      ? '.research-local/python/Scripts/python.exe'
      : '.research-local/python/bin/python');
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['scripts/research-report.py', format], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on('data', (b: Buffer) => {
      size += b.length;
      if (size > 20_000_000) {
        child.kill();
        reject(new Error('REPORT_SIZE_LIMIT'));
      } else chunks.push(b);
    });
    child.stderr.resume();
    child.on('error', () => reject(new Error('REPORT_RENDERER_UNAVAILABLE')));
    child.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(new Error('REPORT_RENDER_FAILED')),
    );
    child.stdin.on('error', () => undefined);
    child.stdin.end(json(data));
  });
}
