// Managed by the Adhar image (adhar-io/strapi, adhar/docker).
// The scaffolded default reads no URL variable, which left Strapi building
// absolute links against localhost from behind the platform Gateway. `url` is
// what fixes media URLs, webhook payloads and the SSO callback.
module.exports = ({ env }) => ({
  host: env('HOST', '0.0.0.0'),
  port: env.int('PORT', 1337),
  url: env('PUBLIC_URL', undefined),
  // Behind the platform's oauth2-proxy and Gateway: take the scheme and client
  // address from X-Forwarded-*.
  proxy: env.bool('IS_PROXIED', true),
  app: {
    keys: env.array('APP_KEYS'),
  },
  // No update check: a platform component does not phone home, and the
  // version is the image's to change, not the operator's.
  logger: {
    updates: {
      enabled: env.bool('STRAPI_UPDATE_NOTIFICATION', false),
    },
  },
  webhooks: {
    populateRelations: env.bool('WEBHOOKS_POPULATE_RELATIONS', false),
  },
});
