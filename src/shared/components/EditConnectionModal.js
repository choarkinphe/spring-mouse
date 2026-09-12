"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import Drawer from "@/shared/components/Drawer";
import Input from "@/shared/components/Input";
import Button from "@/shared/components/Button";
import Badge from "@/shared/components/Badge";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider, AI_PROVIDERS } from "@/shared/constants/providers";
import { supportsMouseExecution } from "@/shared/constants/mouseSupport";
import Select from "@/shared/components/Select";

export default function EditConnectionModal({ isOpen, connection, mouses = [], channelConcurrencyLimit = null, onSave, onDelete, onClose }) {
  // Providers whose executor bypasses BaseExecutor.execute() cannot route
  // through a Mouse node — hide the picker instead of offering a no-op choice.
  const mouseSupported = supportsMouseExecution(connection?.provider);
  const [formData, setFormData] = useState({
    name: "",
    priority: 1,
    mouseId: "",
    apiKey: "",
  });
  const [azureData, setAzureData] = useState({
    azureEndpoint: "",
    apiVersion: "2024-10-01-preview",
    deployment: "",
    organization: "",
  });
  const [cloudflareData, setCloudflareData] = useState({ accountId: "" });
  const [region, setRegion] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(null);
  const [saving, setSaving] = useState(false);
  // Kept as a string so "empty" stays distinguishable from a real number: an
  // empty field means "follow the channel", which must not collapse into a 0.
  const [concurrency, setConcurrency] = useState("");

  useEffect(() => {
    if (connection) {
      setFormData({
        name: connection.name || "",
        priority: connection.priority || 1,
        mouseId: connection.mouseId || "",
        apiKey: "",
      });
      // Load Azure-specific data if present
      if (connection.provider === "azure" && connection.providerSpecificData) {
        setAzureData({
          azureEndpoint: connection.providerSpecificData.azureEndpoint || "",
          apiVersion: connection.providerSpecificData.apiVersion || "2024-10-01-preview",
          deployment: connection.providerSpecificData.deployment || "",
          organization: connection.providerSpecificData.organization || "",
        });
      }
      if (connection.provider === "cloudflare-ai" && connection.providerSpecificData) {
        setCloudflareData({ accountId: connection.providerSpecificData.accountId || "" });
      }
      // Load region for providers that support it (e.g. xiaomi-tokenplan)
      const providerCfg = AI_PROVIDERS?.[connection.provider];
      if (providerCfg?.regions) {
        const savedRegion = connection.providerSpecificData?.region || providerCfg.defaultRegion || providerCfg.regions[0]?.id || "";
        setRegion(savedRegion);
      }
      // Only a real positive number is an account-level override; a null left
      // behind by a previous "reset to channel" stays blank.
      const savedConcurrency = Number.parseInt(connection.providerSpecificData?.maxConcurrentStreams, 10);
      setConcurrency(Number.isFinite(savedConcurrency) && savedConcurrency > 0 ? String(savedConcurrency) : "");
      setTestResult(null);
      setValidationResult(null);
    }
  }, [connection]);

  const isOAuth = connection?.authType === "oauth";
  const isAzure = connection?.provider === "azure";
  const isCloudflareAi = connection?.provider === "cloudflare-ai";
  const isCompatible = connection
    ? (isOpenAICompatibleProvider(connection.provider) || isAnthropicCompatibleProvider(connection.provider))
    : false;
  const providerRegions = connection ? (AI_PROVIDERS?.[connection.provider]?.regions || null) : null;

  // The channel ceiling is the fallback the router applies when this account
  // has no override, so the hint can name the number that is actually in force.
  const channelLimit = Number.parseInt(channelConcurrencyLimit, 10);
  const hasChannelLimit = Number.isFinite(channelLimit) && channelLimit > 0;
  const overrideLimit = Number.parseInt(concurrency, 10);
  const hasOverride = Number.isFinite(overrideLimit) && overrideLimit > 0;
  const concurrencyHint = hasOverride
    ? `本账号单独限流 ${overrideLimit} 个并发，优先生效${hasChannelLimit ? `（渠道配置为 ${channelLimit}）` : ""}。`
    : `留空则跟随渠道配置${hasChannelLimit ? `（当前 ${channelLimit} 个并发）` : ""}；填写后本账号优先按此值限流。`;

  // Build providerSpecificData for region-aware providers
  const buildRegionSpecificData = () => {
    if (providerRegions && region) return { ...((connection?.providerSpecificData) || {}), region };
    return undefined;
  };

  const handleTest = async () => {
    if (!connection?.provider) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`/api/providers/${connection.id}/test`, { method: "POST" });
      const data = await res.json();
      setTestResult(data.valid ? "success" : "failed");
    } catch {
      setTestResult("failed");
    } finally {
      setTesting(false);
    }
  };

  const handleValidate = async () => {
    if (!connection?.provider || !formData.apiKey) return;
    setValidating(true);
    setValidationResult(null);
    try {
      const res = await fetch("/api/providers/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: connection.provider,
          apiKey: formData.apiKey,
          ...(isAzure ? { providerSpecificData: azureData } : {}),
          ...(isCloudflareAi ? { providerSpecificData: cloudflareData } : {}),
          ...(providerRegions ? { providerSpecificData: buildRegionSpecificData() } : {}),
        }),
      });
      const data = await res.json();
      setValidationResult(data.valid ? "success" : "failed");
    } catch {
      setValidationResult("failed");
    } finally {
      setValidating(false);
    }
  };

  const handleSubmit = async () => {
    if (!connection) return;
    setSaving(true);
    try {
      const updates = {
        name: formData.name,
        priority: formData.priority,
        mouseId: formData.mouseId || null,
      };
      if (!isOAuth && formData.apiKey) {
        updates.apiKey = formData.apiKey;
        let isValid = validationResult === "success";
        if (!isValid) {
          try {
            setValidating(true);
            setValidationResult(null);
            const res = await fetch("/api/providers/validate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                provider: connection.provider,
                apiKey: formData.apiKey,
                ...(isAzure ? { providerSpecificData: azureData } : {}),
                ...(isCloudflareAi ? { providerSpecificData: cloudflareData } : {}),
                ...(providerRegions ? { providerSpecificData: buildRegionSpecificData() } : {}),
              }),
            });
            const data = await res.json();
            isValid = !!data.valid;
            setValidationResult(isValid ? "success" : "failed");
          } catch {
            setValidationResult("failed");
          } finally {
            setValidating(false);
          }
        }
        if (isValid) {
          updates.testStatus = "active";
          updates.lastError = null;
          updates.lastErrorAt = null;
        }
      }
      
      // One merged patch: the API merges this object into the stored blob, but
      // assigning per branch would let the last one win and silently drop the
      // fields another branch owns.
      const specificData = {};
      if (isAzure) {
        Object.assign(specificData, {
          azureEndpoint: azureData.azureEndpoint,
          apiVersion: azureData.apiVersion,
          deployment: azureData.deployment,
          organization: azureData.organization,
        });
      }
      if (isCloudflareAi) {
        Object.assign(specificData, { accountId: cloudflareData.accountId });
      }
      // Persist updated region for region-aware providers
      if (providerRegions && region) {
        Object.assign(specificData, buildRegionSpecificData());
      }
      // Per-account concurrency ceiling. Empty means "follow the channel", and
      // null is what makes getConnectionConcurrencyLimit() fall back to it.
      const perAccountLimit = Number.parseInt(concurrency, 10);
      specificData.maxConcurrentStreams =
        Number.isFinite(perAccountLimit) && perAccountLimit > 0 ? perAccountLimit : null;
      updates.providerSpecificData = specificData;
      
      await onSave(updates);
    } finally {
      setSaving(false);
    }
  };

  if (!connection) return null;

  return (
    <Drawer isOpen={isOpen} title="Edit Connection" onClose={onClose} width="md">
      <div className="flex flex-col gap-4">
        <Input
          label="Name"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder={isOAuth ? "Account name" : "Production Key"}
        />
        {isOAuth && connection.email && (
          <div className="bg-sidebar/50 p-3 rounded-lg">
            <p className="text-sm text-text-muted mb-1">Email</p>
            <p className="font-medium">{connection.email}</p>
          </div>
        )}
        <Input
          label="Priority"
          type="number"
          value={formData.priority}
          onChange={(e) => setFormData({ ...formData, priority: Number.parseInt(e.target.value, 10) || 1 })}
        />
        <Input
          label="单账号并发"
          type="number"
          min={1}
          value={concurrency}
          onChange={(e) => setConcurrency(e.target.value)}
          placeholder={hasChannelLimit ? `渠道默认（${channelLimit}）` : "渠道默认"}
          hint={concurrencyHint}
        />
        {!isOAuth && (
          <>
            <div className="flex gap-2">
              <Input
                label="API Key"
                type="password"
                value={formData.apiKey}
                onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                placeholder="Enter new API key"
                hint="Leave blank to keep the current API key."
                className="flex-1"
              />
              <div className="pt-6">
                <Button onClick={handleValidate} disabled={!formData.apiKey || validating || saving} variant="secondary">
                  {validating ? "Checking..." : "Check"}
                </Button>
              </div>
            </div>
            {validationResult && (
              <Badge variant={validationResult === "success" ? "success" : "error"}>
                {validationResult === "success" ? "Valid" : "Invalid"}
              </Badge>
            )}
          </>
        )}

        {isAzure && (
          <div className="bg-sidebar/50 p-4 rounded-lg border border-accent/20">
            <h3 className="font-semibold mb-3 text-sm">Azure OpenAI Configuration</h3>
            <div className="flex flex-col gap-3">
              <Input
                label="Azure Endpoint"
                value={azureData.azureEndpoint}
                onChange={(e) => setAzureData({ ...azureData, azureEndpoint: e.target.value })}
                placeholder="https://your-resource.openai.azure.com"
                hint="Your Azure OpenAI resource endpoint URL"
              />
              <Input
                label="Deployment Name"
                value={azureData.deployment}
                onChange={(e) => setAzureData({ ...azureData, deployment: e.target.value })}
                placeholder="gpt-4"
                hint="The deployment name in your Azure resource"
              />
              <Input
                label="API Version"
                value={azureData.apiVersion}
                onChange={(e) => setAzureData({ ...azureData, apiVersion: e.target.value })}
                placeholder="2024-10-01-preview"
                hint="Azure OpenAI API version to use"
              />
              <Input
                label="Organization"
                value={azureData.organization}
                onChange={(e) => setAzureData({ ...azureData, organization: e.target.value })}
                placeholder="Organization ID"
                hint="Required for billing"
              />
            </div>
          </div>
        )}

        {providerRegions && (
          <Select
            label="Region"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            options={providerRegions.map((r) => ({ value: r.id, label: r.label }))}
          />
        )}

        {mouseSupported && mouses.length > 0 && (
          <Select
            label="Mouse 执行节点"
            value={formData.mouseId}
            onChange={(e) => setFormData({ ...formData, mouseId: e.target.value })}
            placeholder="Spring 本机执行（默认）"
            hint="不选择时由 Spring 主机本机执行；选择后该账号的请求改由所选 Mouse 节点发出，节点离线时该账号暂不可用。"
            placeholderDisabled={false}
            options={mouses.map((mouse) => ({
              value: mouse.id,
              label: `${mouse.name}${mouse.isOnline ? " · 在线" : " · 离线"}${mouse.id === connection.mouseId ? " · 当前节点" : ""}`,
            }))}
          />
        )}

        {!isCompatible && !isAzure && !isCloudflareAi && (
          <div className="flex items-center gap-3">
            <Button onClick={handleTest} variant="secondary" disabled={testing}>
              {testing ? "Testing..." : "Test Connection"}
            </Button>
            {testResult && (
              <Badge variant={testResult === "success" ? "success" : "error"}>
                {testResult === "success" ? "Valid" : "Failed"}
              </Badge>
            )}
          </div>
        )}

        {/* Destructive action lives with the rest of the account form so the
            account list itself stays a pure management surface. */}
        {typeof onDelete === "function" && (
          <div className="flex items-center justify-between gap-3 rounded-[10px] border border-danger/30 bg-danger/[0.06] px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-medium text-danger">删除此账号</p>
              <p className="mt-0.5 text-xs text-text-muted">凭据、配额记录与熔断状态会一并移除，无法撤销。</p>
            </div>
            <Button
              variant="danger"
              size="sm"
              icon="delete"
              onClick={() => onDelete(connection)}
              disabled={saving}
              className="shrink-0"
            >
              删除
            </Button>
          </div>
        )}

        <div className="flex gap-2">
          <Button onClick={handleSubmit} fullWidth disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
          <Button onClick={onClose} variant="ghost" fullWidth>Cancel</Button>
        </div>
      </div>
    </Drawer>
  );
}

EditConnectionModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  connection: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    email: PropTypes.string,
    priority: PropTypes.number,
    authType: PropTypes.string,
    provider: PropTypes.string,
    providerSpecificData: PropTypes.object,
  }),
  // Channel-level per-account ceiling, shown as the fallback this account
  // inherits while its own override is blank.
  channelConcurrencyLimit: PropTypes.number,
  onSave: PropTypes.func.isRequired,
  onDelete: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};
