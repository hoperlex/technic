import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { serverRouteEffects } from '../scripts/lib/server-route-effects.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = (files: Record<string, string>) => {
  const root = mkdtempSync(path.join(tmpdir(), 'server-route-effects-'));
  roots.push(root);
  for (const [file, contents] of Object.entries(files)) {
    const full = path.join(root, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
};

it('finds a trailer write through a service called by the vehicle PATCH route', () => {
  const root = fixture({
    'app.ts': `import vehiclesRoutes from './routes/vehicles';
      app.register(vehiclesRoutes, { prefix: '/api/v1/vehicles' });`,
    'routes/vehicles.ts': `import { vehicles } from '../db/schema';
      import { releaseHitchesOfVehicle } from '../services/hitches';
      export default async function vehiclesRoutes(app: unknown) {
        r.get('/', async () => db.select().from(vehicles));
        r.patch('/:id', {}, async () => {
          await tx.update(vehicles).set({});
          await releaseHitchesOfVehicle(tx, id);
        });
      }`,
    'services/hitches.ts': `import { vehicleTrailers } from '../db/schema';
      export async function releaseHitchesOfVehicle(tx: unknown, id: string) {
        await tx.update(vehicleTrailers).set({ hitchedVehicleId: null });
      }`,
  });
  expect(serverRouteEffects(root).routes).toContainEqual({
    method: 'PATCH',
    path: '/vehicles/:id',
    reads: [],
    writes: ['vehicleTrailers', 'vehicles'],
  });
});

it('keeps read and write tables with their own route instead of a whole-file union', () => {
  const root = fixture({
    'app.ts': `import vehiclesRoutes from './routes/vehicles';
      app.register(vehiclesRoutes, { prefix: '/api/v1/vehicles' });`,
    'routes/vehicles.ts': `import { vehicles, vehicleTrailers } from '../db/schema';
      export default async function vehiclesRoutes(app: unknown) {
        r.get('/', async () => db.select().from(vehicles));
        r.get('/:id/trailers', async () => db.select().from(vehicleTrailers));
        r.patch('/:id', {}, async () => tx.update(vehicles).set({}));
      }`,
  });
  expect(serverRouteEffects(root).routes.find((route) => route.method === 'PATCH')?.writes).toEqual(
    ['vehicles'],
  );
});

it('finds the vehicle to trailer effect in the current API', () => {
  const apiRoot = path.resolve(process.cwd(), '../api/src');
  const routes = serverRouteEffects(apiRoot).routes;
  expect(
    routes.find((route) => route.method === 'PATCH' && route.path === '/vehicles/:id')?.writes,
  ).toContain('vehicleTrailers');
  expect(
    routes.find((route) => route.method === 'GET' && route.path === '/vehicle-trailers')?.reads,
  ).toContain('vehicleTrailers');
});
