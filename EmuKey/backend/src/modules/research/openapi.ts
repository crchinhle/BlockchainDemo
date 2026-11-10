import type {
  OpenAPIObject,
  OperationObject,
} from '@nestjs/swagger';
import { defaults } from './domain.js';
export function researchOpenApi(doc: OpenAPIObject) {
  const properties = Object.fromEntries(
    Object.entries(defaults).map(([key, value]) => [
      key,
      Array.isArray(value)
        ? { type: 'array', items: { type: 'string' }, default: value }
        : {
            type: typeof value === 'number' ? 'integer' : 'string',
            default: value,
          },
    ]),
  );
  doc.components ??= {};
  doc.components.schemas ??= {};
  doc.components.schemas.ResearchConfig = {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(defaults),
    properties,
  };
  doc.components.securitySchemes = {
    researchSession: { type: 'apiKey', in: 'cookie', name: 'research_session' },
  };
  for (const [path, item] of Object.entries(doc.paths))
    for (const [method, value] of Object.entries(item ?? {})) {
      const op = value as OperationObject;
      if (!op || typeof op !== 'object' || !('responses' in op)) continue;
      if (path !== '/api/research/login')
        op.security = [{ researchSession: [] }];
      if (
        (path === '/api/research/runs' && method === 'post') ||
        (path === '/api/research/runs/{id}' && method === 'patch')
      )
        op.requestBody = {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ResearchConfig' },
            },
          },
        };
    }
  return doc;
}
