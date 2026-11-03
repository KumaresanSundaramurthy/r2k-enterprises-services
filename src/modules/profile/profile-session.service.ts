import { Injectable } from "@nestjs/common";
import { resolveCdnUrl, toInt } from "../../common/utils/php-compat";
import { SessionSyncService } from "../session-sync/session-sync.service";
import { Row } from "./profile.repository";

// Profile changes CI3 writes back into the logged-in session (refreshUserCache, _patchSignaturesJWT).
@Injectable()
export class ProfileSessionService {
  constructor(private readonly sessionSync: SessionSyncService) {}

  async refresh(sessionKey: string | undefined): Promise<void> {
    await this.sessionSync.refresh(sessionKey);
  }

  // _patchSignaturesJWT — User.Signatures in the session
  async patchSignatures(sessionKey: string | undefined, signatures: Row[]): Promise<void> {
    const list = ProfileSessionService.signatureList(signatures);
    await this.sessionSync.patch(sessionKey, (data) => ({ ...data, User: { ...data.User, Signatures: list } }));
  }

  // The signature list as the session and getSignaturesJson give it: ImgSrc is the drawing or the image's CDN URL
  static signatureList(signatures: Row[]): Row[] {
    return signatures.map((sig) => ({
      SignatureUID: toInt(sig.SignatureUID),
      Label: sig.Label,
      SignatureType: sig.SignatureType,
      ImgSrc: sig.SignatureType === "Draw" ? (sig.DrawData ?? "") : resolveCdnUrl(String(sig.ImagePath ?? "")),
      IsDefault: toInt(sig.IsDefault),
    }));
  }
}
