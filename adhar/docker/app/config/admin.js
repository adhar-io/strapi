// Managed by the Adhar image (adhar-io/strapi, adhar/docker).
//
// The scaffolded admin.js plus a Keycloak entry in `auth.providers`. Only the
// Enterprise SSO service reads that list, which the fork's @strapi/core
// enables; without KEYCLOAK_* set it is empty and the login page shows the
// password form alone.
const OAuth2Strategy = require('passport-oauth2');

// Keycloak >= 17 realm endpoints (/realms/<realm>/protocol/openid-connect/...).
// The browser goes to the public issuer; the code exchange and the userinfo
// call go to the in-cluster one, so the server never has to trust the public
// ingress certificate. Strapi needs `email`, and `username` or first + last
// name, to auto-register a user.
const keycloakProviders = (env) => {
  const trim = (v) => (v || '').replace(/\/+$/, '');
  const issuer = trim(env('KEYCLOAK_ISSUER_URL', ''));
  const internal = trim(env('KEYCLOAK_INTERNAL_ISSUER_URL', '')) || issuer;
  const clientID = env('KEYCLOAK_CLIENT_ID', '');
  const clientSecret = env('KEYCLOAK_CLIENT_SECRET', '');
  const publicUrl = trim(env('PUBLIC_URL', ''));
  if (!issuer || !clientID || !clientSecret || !publicUrl) return [];

  return [
    {
      uid: 'keycloak',
      displayName: env('KEYCLOAK_DISPLAY_NAME', 'Keycloak'),
      icon: env('KEYCLOAK_ICON_URL', undefined),
      createStrategy: (strapi) => {
        const strategy = new OAuth2Strategy(
          {
            authorizationURL: `${issuer}/protocol/openid-connect/auth`,
            tokenURL: `${internal}/protocol/openid-connect/token`,
            clientID,
            clientSecret,
            scope: ['openid', 'email', 'profile'],
            // Absolute: Strapi hands back a path, and the request the strategy
            // sees arrived over plain HTTP from the proxy.
            callbackURL:
              publicUrl + strapi.service('admin::passport').getStrategyCallbackURL('keycloak'),
          },
          (accessToken, refreshToken, profile, done) => done(null, profile)
        );
        // Strapi authenticates by provider uid, so the strategy must answer to
        // it (passport-oauth2 names itself 'oauth2').
        strategy.name = 'keycloak';
        strategy.userProfile = (accessToken, done) => {
          fetch(`${internal}/protocol/openid-connect/userinfo`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`userinfo ${r.status}`))))
            .then((u) =>
              done(null, {
                email: u.email,
                username: u.preferred_username,
                firstname: u.given_name,
                lastname: u.family_name,
              })
            )
            .catch(done);
        };
        return strategy;
      },
    },
  ];
};

module.exports = ({ env }) => ({
  auth: {
    secret: env('ADMIN_JWT_SECRET'),
    providers: keycloakProviders(env),
  },
  apiToken: {
    salt: env('API_TOKEN_SALT'),
  },
  transfer: {
    token: {
      salt: env('TRANSFER_TOKEN_SALT'),
    },
  },
  secrets: {
    encryptionKey: env('ENCRYPTION_KEY'),
  },
  flags: {
    nps: env.bool('FLAG_NPS', false),
    // No upsell banner for a feature this distribution ships.
    promoteEE: env.bool('FLAG_PROMOTE_EE', false),
    docLinks: env.bool('FLAG_DOC_LINKS', true),
  },
});
