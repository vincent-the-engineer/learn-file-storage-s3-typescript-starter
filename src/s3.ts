import { type ApiConfig } from "../config";


export async function uploadVideoToS3(
  cfg: APIConfig,
  key: string,
  filePath: string,
  contentType: string,
) {
  const s3file: S3File = cfg.s3Client.file(key, {
    bucket: cfg.s3Bucket,
  });
  const videoFile = Bun.file(filePath);
  await s3file.write(videoFile, {
    type: contentType,
  });
}

