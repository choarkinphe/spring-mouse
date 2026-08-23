// Remove retired OIDC/SAML settings, including stored client secrets and certificates.
const RETIRED_SSO_KEYS = [
  "authMode", "ssoType", "oidcIssuerUrl", "oidcClientId", "oidcClientSecret",
  "oidcScopes", "oidcLoginLabel", "samlEntryPoint", "samlIssuer", "samlCert",
  "samlLoginLabel", "samlAttributeEmail", "samlAttributeName",
];

const migration = {
  version: 3,
  name: "remove-sso-settings",
  up(db) {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    if (!row) return;
    try {
      const settings = JSON.parse(row.data || "{}");
      let changed = false;
      for (const key of RETIRED_SSO_KEYS) {
        if (!(key in settings)) continue;
        delete settings[key];
        changed = true;
      }
      if (changed) db.run(`UPDATE settings SET data = ? WHERE id = 1`, [JSON.stringify(settings)]);
    } catch {
      // Preserve malformed historical settings; do not risk destroying the row.
    }
  },
};

export default migration;
