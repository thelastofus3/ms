import fs from "node:fs";
import validator from "gltf-validator";
const filename = process.argv[2] ?? "public/demo/avatar.glb";
const report = await validator.validateBytes(
  new Uint8Array(fs.readFileSync(filename)),
);
console.log(JSON.stringify(report.issues, null, 2));
process.exitCode = report.issues.numErrors ? 1 : 0;
