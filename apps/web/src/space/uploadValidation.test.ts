import { describe, expect, it } from "vitest";
import { mediaContentType, validateRoomCapture } from "./uploadValidation";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const photo = (name = "room.jpg", size = 1, type = "image/jpeg") => ({ name, size, type });
const photos = (count = 12, size = 1) => Array.from({ length: count }, (_, index) => photo(`room-${index}.jpg`, size));

describe("room capture selection", () => {
  it("accepts 12 through 500 photos and exactly one supported video", () => {
    expect(validateRoomCapture(photos(12))).toBeUndefined();
    expect(validateRoomCapture(photos(500))).toBeUndefined();
    for (const type of ["image/jpeg", "image/png", "image/webp"]) {
      expect(validateRoomCapture(photos().map(file => ({ ...file, type })))).toBeUndefined();
    }
    for (const type of ["video/mp4", "video/quicktime", "video/webm"]) {
      expect(validateRoomCapture([photo("walkthrough.mov", 1, type)])).toBeUndefined();
    }
  });

  it("requires enough photos before starting an upload", () => {
    expect(validateRoomCapture([])).toMatch(/choose|select/i);
    expect(validateRoomCapture(photos(11))).toMatch(/12/);
    expect(validateRoomCapture(photos(501))).toMatch(/500/);
  });

  it("rejects a photo/video mixture and multiple videos", () => {
    const video = photo("room.mp4", 1, "video/mp4");
    expect(validateRoomCapture([video, ...photos()])).toMatch(/one video|single video/i);
    expect(validateRoomCapture([video, video])).toMatch(/one video|single video/i);
  });

  it("rejects formats that the room service cannot process", () => {
    expect(validateRoomCapture([...photos(11), photo("room.heic", 1, "image/heic")])).toMatch(/JPEG|PNG|WebP/);
    expect(validateRoomCapture([...photos(11), photo("room.jpg", 1, "image/gif")])).toMatch(/JPEG|PNG|WebP/);
    expect(validateRoomCapture([...photos(11), photo("room.unknown", 1, "")])).toMatch(/JPEG|PNG|WebP/);
  });

  it("uses the extension only when the browser supplies no MIME type", () => {
    expect(validateRoomCapture(photos().map(file => ({ ...file, name: "camera.JPEG", type: "" })))).toBeUndefined();
    expect(validateRoomCapture([photo("capture.MOV", 1, "")])).toBeUndefined();
    expect(mediaContentType(photo("camera.png", 1, ""))).toBe("image/png");
    expect(mediaContentType(photo("camera.jpg", 1, "image/gif"))).toBe("image/gif");
    expect(mediaContentType(photo("camera.unknown", 1, ""))).toBe("application/octet-stream");
  });

  it("accepts the per-file limits and rejects files one byte over", () => {
    expect(validateRoomCapture(photos(12, 25 * MiB))).toBeUndefined();
    expect(validateRoomCapture(photos(12, 25 * MiB + 1))).toMatch(/25 MiB/);
    expect(validateRoomCapture([photo("room.mp4", 2 * GiB, "video/mp4")])).toBeUndefined();
    expect(validateRoomCapture([photo("room.mp4", 2 * GiB + 1, "video/mp4")])).toMatch(/2 GiB/);
  });

  it("rejects captures exceeding the total limit even when each photo fits", () => {
    expect(validateRoomCapture(photos(128, 24 * MiB))).toBeUndefined();
    expect(validateRoomCapture(photos(129, 24 * MiB))).toMatch(/3 GiB/);
  });

  it("rejects empty files and invalid filenames", () => {
    expect(validateRoomCapture([...photos(11), photo("empty.jpg", 0)])).toMatch(/empty/i);
    expect(validateRoomCapture([...photos(11), photo("   ")])).toMatch(/name/i);
    expect(validateRoomCapture([...photos(11), photo("x".repeat(256))])).toMatch(/255/);
    expect(validateRoomCapture([...photos(11), photo("x".repeat(255))])).toBeUndefined();
  });
});
