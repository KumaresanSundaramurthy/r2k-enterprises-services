import { Injectable, Logger } from "@nestjs/common";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { imageMimeType } from "../../common/utils/image-info";
import { resolveCdnUrl } from "../../common/utils/php-compat";

// Every object goes under this prefix (CI3 'user_uploads/' . $Path)
const KEY_PREFIX = "user_uploads/";

export interface UploadResult {
  // Object key, e.g. user_uploads/customers/attachments/12/file.png — what the tables store (with a leading "/")
  Path: string;
  // Public URL through the CDN
  FullPath: string;
}

/**
 * File storage (CI3 Fileupload library): Cloudflare R2 or Amazon S3 through the S3 API, chosen by FILE_UPLOAD.
 *   cloudflare → CFLARE_ENDPOINT, CFLARE_ACC_KEY, CFLARE_SECRET
 *   amazonaws  → AWS_KEY, AWS_SECRET (region ap-south-1)
 * Both use the bucket AWS_BUCKET_NAME.
 */
@Injectable()
export class FileUploadService {
  private readonly logger = new Logger(FileUploadService.name);
  private client: S3Client | null = null;

  /**
   * Stores the content at user_uploads/{path}, publicly readable. The content type is read from the content
   * itself for images (like PHP mime_content_type), otherwise the one given. Throws when the upload fails.
   */
  async upload(path: string, body: Buffer, contentType = "application/octet-stream"): Promise<UploadResult> {
    const key = KEY_PREFIX + path.replace(/^\/+/, "");
    try {
      await this.s3().send(
        new PutObjectCommand({
          Bucket: this.bucket(),
          Key: key,
          Body: body,
          ContentType: imageMimeType(body) ?? contentType,
          ACL: "public-read",
        })
      );
    } catch (err) {
      this.logger.error(`Upload of ${key} failed: ${(err as Error).message}`);
      throw err;
    }
    return { Path: key, FullPath: resolveCdnUrl(key) };
  }

  private bucket(): string {
    const bucket = process.env.AWS_BUCKET_NAME;
    if (!bucket) throw new Error("AWS_BUCKET_NAME is not set.");
    return bucket;
  }

  private s3(): S3Client {
    if (this.client) return this.client;
    const provider = process.env.FILE_UPLOAD;
    if (provider === "amazonaws") {
      this.client = new S3Client({
        region: "ap-south-1",
        credentials: { accessKeyId: process.env.AWS_KEY || "", secretAccessKey: process.env.AWS_SECRET || "" },
      });
    } else if (provider === "cloudflare") {
      this.client = new S3Client({
        region: "auto",
        endpoint: process.env.CFLARE_ENDPOINT,
        credentials: { accessKeyId: process.env.CFLARE_ACC_KEY || "", secretAccessKey: process.env.CFLARE_SECRET || "" },
        // Send checksums only when an operation requires them, which R2 accepts for every operation
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      });
    } else {
      throw new Error("FILE_UPLOAD must be 'cloudflare' or 'amazonaws'.");
    }
    return this.client;
  }
}
