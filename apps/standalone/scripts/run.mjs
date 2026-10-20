import { spawn } from 'node:child_process';
const profile = process.argv[2] ?? 'combined';
if (!['atlas','story','combined'].includes(profile)) throw new Error('Unknown profile');
const build = spawn('pnpm', [`build:${profile}`], {stdio:'inherit'});
build.on('exit', code => {
  if (code !== 0) process.exit(code ?? 1);
  const server = spawn(process.execPath, ['scripts/serve.mjs', profile], {stdio:'inherit'});
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => server.kill(signal));
  server.on('exit', status => process.exit(status ?? 1));
});
