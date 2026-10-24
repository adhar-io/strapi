'use strict';

// Managed by the Adhar image (adhar-io/strapi, adhar/docker).

/**
 * Let Keycloak users in without a prior invitation.
 *
 * "Auto-register SSO users" and their default role live in the core store
 * (Settings → Single Sign-On), off by default and with no config-file knob, so
 * a first Keycloak login would otherwise end in "no account for this email".
 * STRAPI_SSO_DEFAULT_ROLE names the role by code (strapi-super-admin |
 * strapi-editor | strapi-author); unset leaves the settings to the UI.
 *
 * Runs in bootstrap: the admin plugin has created its roles by then.
 */
const applySsoDefaults = async (strapi) => {
  const code = process.env.STRAPI_SSO_DEFAULT_ROLE;
  if (!code || !strapi.ee.features.isEnabled('sso')) return;

  const role = await strapi.db.query('admin::role').findOne({ where: { code } });
  if (!role) {
    strapi.log.warn(`[adhar] SSO default role ${code} does not exist; leaving SSO settings alone`);
    return;
  }

  const store = await strapi.store({ type: 'core', name: 'admin' });
  const auth = (await store.get({ key: 'auth' })) || {};
  const providers = { ssoLockedRoles: [], ...(auth.providers || {}) };
  if (providers.autoRegister === true && String(providers.defaultRole) === String(role.id)) return;

  await store.set({
    key: 'auth',
    value: { ...auth, providers: { ...providers, autoRegister: true, defaultRole: role.id } },
  });
  strapi.log.info(`[adhar] SSO auto-register on, default role ${code} (#${role.id})`);
};

/**
 * Register the Adhar Console's Content API token.
 *
 * The console reads content through the Content API, which accepts only API
 * tokens, and an SSO-only admin leaves nobody to mint one by hand. The platform
 * generates the key (ADHAR_CONSOLE_TOKEN); Strapi stores only its salted
 * hash, so the hash of that key IS the token. Upserts one full-access,
 * non-expiring row, and repairs it if it was edited or deleted in the admin.
 *
 * Through Strapi's own hash and query layer, the way its api-token service
 * creates tokens, so field defaults (`kind` above all) and the encrypted copy
 * that lets the admin reveal the key are right on every Strapi version.
 */
const applyConsoleToken = async (strapi) => {
  const key = process.env.ADHAR_CONSOLE_TOKEN;
  if (!key) return;
  const name = process.env.ADHAR_CONSOLE_TOKEN_NAME || 'Adhar Console';

  const accessKey = strapi.service('admin::api-token').hash(key);
  const want = {
    kind: 'content-api',
    type: 'full-access',
    accessKey,
    lifespan: null,
    expiresAt: null,
  };
  const query = strapi.db.query('admin::api-token');
  const row = await query.findOne({ where: { name } });
  if (row && Object.entries(want).every(([field, value]) => (row[field] ?? null) === value)) return;

  const encryptedKey = strapi.service('admin::encryption').encrypt(key) || undefined;
  if (row) {
    await query.update({ where: { id: row.id }, data: { ...want, encryptedKey } });
    strapi.log.info(`[adhar] console token "${name}" repaired`);
    return;
  }
  await query.create({
    data: {
      name,
      description:
        'Used by the Adhar Console (Develop → Content). Managed by the platform; deleting it is undone on the next start.',
      ...want,
      encryptedKey,
      adminUserOwner: null,
    },
  });
  strapi.log.info(`[adhar] console token "${name}" registered`);
};

module.exports = {
  register() {},

  async bootstrap({ strapi }) {
    await applySsoDefaults(strapi);
    await applyConsoleToken(strapi);
  },
};
