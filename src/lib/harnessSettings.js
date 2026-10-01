import { getComboByName, updateSettings } from "@/lib/db/index.js";
import {
  BUILTIN_HARNESSES,
  normalizeHarnessModels,
  normalizeHarnessProfiles,
  resolveHarnessProfiles,
} from "@/shared/utils/harnessRoute";
import { getComboTargetError } from "@/shared/utils/claudeMessagesRoute";

export async function saveHarnessSettings(prefix, body) {
  if (!BUILTIN_HARNESSES.some((harness) => harness.prefix === prefix)) {
    throw Object.assign(new Error("Unknown harness"), { status: 404 });
  }
  if (!body?.profile || typeof body.profile !== "object" || Array.isArray(body.profile)
    || !Array.isArray(body.models) || !Array.isArray(body.profile.mappings)) {
    throw Object.assign(new Error("profile.mappings and models must be arrays"), { status: 400 });
  }

  const profile = normalizeHarnessProfiles({ [prefix]: body.profile })[prefix];
  const models = normalizeHarnessModels({ [prefix]: body.models })[prefix] || [];
  for (const mapping of profile.mappings) {
    if (mapping.target.includes("/")) continue;
    const combo = await getComboByName(mapping.target);
    const error = getComboTargetError(combo, null, `${prefix} harness mapping`);
    if (error) throw Object.assign(new Error(error), { status: 400 });
  }

  await updateSettings((current) => {
    const harnessModels = { ...current.harnessModels };
    if (models.length) harnessModels[prefix] = models;
    else delete harnessModels[prefix];
    const existingProfiles = current.harnessProfiles && Object.keys(current.harnessProfiles).length
      ? current.harnessProfiles
      : resolveHarnessProfiles(current);
    return {
      harnessProfiles: { ...existingProfiles, [prefix]: profile },
      harnessModels,
    };
  });
  return { profile, models };
}
