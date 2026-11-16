import type { BodyPose, TrackedPerson, WorldFloorPoint, WorldPerson } from "./types";

/** One camera's current people. `center` is the camera's floor-plan position when its geometry is known. */
export type CameraObservation = { cameraId: string; name: string; people: (TrackedPerson & { body?: BodyPose })[]; expiresAt: number; center?: WorldFloorPoint;
  /** The camera's height above the floor, metres. */
  height?: number };
type Matrix = [number, number, number]; // Symmetric 2×2 on the floor plan: xx, xz, zz.
type Item = { key: string; camera: CameraObservation; person: CameraObservation["people"][number]; x: number; z: number; covariance: Matrix };
const invert = ([a, b, c]: Matrix): Matrix | undefined => { const determinant = a * c - b * b; return determinant > 1e-12 ? [c / determinant, -b / determinant, a / determinant] : undefined; };
/**
 * A camera measures direction far better than distance, so its error is an ellipse stretched along the viewing ray.
 * Two cameras looking from different sides have crossing ellipses, and their combination is tight in both directions.
 */
function covariance(person: TrackedPerson, center: WorldFloorPoint | undefined): Matrix {
  const estimated = person.positionMethod === "estimated", dx = center ? person.position.x - center.x : 0, dz = center ? person.position.z - center.z : 0, range = Math.hypot(dx, dz);
  if (!center || range < 0.05) { const sigma = estimated ? Math.max(0.25, person.uncertaintyMeters ?? 0.5) : 0.2; return [sigma * sigma, 0, sigma * sigma]; }
  // An estimate knows the direction to the person, not the distance: it assumes a standing adult, and someone seated or
  // lying is then placed at about half their real distance (measured 0.53 and 0.44 on a person lying on a bed, 2026-11-15),
  // with a claimed error of 0.25 m. Along the ray the estimate is therefore worth little; a second camera settles it.
  const along = estimated ? Math.max(0.25, person.uncertaintyMeters ?? 0.5, 0.9 * range) : 0.1 + 0.04 * range, across = Math.min(along, estimated ? 0.12 + 0.04 * range : 0.06 + 0.015 * range);
  const ux = dx / range, uz = dz / range, a = along * along, c = across * across;
  return [a * ux * ux + c * uz * uz, (a - c) * ux * uz, a * uz * uz + c * ux * ux];
}
const mahalanobis = (a: Item, b: Item): number => {
  const inverse = invert([a.covariance[0] + b.covariance[0], a.covariance[1] + b.covariance[1], a.covariance[2] + b.covariance[2]]), dx = a.x - b.x, dz = a.z - b.z;
  return inverse ? dx * dx * inverse[0] + 2 * dx * dz * inverse[1] + dz * dz * inverse[2] : Infinity;
};
function combine(items: Item[]): { x: number; z: number; sigma: number } {
  let information: Matrix = [0, 0, 0], bx = 0, bz = 0;
  for (const item of items) {
    const inverse = invert(item.covariance); if (!inverse) continue;
    information = [information[0] + inverse[0], information[1] + inverse[1], information[2] + inverse[2]];
    bx += inverse[0] * item.x + inverse[1] * item.z; bz += inverse[1] * item.x + inverse[2] * item.z;
  }
  const fused = invert(information);
  if (!fused) return { x: items[0].x, z: items[0].z, sigma: Math.sqrt(Math.max(items[0].covariance[0], items[0].covariance[2])) };
  // Largest eigenvalue: the remaining error along its worst direction.
  const mean = (fused[0] + fused[2]) / 2, spread = Math.hypot((fused[0] - fused[2]) / 2, fused[1]);
  return { x: fused[0] * bx + fused[1] * bz, z: fused[1] * bx + fused[2] * bz, sigma: Math.sqrt(mean + spread) };
}
type Identity = { id: number; members: Set<string>; x: number; z: number; seen: number; avatarId?: string;
  /** Per camera track: how much farther than its own estimate the person turned out to be once two cameras crossed. */
  ratios?: Map<string, number> };

/** Merges what several cameras see into one marker per person and keeps that person's number stable. */
export class PeopleFusion {
  private identities: Identity[] = [];
  private history = new Map<string, { misfit: number; seen: number }>();
  private nextId = 0;
  reset(): void { this.identities = []; this.history.clear(); this.nextId = 0; }
  update(cameras: CameraObservation[], now: number): WorldPerson[] {
    const items: Item[] = cameras.filter(camera => camera.expiresAt > now).flatMap(camera => {
      // One camera sometimes follows a person twice for a moment (a pose and a box of the same body): keep the better one.
      const rank = (person: TrackedPerson) => (person.positionMethod === "estimated" ? 0 : 10) + person.confidence, kept: CameraObservation["people"] = [];
      for (const person of camera.people.filter(person => [person.position.x, person.position.y, person.position.z].every(Number.isFinite)).sort((a, b) => rank(b) - rank(a)))
        if (!kept.some(other => Math.hypot(other.position.x - person.position.x, other.position.z - person.position.z) < 0.3)) kept.push(person);
      return kept.map(person => ({ key: `${camera.cameraId}:${person.id}`, camera, person, x: person.position.x, z: person.position.z, covariance: covariance(person, camera.center) }));
    });
    // Where the rays of a group cross must be in front of every camera, and at a distance the estimate could really stand
    // for: between 0.4 and 3.5 times the assumed one. Otherwise two different people merely lie on crossing lines.
    const consistent = (group: Item[]) => {
      const fused = combine(group);
      return group.every(item => {
        const center = item.camera.center; if (!center) return true;
        const dx = item.x - center.x, dz = item.z - center.z, range = dx * dx + dz * dz; if (range < 0.0025) return true;
        const ratio = ((fused.x - center.x) * dx + (fused.z - center.z) * dz) / range;
        return item.person.positionMethod === "estimated" ? ratio >= 0.4 && ratio <= 3.5 : ratio >= 0.7 && ratio <= 1.4;
      });
    };
    // Closest cross-camera pairs merge first. One camera never contributes two people to the same cluster.
    const cluster = items.map((_, index) => index), members = (root: number) => items.filter((_, index) => cluster[index] === root);
    const pairs = items.flatMap((a, i) => items.slice(i + 1).flatMap((b, offset) => {
      if (a.camera.cameraId === b.camera.cameraId || Math.hypot(a.x - b.x, a.z - b.z) > 4) return [];
      const distance = mahalanobis(a, b);
      return distance <= 9 && consistent([a, b]) ? [{ i, j: i + 1 + offset, distance }] : [];
    })).sort((a, b) => a.distance - b.distance);
    // With three people and two cameras the rays cross in up to nine places, and taking the closest crossing first joined
    // the wrong people in a third of the frames. Choose the pairing that is best as a whole: each match is worth a fixed
    // amount, less its misfit, and people who were one person a moment ago stay together unless the evidence is against it.
    const together = (a: Item, b: Item) => this.identities.some(identity => identity.members.has(a.key) && identity.members.has(b.key));
    // Feet seen on the floor fix a standing person exactly, and for a standing person the other camera's estimate is right
    // too. If it has to slide far along its ray to meet them, it is more likely someone else on the same line of sight.
    const slide = (a: Item, b: Item) => {
      const [fixed, loose] = a.person.positionMethod !== "estimated" ? [a, b] : [b, a], center = loose.camera.center;
      if (fixed.person.positionMethod === "estimated" || loose.person.positionMethod !== "estimated" || !center) return 0;
      const ratio = Math.hypot(fixed.x - center.x, fixed.z - center.z) / Math.max(0.05, Math.hypot(loose.x - center.x, loose.z - center.z));
      return 10 * Math.log(ratio) ** 2;
    };
    // The same two tracks fitting frame after frame is stronger evidence than one good frame: a walking person and a
    // still one cross only for a moment.
    for (const [key, record] of this.history) if (now - record.seen > 6000) this.history.delete(key);
    const fit = pairs.map(pair => {
      const a = items[pair.i], b = items[pair.j], key = `${a.key}|${b.key}`, misfit = pair.distance + slide(a, b), record = this.history.get(key);
      const smoothed = record ? record.misfit + 0.3 * (misfit - record.misfit) : misfit;
      this.history.set(key, { misfit: smoothed, seen: now });
      return smoothed;
    });
    const worth = pairs.map((pair, k) => 10 - fit[k] + (together(items[pair.i], items[pair.j]) ? 3 : 0));
    let best: number[] = [], bestWorth = 0;
    const choose = (from: number, chosen: number[], total: number) => {
      if (total > bestWorth) { bestWorth = total; best = [...chosen]; }
      for (let k = from; k < pairs.length; k++) {
        if (worth[k] <= 0) continue;
        const { i, j } = pairs[k];
        // An observation pairs with at most one observation from each other camera.
        if (chosen.some(other => { const o = pairs[other]; return [o.i, o.j].some(index => index === i && items[index === o.i ? o.j : o.i].camera.cameraId === items[j].camera.cameraId || index === j && items[index === o.i ? o.j : o.i].camera.cameraId === items[i].camera.cameraId); })) continue;
        chosen.push(k); choose(k + 1, chosen, total + worth[k]); chosen.pop();
      }
    };
    if (pairs.length <= 16) choose(0, [], 0);
    const ordered = pairs.length <= 16 ? best.map(k => pairs[k]) : pairs;
    for (const { i, j } of ordered) {
      const a = cluster[i], b = cluster[j];
      if (a === b) continue;
      const first = members(a), second = members(b);
      if (first.some(item => second.some(other => other.camera.cameraId === item.camera.cameraId))) continue;
      // Every member must be compatible, or a chain of near neighbours could join two different people.
      if (first.some(item => second.some(other => mahalanobis(item, other) > 9)) || !consistent([...first, ...second])) continue;
      cluster.forEach((root, index) => { if (root === b) cluster[index] = a; });
    }
    const groups = [...new Set(cluster)].map(members).sort((a, b) => b.length - a.length);
    this.identities = this.identities.filter(identity => now - identity.seen <= 4000);
    const taken = new Set<Identity>();
    return groups.map(group => {
      let fused = group.length > 1 ? combine(group) : { x: group[0].x, z: group[0].z, sigma: group[0].person.uncertaintyMeters ?? 0 };
      // The same camera tracks, or failing that the same spot, mean the same person as before.
      const free = this.identities.filter(identity => !taken.has(identity)), shared = (identity: Identity) => group.filter(item => identity.members.has(item.key)).length;
      let identity = free.filter(candidate => shared(candidate) > 0).sort((a, b) => shared(b) - shared(a))[0]
        ?? free.filter(candidate => Math.hypot(candidate.x - fused.x, candidate.z - fused.z) <= 0.7).sort((a, b) => Math.hypot(a.x - fused.x, a.z - fused.z) - Math.hypot(b.x - fused.x, b.z - fused.z))[0];
      const known = !!identity;
      if (!identity) { identity = { id: ++this.nextId, members: new Set(), x: fused.x, z: fused.z, seen: now }; this.identities.push(identity); }
      const along = (item: Item, point: { x: number; z: number }) => {
        const center = item.camera.center; if (!center) return undefined;
        const dx = item.x - center.x, dz = item.z - center.z, range = dx * dx + dz * dz;
        return range < 0.0025 ? undefined : ((point.x - center.x) * dx + (point.z - center.z) * dz) / range;
      };
      if (group.length > 1) {
        // Two cameras have just measured how far this person really is along each one's line of sight...
        for (const item of group) { const ratio = item.person.positionMethod === "estimated" ? along(item, fused) : undefined; if (ratio) (identity.ratios ??= new Map()).set(item.key, ratio); }
      } else {
        // ...so when one of them loses the person for a moment, the other keeps placing them at that distance instead
        // of jumping back to its own guess (0.9 m off for someone lying on a bed).
        const item = group[0], ratio = item.person.positionMethod === "estimated" ? identity.ratios?.get(item.key) : undefined, center = item.camera.center;
        if (ratio && center) fused = { x: center.x + (item.x - center.x) * ratio, z: center.z + (item.z - center.z) * ratio, sigma: fused.sigma };
      }
      // Ease towards the new fix unless the person has clearly moved: the set of cameras behind a marker changes from frame to frame.
      if (known && Math.hypot(fused.x - identity.x, fused.z - identity.z) < 1) fused = { x: identity.x + 0.7 * (fused.x - identity.x), z: identity.z + 0.7 * (fused.z - identity.z), sigma: fused.sigma };
      taken.add(identity); identity.members = new Set(group.map(item => item.key)); identity.x = fused.x; identity.z = fused.z; identity.seen = now;
      const floor = group.some(item => item.person.positionMethod !== "estimated"), best = group.reduce((a, b) => a.covariance[0] + a.covariance[2] <= b.covariance[0] + b.covariance[2] ? a : b);
      // Calibration errors are shared between frames, so two cameras never justify a claim finer than about a decimetre.
      const uncertaintyMeters = floor ? undefined : group.length > 1 ? Math.min(3, Math.max(0.1, fused.sigma + 0.05)) : best.person.uncertaintyMeters;
      const source = group.length > 1 ? `${group.length} cameras` : best.camera.name;
      // Any camera that saw the face names the person for all of them; the name then stays while the person is followed.
      const named = group.filter(item => item.person.avatarId).sort((a, b) => a.covariance[0] + a.covariance[2] - b.covariance[0] - b.covariance[2])[0]?.person.avatarId;
      if (named) identity.avatarId = named;
      const avatarId = identity.avatarId;
      // Two cameras crossing fix the distance of someone seen only as a box, and with it how high their head really is.
      const crowns = group.flatMap(item => {
        const top = item.camera.height, slope = item.person.crownSlope, center = item.camera.center, placed = group.length > 1 || identity.ratios?.has(item.key);
        return item.person.crownHeight !== undefined ? [item.person.crownHeight] : placed && slope !== undefined && top && center ? [top - Math.hypot(fused.x - center.x, fused.z - center.z) * slope] : [];
      });
      return {
        crownHeight: crowns.length ? Math.min(...crowns) : undefined,
        id: `person:${identity.id}`, label: `Human ${identity.id}${avatarId ? " - Recognized" : ""} - ${source}${floor ? "" : ` - Estimated +/- ${(uncertaintyMeters ?? 0).toFixed(1)} m`}`, avatarId,
        position: { x: fused.x, y: best.person.position.y, z: fused.z }, confidence: Math.min(0.99, 1 - group.reduce((miss, item) => miss * (1 - item.person.confidence), 1)),
        expiresAt: Math.max(...group.map(item => item.camera.expiresAt)), positionMethod: floor ? "floor" as const : "estimated" as const, uncertaintyMeters,
        body: group.filter(item => item.person.body).sort((a, b) => a.covariance[0] + a.covariance[2] - b.covariance[0] - b.covariance[2])[0]?.person.body, cameras: group.length,
      };
    });
  }
}

const pools = new Map<string, SharedPeople>();
/**
 * One pool per room for the whole browser tab. The room viewer reads it directly: the server relays positions only, so
 * people seen by this browser's own cameras kept their place there but never repeated a movement.
 */
export const sharedPeople = (jobId: string): SharedPeople => { let pool = pools.get(jobId); if (!pool) { pool = new SharedPeople(); pools.set(jobId, pool); } return pool; };
/** The cameras running in this browser report here, so every room view shows their combined people. */
export class SharedPeople {
  private fusion = new PeopleFusion();
  private latest = new Map<string, CameraObservation>();
  private listeners = new Set<() => void>();
  report(source: string, observation: CameraObservation | null): void {
    if (observation) this.latest.set(source, observation); else if (!this.latest.delete(source)) return;
    this.listeners.forEach(listener => listener());
  }
  people(now: number): WorldPerson[] { return this.fusion.update(this.observations(now), now); }
  /** What each camera in this browser currently sees, body poses included. */
  observations(now: number): CameraObservation[] {
    for (const [source, observation] of this.latest) if (observation.expiresAt <= now) this.latest.delete(source);
    return [...this.latest.values()];
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
}
