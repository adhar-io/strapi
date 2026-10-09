import { isEqual, pick } from 'lodash';
import type { Logger } from '@strapi/logger';
import type { Core } from '@strapi/types';
import { createStrapiFetch } from '../utils/fetch';
import {
  readLicense,
  verifyLicense,
  fetchLicense,
  LicenseCheckError,
  LICENSE_REGISTRY_URI,
} from './license';
import { shiftCronExpression } from '../utils/cron';

const ONE_MINUTE = 1000 * 60;

interface EE {
  enabled: boolean;
  licenseInfo: {
    licenseKey?: string;
    features?: Array<{ name: string; [key: string]: any } | string>;
    expireAt?: string;
    seats?: number;
    type?: string;
    isTrial: boolean;
    subscriptionId?: string;
    planPriceId?: string;
  };
  logger?: Logger;
}

const ee: EE = {
  enabled: false,
  licenseInfo: {
    isTrial: false,
  },
};

/**
 * ADHAR FORK — features this distribution ships without a Strapi licence.
 *
 * The platform needs one thing from the Enterprise tree: admin-panel SSO, so
 * an operator signs in to Strapi with the same Keycloak account they use for
 * every other Adhar service instead of a second local password. The SSO
 * implementation under `ee/` is already generic — it registers whatever
 * passport strategies `config.admin.auth.providers` declares — so nothing had
 * to be reimplemented; only the gate is lifted.
 *
 * The gate is deliberately per-feature. `strapi.EE` decides whether the `ee/`
 * tree is LOADED, and each feature then checks its own name through
 * `features.isEnabled(...)`. Listing only 'sso' here therefore leaves
 * audit-logs, content-releases, review-workflows and seat enforcement exactly
 * as locked as they are in Community Edition — seat enforcement in particular
 * no-ops because `strapi.ee.seats` stays undefined without a licence.
 *
 * Nothing here fakes a licence: `ee.enabled`, `seats`, `type` and `isTrial`
 * still come only from a verified licence, and license checking is untouched.
 *
 * Licence note: code under an `ee/` directory is covered by
 * `packages/core/admin/ee/LICENSE`, not the repository's MIT licence. Enabling
 * it is a deliberate decision recorded by the Adhar maintainers.
 */
const ADHAR_BUNDLED_FEATURES = ['sso'];

const disable = (message: string) => {
  // Prevent emitting ee.disable if it was already disabled
  const shouldEmitEvent = ee.enabled !== false;

  ee.logger?.warn(`${message} Switching to CE.`);
  // Only keep the license key and isTrial for potential re-enabling during a later check
  ee.licenseInfo = pick(ee.licenseInfo, ['licenseKey', 'isTrial']);

  ee.licenseInfo.isTrial = false;

  ee.enabled = false;

  if (shouldEmitEvent) {
    // Notify EE features that they should be disabled
    strapi.eventHub.emit('ee.disable');
  }
};

const enable = () => {
  // Prevent emitting ee.enable if it was already enabled
  const shouldEmitEvent = ee.enabled !== true;

  ee.enabled = true;

  if (shouldEmitEvent) {
    // Notify EE features that they should be disabled
    strapi.eventHub.emit('ee.enable');
  }
};

let initialized = false;

/**
 * Optimistically enable EE if the format of the license is valid, only run once.
 */
const init = (licenseDir: string, logger?: Logger) => {
  if (initialized) {
    return;
  }

  initialized = true;
  ee.logger = logger;

  if (process.env.STRAPI_DISABLE_EE?.toLowerCase() === 'true') {
    return;
  }

  try {
    const license = process.env.STRAPI_LICENSE || readLicense(licenseDir);

    if (license) {
      ee.licenseInfo = verifyLicense(license);
      enable();
    }
  } catch (error) {
    if (error instanceof Error) {
      disable(error.message);
    } else {
      disable('Invalid license.');
    }
  }
};

/**
 * Contact the license registry to update the license to its latest state.
 *
 * Store the result in database to avoid unecessary requests, and will fallback to that in case of a network failure.
 */
const onlineUpdate = async ({ strapi }: { strapi: Core.Strapi }) => {
  const { get, commit, rollback } = await strapi.db.transaction();
  const transaction = get();

  try {
    const storedInfo = await strapi.db
      ?.queryBuilder('strapi::core-store')
      .where({ key: 'ee_information' })
      .select('value')
      .first()
      .transacting(transaction)
      .forUpdate()
      .execute()
      .then((result: any) => (result ? JSON.parse(result.value) : result));

    const shouldContactRegistry = (storedInfo?.lastCheckAt ?? 0) < Date.now() - ONE_MINUTE;
    const result: {
      license?: string | null;
      error?: string;
      lastCheckAt?: number;
    } = { lastCheckAt: Date.now() };

    const fallback = (error: Error) => {
      if (error instanceof LicenseCheckError && error.shouldFallback && storedInfo?.license) {
        ee.logger?.warn(
          `${error.message} The last stored one will be used as a potential fallback.`
        );
        return storedInfo.license;
      }

      result.error = error.message;
      disable(error.message);
    };

    if (!ee?.licenseInfo?.licenseKey) {
      throw new Error('Missing license key.');
    }

    const license = shouldContactRegistry
      ? await fetchLicense({ strapi }, ee.licenseInfo.licenseKey, strapi.config.get('uuid')).catch(
          fallback
        )
      : storedInfo.license;

    if (license) {
      try {
        // Verify license and check if its info changed
        const newLicenseInfo = verifyLicense(license);
        const licenseInfoChanged =
          !isEqual(newLicenseInfo.features, ee.licenseInfo.features) ||
          newLicenseInfo.seats !== ee.licenseInfo.seats ||
          newLicenseInfo.type !== ee.licenseInfo.type;

        // Store the new license info
        ee.licenseInfo = newLicenseInfo;
        const wasEnabled = ee.enabled;
        validateInfo();

        // Notify EE features
        if (licenseInfoChanged && wasEnabled) {
          strapi.eventHub.emit('ee.update');
        }
      } catch (error) {
        if (error instanceof Error) {
          disable(error.message);
        } else {
          disable('Invalid license.');
        }
      }
    } else if (!shouldContactRegistry) {
      disable(storedInfo.error);
    }

    if (shouldContactRegistry) {
      result.license = license ?? null;
      const query = strapi.db.queryBuilder('strapi::core-store').transacting(transaction);

      if (!storedInfo) {
        query.insert({ key: 'ee_information', value: JSON.stringify(result) });
      } else {
        query.update({ value: JSON.stringify(result) }).where({ key: 'ee_information' });
      }

      await query.execute();
    }

    await commit();
  } catch {
    // Example of errors: SQLite does not support FOR UPDATE
    await rollback();
  }
};

const validateInfo = () => {
  if (typeof ee.licenseInfo.expireAt === 'undefined') {
    throw new Error('Missing license key.');
  }

  const expirationTime = new Date(ee.licenseInfo.expireAt).getTime();

  if (expirationTime < new Date().getTime()) {
    return disable('License expired.');
  }

  enable();
};

const checkLicense = async ({ strapi }: { strapi: Core.Strapi }) => {
  const shouldStayOffline =
    ee.licenseInfo.type === 'gold' &&
    // This env variable support is temporarily used to ease the migration between online vs offline
    process.env.STRAPI_DISABLE_LICENSE_PING?.toLowerCase() === 'true';

  if (!shouldStayOffline) {
    await onlineUpdate({ strapi });

    strapi.cron.add({
      onlineUpdate: {
        task: () => onlineUpdate({ strapi }),
        options: shiftCronExpression('0 0 */12 * * *'),
      },
    });
  } else {
    if (!ee.licenseInfo.expireAt) {
      return disable('Your license does not have offline support.');
    }

    validateInfo();
  }
};

const getTrialEndDate = async ({
  strapi,
}: {
  strapi: Core.Strapi;
}): Promise<{ trialEndsAt: string } | null> => {
  const silentFetch = createStrapiFetch(strapi, {
    logs: false,
  });

  const res = await silentFetch(
    `${LICENSE_REGISTRY_URI}/api/licenses/${ee.licenseInfo.licenseKey}/trial-countdown`,
    {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    }
  ).catch(() => {
    throw new LicenseCheckError(
      'Could not proceed to retrieve the trial time left for your license.',
      true
    );
  });

  const data = (await res.json()) as { trialEndsAt: string } | null;

  return data;
};

const list = () => {
  const licensed =
    ee.licenseInfo.features?.map((feature) =>
      typeof feature === 'object' ? feature : { name: feature }
    ) || [];

  // A licence that already grants a bundled feature wins, so its extra
  // configuration (options, limits) is not discarded by this fork.
  const licensedNames = new Set(licensed.map((feature) => feature.name));
  const bundled = ADHAR_BUNDLED_FEATURES.filter((name) => !licensedNames.has(name)).map((name) => ({
    name,
  }));

  return [...licensed, ...bundled];
};

const get = (featureName: string) => list().find((feature) => feature.name === featureName);

export default Object.freeze({
  init,
  checkLicense,
  getTrialEndDate,

  get isEE() {
    // True when a licence enables EE, and also when this distribution bundles
    // any feature from the ee/ tree — `packages/core/admin/server/src/index.ts`
    // only merges the EE admin module when this is true, so a bundled feature
    // would otherwise never be reachable. Per-feature gates still decide what
    // is actually usable; see ADHAR_BUNDLED_FEATURES.
    return ee.enabled || ADHAR_BUNDLED_FEATURES.length > 0;
  },

  get seats() {
    return ee.licenseInfo.seats;
  },

  get type() {
    return ee.licenseInfo.type;
  },

  get isTrial() {
    return ee.licenseInfo.isTrial;
  },

  get planPriceId() {
    return ee.licenseInfo.planPriceId;
  },

  get subscriptionId() {
    return ee.licenseInfo.subscriptionId;
  },

  features: Object.freeze({
    list,
    get,
    isEnabled: (featureName: string) => get(featureName) !== undefined,
  }),
});
