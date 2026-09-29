// Per-type metadata for backup destinations, shared by the dashboard (client)
// and the settings API (server).
//
// WHY IT LIVES IN src/shared/constants: the dashboard is a client component, so
// it cannot import src/lib/backup/litestreamConfig.js (that pulls in node:fs).
// Keeping the type table here — with no node imports — is what lets the picker
// and the server validation agree on the same field list instead of drifting.
//
// WHAT VARIES BY TYPE (verified against litestream 0.5.x docs):
//   file          no credentials
//   s3 / oss      AccessKey id + secret
//   gs            Google ADC — no credentials at all
//   abs           account name + account key
//   sftp          SSH user + password, OR a server-side private key path
//   webdav        HTTP Basic username + password
//   nats          optional username + password
// The old single "AccessKey ID / Secret" form was wrong for everything except
// s3/oss — an SFTP destination has nothing to do with an object-storage key.

export const DESTINATION_TYPES = {
  file: {
    label: "本机路径",
    hint: "默认写入本机数据目录，一键即可开启，可防误删与迁移事故。",
    configFields: [
      { key: "path", label: "备份路径", required: true, placeholder: "/absolute/path/to/backup" },
    ],
    secretFields: [],
  },
  s3: {
    label: "AWS S3 / 兼容",
    hint: "远端桶请自行开启服务端加密（S3 SSE）。",
    configFields: [
      { key: "bucket", label: "Bucket", required: true, placeholder: "my-bucket" },
      { key: "path", label: "路径前缀", placeholder: "spring-mouse" },
      { key: "region", label: "Region", placeholder: "us-east-1" },
      { key: "endpoint", label: "自定义 Endpoint", placeholder: "https://s3.example.com" },
      { key: "forcePathStyle", label: "Force path style", type: "boolean" },
    ],
    secretFields: [
      { key: "accessKeyId", label: "AccessKey ID", required: true },
      { key: "accessKeySecret", label: "AccessKey Secret", required: true, type: "password" },
    ],
  },
  oss: {
    label: "阿里云 OSS",
    hint: "远端桶请自行开启服务端加密（OSS SSE）。",
    configFields: [
      { key: "bucket", label: "Bucket", required: true, placeholder: "my-bucket" },
      { key: "path", label: "路径前缀", placeholder: "spring-mouse" },
      { key: "region", label: "Region", required: true, placeholder: "oss-cn-hangzhou" },
      { key: "endpoint", label: "自定义 Endpoint", placeholder: "https://oss-cn-hangzhou.aliyuncs.com" },
      { key: "forcePathStyle", label: "Force path style", type: "boolean" },
    ],
    secretFields: [
      { key: "accessKeyId", label: "AccessKey ID", required: true },
      { key: "accessKeySecret", label: "AccessKey Secret", required: true, type: "password" },
    ],
  },
  gs: {
    label: "Google Cloud Storage",
    hint: "使用 Google Application Default Credentials（ADC），无需填写密钥。",
    configFields: [
      { key: "bucket", label: "Bucket", required: true, placeholder: "my-bucket" },
      { key: "path", label: "路径前缀", placeholder: "spring-mouse" },
    ],
    secretFields: [],
  },
  abs: {
    label: "Azure Blob",
    hint: "Account Key 加密后仅保存在本机。",
    configFields: [
      { key: "accountName", label: "存储账户名", required: true },
      { key: "bucket", label: "容器名", required: true },
      { key: "path", label: "路径前缀", placeholder: "spring-mouse" },
      { key: "endpoint", label: "Endpoint", placeholder: "https://<account>.blob.core.windows.net" },
    ],
    secretFields: [
      { key: "accountKey", label: "Account Key", required: true, type: "password" },
    ],
  },
  sftp: {
    label: "SFTP",
    hint: "SSH 鉴权：填密码，或填服务端私钥文件路径，二者留一个即可。",
    configFields: [
      { key: "host", label: "主机", required: true, placeholder: "backup.example.com:22" },
      { key: "user", label: "SSH 用户名", required: true },
      { key: "path", label: "远端路径", required: true, placeholder: "/backups/spring-mouse" },
      { key: "keyPath", label: "私钥文件路径", placeholder: "/etc/litestream/sftp_key" },
      { key: "hostKey", label: "主机公钥", placeholder: "ssh-ed25519 AAAA…" },
    ],
    secretFields: [
      { key: "password", label: "SSH 密码", type: "password" },
    ],
  },
  webdav: {
    label: "WebDAV",
    hint: "HTTP Basic 鉴权；地址用 https:// 以便传输加密。",
    configFields: [
      { key: "webdavUrl", label: "WebDAV 地址", required: true, placeholder: "https://example.com/webdav" },
      { key: "path", label: "远端路径", required: true, placeholder: "/litestream/backups" },
    ],
    secretFields: [
      { key: "username", label: "用户名", required: true },
      { key: "password", label: "密码", required: true, type: "password" },
    ],
  },
  nats: {
    label: "NATS JetStream",
    hint: "若服务器无需鉴权可留空。",
    configFields: [
      { key: "url", label: "NATS 地址", required: true, placeholder: "nats://host:4222/bucket" },
    ],
    secretFields: [
      { key: "username", label: "用户名" },
      { key: "password", label: "密码", type: "password" },
    ],
  },
  // The pre-refactor shape: one URL string plus an optional AccessKey pair.
  // Never offered in the picker; it exists so an install that has not been
  // migrated yet still resolves and restores exactly as before.
  url: {
    label: "旧版 URL",
    hidden: true,
    configFields: [{ key: "url", label: "备份 URL", required: true }],
    secretFields: [
      { key: "accessKeyId", label: "AccessKey ID" },
      { key: "accessKeySecret", label: "AccessKey Secret", type: "password" },
    ],
  },
};

// Picker order. `url` is deliberately absent — it is a migration artifact, not
// something an operator chooses.
export const DESTINATION_TYPE_ORDER = ["file", "s3", "oss", "gs", "abs", "sftp", "webdav", "nats"];

export function getDestinationType(type) {
  return DESTINATION_TYPES[String(type ?? "")] ?? null;
}

export function destinationTypeOptions() {
  return DESTINATION_TYPE_ORDER.map((value) => ({ value, label: DESTINATION_TYPES[value].label }));
}

// Same rules on both sides of the wire: the drawer disables its save button
// with this and the API rejects with it, so the two can never disagree.
// `requireSecret: false` is the edit case — a blank secret field means "keep
// the stored one", so it must not be treated as missing.
export function validateDestination({ type, config = {}, secret = {}, requireSecret = true } = {}) {
  const spec = getDestinationType(type);
  if (!spec) return { ok: false, errors: { type: "未知的备份类型" } };
  const errors = {};
  for (const field of spec.configFields) {
    if (field.required && !String(config[field.key] ?? "").trim()) {
      errors[field.key] = `请填写${field.label}`;
    }
  }
  if (requireSecret) {
    if (type === "sftp") {
      // Either channel satisfies SSH auth.
      if (!String(secret.password ?? "").trim() && !String(config.keyPath ?? "").trim()) {
        errors.password = "请填写 SSH 密码或私钥路径";
      }
    } else {
      for (const field of spec.secretFields) {
        if (field.required && !String(secret[field.key] ?? "").trim()) {
          errors[field.key] = `请填写${field.label}`;
        }
      }
    }
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

// A URL for DISPLAY only. It reads non-secret fields and strips any userinfo,
// so it can be shown in the list and returned by the API without ever carrying
// a password — the whole reason credentials do not live in the URL.
export function stripUserInfo(url) {
  return String(url ?? "").replace(/^([a-z0-9+.-]+:\/\/)[^/@]*@/i, "$1");
}

export function describeDestination(destination) {
  const type = String(destination?.type ?? "");
  const config = destination?.config ?? {};
  const join = (base, suffix) => {
    const tail = String(suffix ?? "").trim();
    return tail ? `${base.replace(/\/$/, "")}/${tail.replace(/^\//, "")}` : base;
  };
  switch (type) {
    case "file":
      return `file://${String(config.path ?? "")}`;
    case "s3":
      return join(`s3://${String(config.bucket ?? "")}`, config.path);
    case "oss":
      return join(`oss://${String(config.bucket ?? "")}`, config.path);
    case "gs":
      return join(`gs://${String(config.bucket ?? "")}`, config.path);
    case "abs":
      return join(`abs://${String(config.accountName ?? "")}/${String(config.bucket ?? "")}`, config.path);
    case "sftp":
      return join(`sftp://${String(config.user ?? "")}@${String(config.host ?? "")}`, config.path);
    case "webdav": {
      const raw = stripUserInfo(config.webdavUrl);
      return raw ? join(raw, config.path) : "";
    }
    case "nats":
    case "url":
      return stripUserInfo(config.url);
    default:
      return "";
  }
}
