import { Request } from "express";

export interface DeviceInfo {
  deviceType: string;
  browser: string;
  os: string;
}

// Same coarse user-agent detection as CI3's Login::getDeviceInfo, so audit rows stay comparable.
export function getDeviceInfo(userAgent: string): DeviceInfo {
  const info: DeviceInfo = { deviceType: "Desktop", browser: "Unknown", os: "Unknown" };
  if (/(mobile|android|iphone|ipad)/i.test(userAgent)) info.deviceType = "Mobile";
  else if (/tablet/i.test(userAgent)) info.deviceType = "Tablet";

  if (/Chrome/i.test(userAgent)) info.browser = "Chrome";
  else if (/Firefox/i.test(userAgent)) info.browser = "Firefox";
  else if (/Safari/i.test(userAgent)) info.browser = "Safari";

  if (/Windows/i.test(userAgent)) info.os = "Windows";
  else if (/Mac OS/i.test(userAgent)) info.os = "Mac OS";
  else if (/Linux/i.test(userAgent)) info.os = "Linux";
  else if (/Android/i.test(userAgent)) info.os = "Android";
  else if (/iOS/i.test(userAgent)) info.os = "iOS";
  return info;
}

export interface RequestMeta {
  ipAddress: string;
  userAgent: string;
  device: DeviceInfo;
}

export function getRequestMeta(req: Request): RequestMeta {
  const userAgent = req.headers["user-agent"] || "";
  return { ipAddress: req.ip || "", userAgent, device: getDeviceInfo(userAgent) };
}
