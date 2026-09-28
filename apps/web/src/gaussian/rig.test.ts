import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { GaussianRig, validateManifest } from "./rig";

const rig = {
  parents: [-1, 0],
  names: ["root", "child"],
  rest_joints: [
    [0, 0, 0],
    [1, 0, 0],
  ],
  canonical_axis_angles: [
    [0, 0, Math.PI / 2],
    [0, 0, 0],
  ],
};
describe("Gaussian skeletal transforms", () => {
  it("canonical pose leaves splats unchanged", () => {
    const matrices = new GaussianRig(rig).matrices(rig.canonical_axis_angles);
    for (const matrix of matrices) {
      expect(
        new Vector3(0.4, 0.8, 0.2)
          .applyMatrix4(matrix)
          .distanceTo(new Vector3(0.4, 0.8, 0.2)),
      ).toBeLessThan(1e-8);
    }
  });
  it("undoing canonical root rotation moves a child from y to x", () => {
    const matrices = new GaussianRig(rig).matrices([
      [0, 0, 0],
      [0, 0, 0],
    ]);
    expect(
      new Vector3(0, 1, 0)
        .applyMatrix4(matrices[1])
        .distanceTo(new Vector3(1, 0, 0)),
    ).toBeLessThan(1e-8);
  });
  it("rejects nonfinite joints and cyclic hierarchies", () => {
    expect(() => new GaussianRig({ ...rig, parents: [-1, 1] })).toThrow();
    expect(
      () =>
        new GaussianRig({
          ...rig,
          rest_joints: [
            [0, 0, 0],
            [NaN, 0, 0],
          ],
        }),
    ).toThrow();
  });
  it("rejects oversized packages and arbitrary asset paths", () => {
    expect(() =>
      validateManifest({
        schema_version: 1,
        representation: "gaussian-rig",
        num_splats: 50000000,
        rig,
      }),
    ).toThrow();
    expect(() =>
      validateManifest({
        schema_version: 1,
        representation: "gaussian-rig",
        num_splats: 2,
        rig,
        model: "../../secret",
      }),
    ).toThrow();
  });
});
