import { respondWithJSON } from "./json";
import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { mediaTypeToExt, getAssetDiskPath, getS3AssetURL } from "./assets";
import { parse } from "path";

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

  const aspectRatio = await getVideoAspectRatio(assetDiskPath);

  const prefixedFileName = `${aspectRatio}/${filename}`;

  const s3file = cfg.s3Client.file(prefixedFileName, {
    bucket: cfg.s3Bucket 
  });

  s3file.write(tempFile, {
    type: type
  });

  const assetURL = getS3AssetURL(cfg, prefixedFileName);
  video.videoURL = assetURL;

  await tempFile.delete();
  await updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}

export async function getVideoAspectRatio(filePath: string) {
  const proc = Bun.spawn([
    "ffprobe", 
    "-v", 
    "error", 
    "-select_streams", 
    "v:0", 
    "-show_entries", 
    "stream=width,height", 
    "-of", 
    "json",
    filePath
  ],{
    stdout: "pipe",
    stderr: "pipe",
  });
  
  const stdoutText = await new Response(proc.stdout).text();
  const stderrText = await new Response(proc.stderr).text();
  
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(stderrText);
  }

  const parsed = JSON.parse(stdoutText);

  if (!parsed.streams || parsed.streams.length === 0) {
    throw new Error("Stream data not found.")
  }

  const aspectData = parsed.streams[0];

  if (!aspectData.width || !aspectData.height) {
    throw new Error("Missing stream aspect ratio parameter.")
  }

  const adjustedWidth = Math.floor(16 * (aspectData.width/9));
  const adjustedHeight = Math.floor(16 * (aspectData.height/9));

  let aspectRatio;
  if (aspectData.width === adjustedHeight) {
    aspectRatio = "landscape";
  } else if (aspectData.height === adjustedWidth) {
    aspectRatio = "portrait";
  } else {
    aspectRatio = "other";
  }

  return aspectRatio;
}