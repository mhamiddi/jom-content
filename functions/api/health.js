import { json } from '../_lib/auth.js';
import { listProviderCapabilities } from '../_lib/provider-registry.js';

export async function onRequest(context) {
  const { env } = context;
  const kvReady = Boolean(env.JOM_CONTENT);
  const status = kvReady ? 'ok' : 'degraded';
  const rawVersion = String(env.CF_PAGES_COMMIT_SHA || env.JOM_BUILD_VERSION || 'local');
  const response = json({
    success: kvReady,
    status,
    version: rawVersion === 'local' ? rawVersion : rawVersion.slice(0, 7),
    bindings: {
      kv: kvReady,
      media: Boolean(env.JOM_MEDIA),
      threadsGuard: Boolean(env.THREADS_GUARD),
    },
    providers: listProviderCapabilities(),
    checkedAt: new Date().toISOString(),
  }, kvReady ? 200 : 503);
  return response;
}
