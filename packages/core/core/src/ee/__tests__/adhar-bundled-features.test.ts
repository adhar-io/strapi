import ee from '..';

/**
 * ADHAR FORK invariants.
 *
 * This distribution unlocks exactly one feature from the `ee/` tree — admin
 * SSO — so a Strapi operator signs in with the same Keycloak account they use
 * for every other Adhar service. These tests exist because the blast radius of
 * that change is the whole Enterprise tree: `strapi.EE` decides whether `ee/`
 * is loaded at all, so turning it on must NOT be mistaken for a licence.
 *
 * If a future edit widens the bundle, these tests fail and say so.
 */
describe('Adhar bundled EE features', () => {
  it('reports SSO as enabled without a licence', () => {
    expect(ee.features.isEnabled('sso')).toBe(true);
    expect(ee.features.get('sso')).toEqual({ name: 'sso' });
  });

  it('loads the ee/ tree, because a bundled feature is otherwise unreachable', () => {
    // packages/core/admin/server/src/index.ts merges the EE admin module only
    // when strapi.EE is true; without this the SSO routes never register.
    expect(ee.isEE).toBe(true);
  });

  it.each(['audit-logs', 'review-workflows', 'cms-content-releases', 'content-history'])(
    'leaves %s locked — the gate is per-feature, not per-tree',
    (feature) => {
      expect(ee.features.isEnabled(feature)).toBe(false);
    }
  );

  it('fakes no licence entitlement', () => {
    // Seats stay undefined so seat-enforcement no-ops (it early-returns on nil)
    // and nothing claims a paid plan or trial.
    expect(ee.seats).toBeUndefined();
    expect(ee.type).toBeUndefined();
    expect(ee.isTrial).toBe(false);
  });

  it('exposes exactly the bundled feature and nothing more', () => {
    expect(ee.features.list()).toEqual([{ name: 'sso' }]);
  });
});
