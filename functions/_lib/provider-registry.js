const PROVIDERS = Object.freeze([
  {
    id: 'threads',
    label: 'Threads',
    accountRoute: '/api/threads-accounts',
    publishRoute: '/api/threads-publish',
    capabilities: ['text', 'chain', 'image', 'video', 'carousel'],
  },
  {
    id: 'meta',
    label: 'Facebook + Instagram',
    accountRoute: '/api/meta-accounts',
    publishRoute: '/api/meta-publish',
    capabilities: ['text', 'image', 'video', 'carousel'],
  },
  {
    id: 'zernio',
    label: 'TikTok + YouTube',
    accountRoute: '/api/social-publish',
    publishRoute: '/api/social-publish',
    capabilities: ['video', 'carousel', 'draft', 'publish'],
  },
]);

export function listProviderCapabilities() {
  return PROVIDERS.map((provider) => ({
    ...provider,
    capabilities: [...provider.capabilities],
  }));
}

export function getProvider(id) {
  return PROVIDERS.find((provider) => provider.id === id) || null;
}
