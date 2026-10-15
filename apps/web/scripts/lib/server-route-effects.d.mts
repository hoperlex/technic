export interface ServerRouteEffect {
  method: string;
  path: string;
  reads: string[];
  writes: string[];
}

export function serverRouteEffects(apiRoot: string): {
  available: boolean;
  routes: ServerRouteEffect[];
};
