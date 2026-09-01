"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Button, Modal } from "@/shared/components";
import CompatibleChannelIconPicker from "@/shared/components/CompatibleChannelIconPicker";
import { normalizeCustomChannelIconSrc } from "@/shared/constants/customChannelIcons";

export default function EditCompatibleNodeIconModal({ isOpen, node, onSave, onClose }) {
  const [icon, setIcon] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isOpen) setIcon(normalizeCustomChannelIconSrc(node?.icon));
  }, [isOpen, node?.icon]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(icon);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title="Edit channel icon" onClose={onClose}>
      <div className="flex flex-col gap-5">
        <CompatibleChannelIconPicker value={icon} onChange={setIcon} />
        <div className="flex gap-2">
          <Button onClick={handleSave} fullWidth disabled={saving}>
            {saving ? "Saving..." : "Save icon"}
          </Button>
          <Button onClick={onClose} variant="ghost" fullWidth disabled={saving}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

EditCompatibleNodeIconModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  node: PropTypes.shape({
    icon: PropTypes.string,
  }),
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
