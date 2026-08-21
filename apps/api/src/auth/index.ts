import { env } from '../env.js';
import { DevAuthProvider } from './devProvider.js';
import { Auth0Provider } from './auth0Provider.js';
import type { AuthProvider } from './provider.js';

let instance: AuthProvider | null = null;

export function authProvider(): AuthProvider {
  if (!instance) {
    instance = env.AUTH_PROVIDER === 'auth0' ? new Auth0Provider() : new DevAuthProvider();
  }
  return instance;
}

/** Present only when running the dev provider; used by the local login endpoint. */
export function devAuthProvider(): DevAuthProvider | null {
  const provider = authProvider();
  return provider instanceof DevAuthProvider ? provider : null;
}

export type { AuthProvider, AuthIdentity } from './provider.js';
