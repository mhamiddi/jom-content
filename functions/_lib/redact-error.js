const SECRET_KEYS = [
  'JOM_API_TOKEN',
  'JOM_SESSION_SECRET',
  'JOM_LOGIN_PASSWORD',
  'THREADS_APP_SECRET',
  'ZERNIO_API_KEY',
  'META_ACCESS_TOKEN',
  'OPENAI_API_KEY',
];

export function redactError(error, env = {}, extraSecrets = []) {
  let message = String(error?.message || error || 'Unknown error');
  const secrets = [...SECRET_KEYS.map((key) => env?.[key]), ...extraSecrets]
    .filter((value) => value && String(value).length >= 4)
    .map(String);
  for (const secret of secrets) message = message.split(secret).join('[redacted]');
  return message.slice(0, 300);
}
