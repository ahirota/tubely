import { respondWithJSON } from "./json";
import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { mediaTypeToExt, getAssetDiskPath, getS3AssetURL } from "./assets";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }
  if (video.userID !== userID) {
    throw new UserForbiddenError("You do not have access to edit this video");
  }

  const formData = await req.formData();
  const file = formData.get("video");
  if (!(file instanceof File)) {
    throw new BadRequestError("Video file missing");
  }

  const MAX_UPLOAD_SIZE = 1 << 30;
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Video file size must be < 1GB");
  }

  const type = file.type;
  if (!type) {
    throw new BadRequestError("Missing Content-Type for Video");
  }
  if (type !== "video/mp4") {
    throw new BadRequestError("Invalid Content-Type for Video");
  }

  const ext = mediaTypeToExt(type);
  const filename = `${videoId}${ext}`;

  const assetDiskPath = getAssetDiskPath(cfg, filename);
  await Bun.write(assetDiskPath, file);
  const tempFile = Bun.file(assetDiskPath)

  const s3file = cfg.s3Client.file(filename, {
    bucket: cfg.s3Bucket 
  });

  s3file.write(tempFile, {
    type: type
  });

  const assetURL = getS3AssetURL(cfg, filename);
  video.videoURL = assetURL;

  await tempFile.delete();
  await updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}
