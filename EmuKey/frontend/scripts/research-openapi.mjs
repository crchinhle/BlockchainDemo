import { createClient } from '@hey-api/openapi-ts';
await createClient({
  input: '../backend/.research-local/openapi.json',
  output: { path: 'src/research/generated' },
  plugins: ['@hey-api/typescript'],
});
