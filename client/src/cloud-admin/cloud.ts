import { createWorkBuddyCloud } from "@tencent-ai/workbuddy-cloud-sdk";

/**
 * 云服务公共配置(仅含可公开的前端值,不含任何密钥)。
 * 由 WorkBuddy 云服务激活时下发,服务端按 Origin 精确校验。
 */
const publicConfig = {
  resourceId: "wbcs_VPMqMsgan2AU2NyN4cE0lO",
  endpoint: "https://minigame-hub-admin.app.workbuddy.host",
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: "wbpk_lsFA9V0o0Tr3G5kNU7xq2x_O4rsYcuqY6lttDQQ4c6QCVM63KcMNmel",
};

export const cloud = createWorkBuddyCloud({
  endpoint: publicConfig.endpoint,
  oauthRelayBaseUrl: publicConfig.oauthRelayBaseUrl,
  publishableKey: publicConfig.publishableKey,
});

/**
 * 弱类型数据库门面:本项目的表结构由云端 RLS 管理,
 * 这里不做编译期 schema 约束(运行时行为完全一致)。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export const db = cloud.database as unknown as {
  from: (table: string) => any;
  rpc: (fn: string, params?: Record<string, unknown>) => Promise<{ data: any; error: any }>;
};
