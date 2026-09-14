"use client";

import PropTypes from "prop-types";
import Button from "@/shared/components/Button";
import Toggle from "@/shared/components/Toggle";
import {
  findInvalidScheduleField,
  getEffectiveScheduleWindows,
  isTimeWindowInvalid,
  scheduleFieldLabel,
} from "@/shared/utils/schedule.js";

// The first window a user adds. Mirrors nothing in particular — it just has to
// be a valid, non-zero-length window so it can be saved immediately.
const DEFAULT_WINDOW = { start: "09:00", end: "22:00" };

function browserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

/**
 * Fill in whatever the stored schedule leaves out, so the editor always has
 * arrays to map over and booleans to bind. An absent schedule becomes "always
 * on", which is the same thing the request path reads it as.
 */
function withDefaults(schedule) {
  if (!schedule || typeof schedule !== "object") {
    return {
      timezone: browserTimezone(),
      active: [],
      inactive: [],
      activeEnabled: true,
      inactiveEnabled: false,
    };
  }
  const inactive = getEffectiveScheduleWindows(schedule, "inactive");
  return {
    timezone: schedule.timezone || browserTimezone(),
    active: getEffectiveScheduleWindows(schedule, "active"),
    inactive,
    activeEnabled: schedule.activeEnabled !== false,
    inactiveEnabled: schedule.inactiveEnabled === true
      || (schedule.inactiveEnabled === undefined && inactive.length > 0),
  };
}

function TimeWindowRow({ field, window, onPatch, onRemove }) {
  const invalid = isTimeWindowInvalid(window);
  const inputClass = [
    "h-9 w-32 shrink-0 rounded-[10px] border bg-white px-2 font-mono text-sm text-text-main outline-none transition-colors focus:border-primary dark:bg-black/20",
    invalid ? "border-red-400/60" : "border-black/10 dark:border-white/10",
  ].join(" ");

  return (
    <div className="flex items-center gap-2">
      <input
        type="time"
        value={window.start || ""}
        onChange={(e) => onPatch({ start: e.target.value })}
        className={inputClass}
        aria-label={`${scheduleFieldLabel(field)}时段开始时间`}
      />
      <span className="text-text-muted">—</span>
      <input
        type="time"
        value={window.end || ""}
        onChange={(e) => onPatch({ end: e.target.value })}
        className={inputClass}
        aria-label={`${scheduleFieldLabel(field)}时段结束时间`}
      />
      <button
        type="button"
        onClick={onRemove}
        className="ml-auto inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-black/10 text-text-muted transition-colors hover:border-red-400/50 hover:bg-red-500/10 hover:text-red-500 dark:border-white/10"
        title={`移除${scheduleFieldLabel(field)}时段`}
        aria-label={`移除${scheduleFieldLabel(field)}时段`}
      >
        <span className="material-symbols-outlined text-[15px]">close</span>
      </button>
    </div>
  );
}

function ScheduleField({ field, schedule, onPatch, onAdd, onRemove, onSetEnabled }) {
  const label = scheduleFieldLabel(field);
  const enabled = field === "active" ? schedule.activeEnabled : schedule.inactiveEnabled;
  const windows = schedule[field] || [];

  return (
    <div className="rounded-[10px] border border-black/10 p-3 dark:border-white/10">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}时段</p>
          <p className="mt-0.5 text-xs text-text-muted">
            {field === "active"
              ? "未配置表示全天可用；跨午夜可直接填 22:00 — 06:00。"
              : "命中失效时段的账号即使仍在生效时段内也不参与调度。"}
          </p>
        </div>
        <Toggle checked={enabled} onChange={onSetEnabled} size="sm" />
      </div>

      {enabled && (
        <div className="mt-3 flex flex-col gap-2">
          {windows.length === 0 ? (
            <p className="text-xs text-text-muted">
              {field === "active" ? "未配置，表示全天可用" : "未配置失效时段"}
            </p>
          ) : (
            windows.map((window, index) => (
              <TimeWindowRow
                key={`${field}-${index}`}
                field={field}
                window={window}
                onPatch={(patch) => onPatch(index, patch)}
                onRemove={() => onRemove(index)}
              />
            ))
          )}
          <Button variant="secondary" size="sm" icon="add" onClick={onAdd}>
            添加时段
          </Button>
        </div>
      )}

      {!enabled && (
        <p className="mt-3 text-xs text-text-muted">
          {field === "active" ? "已停用，账号不受生效时段限制" : "已停用，当前无失效时段"}
        </p>
      )}
    </div>
  );
}

/**
 * Account enable window. Same shape and same rules as the combo model schedule,
 * so a window means the same thing wherever it is configured.
 */
export default function AccountScheduleEditor({ schedule, onChange }) {
  const current = withDefaults(schedule);
  const invalidField = findInvalidScheduleField(current);

  const patchWindow = (field, index, patch) => {
    const windows = [...(current[field] || [])];
    windows[index] = { ...windows[index], ...patch };
    onChange({ ...current, [field]: windows });
  };

  const addWindow = (field) => {
    onChange({ ...current, [field]: [...(current[field] || []), { ...DEFAULT_WINDOW }] });
  };

  const removeWindow = (field, index) => {
    onChange({ ...current, [field]: (current[field] || []).filter((_, i) => i !== index) });
  };

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-sm font-medium">启用时间段</p>
        <p className="mt-0.5 text-xs text-text-muted">
          按 {current.timezone || "服务器"} 时区计算；不配置则账号全天可用。
        </p>
      </div>

      <ScheduleField
        field="active"
        schedule={current}
        onPatch={(index, patch) => patchWindow("active", index, patch)}
        onAdd={() => addWindow("active")}
        onRemove={(index) => removeWindow("active", index)}
        onSetEnabled={(next) => onChange({ ...current, activeEnabled: next })}
      />

      <ScheduleField
        field="inactive"
        schedule={current}
        onPatch={(index, patch) => patchWindow("inactive", index, patch)}
        onAdd={() => addWindow("inactive")}
        onRemove={(index) => removeWindow("inactive", index)}
        onSetEnabled={(next) => onChange({ ...current, inactiveEnabled: next })}
      />

      {invalidField && (
        <p className="text-xs font-medium text-red-400">
          开始和结束时间必须不同，且不能重复添加相同时段（{scheduleFieldLabel(invalidField)}时段）
        </p>
      )}
    </div>
  );
}

AccountScheduleEditor.propTypes = {
  schedule: PropTypes.object,
  onChange: PropTypes.func.isRequired,
};

TimeWindowRow.propTypes = {
  field: PropTypes.string.isRequired,
  window: PropTypes.object.isRequired,
  onPatch: PropTypes.func.isRequired,
  onRemove: PropTypes.func.isRequired,
};

ScheduleField.propTypes = {
  field: PropTypes.string.isRequired,
  schedule: PropTypes.object.isRequired,
  onPatch: PropTypes.func.isRequired,
  onAdd: PropTypes.func.isRequired,
  onRemove: PropTypes.func.isRequired,
  onSetEnabled: PropTypes.func.isRequired,
};
