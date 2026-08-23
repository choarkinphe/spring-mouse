import fs from "fs/promises";
import path from "path";
import os from "os";

export const home = () => os.homedir();

export async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8"));
  } catch {
    return null;
  }
}

export async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

export async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** 端点规范化：确保以 /v1 结尾（仅一次） */
export function withV1(url) {
  return url.endsWith("/v1") ? url : `${url}/v1`;
}

/** 去掉 /v1 后缀（Cline 需要裸地址） */
export function withoutV1(url) {
  return url.endsWith("/v1") ? url.slice(0, -3) : url;
}

export const PROVIDER_ID = "spring-mouse";
export const PROVIDER_NAME = "Spring Mouse";
/** 兼容清理历史 9router 标识 */
export const LEGACY_IDS = ["spring-mouse", "9router"];
export const LEGACY_NAMES = ["Spring Mouse", "9Router"];
