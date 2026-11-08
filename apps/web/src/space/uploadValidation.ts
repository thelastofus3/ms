type CaptureFile = Pick<File, "name" | "size" | "type">;
export function validatePlyUpload(files: readonly CaptureFile[]): string | undefined {
  if (files.length !== 1) return "Choose exactly one Gaussian PLY file.";
  const file = files[0];
  if (!file.name.trim() || file.name.length > 255 || !/\.ply$/i.test(file.name)) return "Choose a Gaussian PLY file with a .ply extension.";
  if (!Number.isFinite(file.size) || file.size <= 0) return "The PLY file is empty. Choose a file containing Gaussian data.";
  if (file.size > 1024 ** 3) return "The PLY file exceeds 1 GiB. Choose a smaller file.";
  return undefined;
}
const photoTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const videoTypes = new Set(["video/mp4", "video/quicktime", "video/webm"]);
const extensionTypes: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
};

export function mediaContentType(file: Pick<File, "name" | "type">): string {
  return file.type || extensionTypes[file.name.split(".").pop()?.toLowerCase() ?? ""] || "application/octet-stream";
}

export function validateRoomCapture(files: readonly CaptureFile[]): string | undefined {
  if (!files.length) return "Choose 12–500 overlapping photos or one video.";
  if (files.length > 500) return "Choose at most 500 photos for one room capture.";
  let total = 0, videos = 0;
  for (const file of files) {
    if (!file.name.trim() || file.name.length > 255) return "Each file needs a name of 1–255 characters. Rename the file and select it again.";
    if (!Number.isFinite(file.size) || file.size <= 0) return `“${file.name}” is empty. Remove it or choose a file with capture data.`;
    const type = mediaContentType(file), video = videoTypes.has(type);
    if (!video && !photoTypes.has(type)) return `“${file.name}” is unsupported. Use JPEG, PNG or WebP photos, or an MP4, MOV or WebM video.`;
    if (file.size > (video ? 2 * 1024 ** 3 : 25 * 1024 ** 2)) return `“${file.name}” exceeds the ${video ? "2 GiB video" : "25 MiB photo"} limit. Choose a smaller file.`;
    total += file.size;
    if (video) videos++;
  }
  if (videos && files.length !== 1) return "Choose one video on its own, or a set of photos. Videos and photos cannot be combined.";
  if (!videos && files.length < 12) return "Choose at least 12 overlapping photos, or one video.";
  if (total > 3 * 1024 ** 3) return "The capture exceeds 3 GiB total. Choose fewer or smaller photos.";
  return undefined;
}
