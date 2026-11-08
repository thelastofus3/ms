import { expect, it } from "vitest";
import * as validation from "./uploadValidation";

it("accepts one nonempty Gaussian PLY up to the inclusive 1 GiB limit", () => {
  expect(validation.validatePlyUpload([{ name: "scene.PLY", size: 1024 ** 3, type: "" }])).toBeUndefined();
});
it("rejects non-PLY, extra files, empty files and over-limit uploads before PUT", () => {
  const ply = { name: "scene.ply", size: 1, type: "application/octet-stream" };
  expect(validation.validatePlyUpload([])).toBeTruthy();
  expect(validation.validatePlyUpload([ply, ply])).toBeTruthy();
  expect(validation.validatePlyUpload([{ ...ply, name: "scene.splat" }])).toBeTruthy();
  expect(validation.validatePlyUpload([{ ...ply, size: 0 }])).toBeTruthy();
  expect(validation.validatePlyUpload([{ ...ply, size: 1024 ** 3 + 1 }])).toBeTruthy();
});
