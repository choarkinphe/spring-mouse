export function createModelCapsCache() {
  let value = null;
  let inflight = null;
  let generation = 0;

  return {
    peek: () => value,
    clear() {
      generation += 1;
      value = null;
      inflight = null;
    },
    load(fetchModels) {
      if (value) return Promise.resolve(value);
      if (inflight) return inflight;
      const started = generation;
      const pending = Promise.resolve().then(fetchModels).then((models) => {
        const byFull = {};
        const byId = {};
        for (const model of models || []) {
          if (!model.caps) continue;
          if (model.fullModel) byFull[model.fullModel] = model.caps;
          if (model.routedModel) byFull[model.routedModel] = model.caps;
          if (model.model) byId[model.model] = model.caps;
        }
        const maps = { byFull, byId };
        if (started === generation) value = maps;
        return maps;
      }).finally(() => {
        if (inflight === pending) inflight = null;
      });
      inflight = pending;
      return pending;
    },
  };
}
