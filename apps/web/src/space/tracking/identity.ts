import type { FaceMatch } from "./faces";

// Measured through the live pipeline (pose → head crop → descriptor) on a 24-view capture against unrelated faces: the owner
// scored 0.17–0.36 with a head of 24 px or more and up to 0.66 at 17–20 px; other people never came closer than 0.58.
export const MIN_FACE_PIXELS = 16;
const STRONG = 0.4, ACCEPT = 0.48, MARGIN = 0.06, VOTES = 2;
const RETRY_MS = 700, VERIFY_MS = 6000, FORGET_MS = 4000;
type Record = { votes: Map<string, { count: number; best: number }>; identity?: string; best: number; attemptAt: number; seenAt: number; against: number };

/**
 * Decides who a tracked person is from a series of face matches. One look can be wrong, so an identity needs either a
 * very close match or two agreeing ones, and once given it survives turned heads and hidden faces for the life of the track.
 */
export class FaceIdentifier {
  private records = new Map<string, Record>();
  /** Changes whenever track numbers start over, so a face still being analysed is not credited to a new person. */
  epoch = 0;
  reset(): void { this.records.clear(); this.epoch++; }
  private record(track: string, now: number): Record {
    let record = this.records.get(track);
    if (!record) { record = { votes: new Map(), best: Infinity, attemptAt: -Infinity, seenAt: now, against: 0 }; this.records.set(track, record); }
    return record;
  }
  /** Call once per frame with the tracks currently visible; forgets the ones that are gone. */
  seen(tracks: string[], now: number): void {
    for (const track of tracks) this.record(track, now).seenAt = now;
    for (const [track, record] of this.records) if (now - record.seenAt > FORGET_MS) this.records.delete(track);
  }
  /** Unknown people are looked at often; known ones are only re-checked now and then. */
  due(track: string, now: number): boolean {
    const record = this.record(track, now);
    return now - record.attemptAt >= (record.identity ? VERIFY_MS : RETRY_MS);
  }
  attempted(track: string, now: number): void { this.record(track, now).attemptAt = now; }
  /** `match` is the gallery's closest avatar for a face of this track, or undefined when the face matched nobody. */
  observe(track: string, match: FaceMatch | undefined, now: number): void {
    const record = this.record(track, now);
    const accepted = match && match.distance <= ACCEPT && match.margin >= MARGIN ? match : undefined;
    if (!accepted) {
      // A clearly different face, twice in a row, withdraws an identity; a merely poor look does not.
      if (record.identity && match && match.distance > ACCEPT + 0.1 && ++record.against >= 2) { record.identity = undefined; record.votes.clear(); record.best = Infinity; record.against = 0; }
      return;
    }
    const vote = record.votes.get(accepted.avatarId) ?? { count: 0, best: Infinity };
    vote.count++; vote.best = Math.min(vote.best, accepted.distance); record.votes.set(accepted.avatarId, vote);
    if (accepted.avatarId === record.identity) { record.against = 0; record.best = Math.min(record.best, accepted.distance); return; }
    const confirmed = accepted.distance <= STRONG || vote.count >= VOTES;
    if (!confirmed) return;
    // Changing an existing identity takes clearly better evidence than the one it replaces.
    if (record.identity && !(vote.best < record.best - 0.03 && vote.count >= VOTES)) return;
    record.identity = accepted.avatarId; record.best = vote.best; record.against = 0;
    // One avatar belongs to one person: whoever matches it less well gives it up.
    for (const [other, rival] of this.records) if (other !== track && rival.identity === accepted.avatarId) {
      if (rival.best <= record.best) { record.identity = undefined; return; }
      rival.identity = undefined; rival.votes.delete(accepted.avatarId); rival.best = Infinity;
    }
  }
  identity(track: string): string | undefined { return this.records.get(track)?.identity; }
}
