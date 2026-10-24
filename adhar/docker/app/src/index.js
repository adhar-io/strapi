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

module.exports = {
  register() {},

  async bootstrap({ strapi }) {
    await applySsoDefaults(strapi);
  },
};
