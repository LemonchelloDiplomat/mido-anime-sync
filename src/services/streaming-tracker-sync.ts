import type { AnimeIdentity, AnimeListEntry, AnimeStatus } from "../core/types.js";
import type { StreamingProviderId } from "./streaming-provider.js";
export type TrackerField = "status" | "progress" | "score" | "favorite";
export interface TrackerConflict { animeId: string; field: TrackerField; localValue: unknown; remoteValue: unknown; baselineValue: unknown; }
export interface TrackerChange { animeId: string; externalId: string; fields: TrackerField[]; entry: AnimeListEntry; }
export interface TrackerSyncPlan {
  provider: StreamingProviderId; remoteUpdates: TrackerChange[]; localUpdates: TrackerChange[];
  conflicts: TrackerConflict[]; unmatchedRemote: AnimeIdentity[]; unmatchedLocal: AnimeIdentity[];
  unchanged: number; deletions: [];
}
const FIELDS: readonly TrackerField[] = ["status", "progress", "score", "favorite"];
const normalize = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function variants(anime: AnimeIdentity): string[] {
  return [anime.titles.english, anime.titles.romaji, anime.titles.native, ...anime.titles.synonyms]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}
function similarity(a: string, b: string): number {
  const left = normalize(a); const right = normalize(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const grams = (value: string) => new Set(Array.from({ length: Math.max(0, value.length - 1) }, (_, i) => value.slice(i, i + 2)));
  const x = grams(" " + left + " "); const y = grams(" " + right + " ");
  let overlap = 0; for (const gram of x) if (y.has(gram)) overlap += 1;
  return x.size + y.size ? 2 * overlap / (x.size + y.size) : 0;
}
export function findExactTrackerMatch(incoming: AnimeIdentity, local: readonly AnimeIdentity[], provider: StreamingProviderId): AnimeIdentity | null {
  const id = incoming.externalIds[provider]; if (!id) return null;
  const matches = local.filter(item => item.externalIds[provider] === id);
  return matches.length === 1 ? matches[0]! : null;
}
export interface TrackerMatchSuggestion { anime: AnimeIdentity; score: number; }
export function suggestTrackerMatches(incoming: AnimeIdentity, local: readonly AnimeIdentity[], limit = 5): TrackerMatchSuggestion[] {
  return local.map(anime => {
    if (incoming.year != null && anime.year != null && Math.abs(incoming.year - anime.year) > 1) return { anime, score: 0 };
    if (incoming.format && anime.format && incoming.format !== "UNKNOWN" && anime.format !== "UNKNOWN" && incoming.format !== anime.format) return { anime, score: 0 };
    return { anime, score: Math.max(0, ...variants(incoming).flatMap(a => variants(anime).map(b => similarity(a, b)))) };
  }).filter(item => item.score >= 0.72).sort((a,b) => b.score-a.score).slice(0, Math.max(0, limit));
}
/** Conservative field-level three-way plan. It never performs writes or infers deletions. */
export function createStreamingTrackerSyncPlan(
  provider: StreamingProviderId,
  local: readonly { anime: AnimeIdentity; entry?: AnimeListEntry; baseline?: AnimeListEntry }[],
  remote: readonly { anime: AnimeIdentity; entry: AnimeListEntry }[],
): TrackerSyncPlan {
  const localById = new Map<string, typeof local[number]>(); const remoteById = new Map<string, typeof remote[number]>();
  for (const item of local) { const id=item.anime.externalIds[provider]; if (!id) continue; if(localById.has(id)) throw new Error("Duplicate local external ID: "+id); localById.set(id,item); }
  for (const item of remote) { const id=item.anime.externalIds[provider]; if (!id) continue; if(remoteById.has(id)) throw new Error("Duplicate remote external ID: "+id); remoteById.set(id,item); }
  const plan: TrackerSyncPlan = { provider, remoteUpdates:[], localUpdates:[], conflicts:[], unmatchedRemote:[], unmatchedLocal:[], unchanged:0, deletions:[] };
  for (const [externalId, item] of localById) {
    if (!item.entry) continue;
    const other=remoteById.get(externalId);
    if (!other) { plan.unmatchedLocal.push(item.anime); continue; }
    const desired={...item.entry}; const toLocal:TrackerField[]=[]; const toRemote:TrackerField[]=[]; let touched=0;
    for (const field of FIELDS) {
      const lv=item.entry[field]; const rv=other.entry[field]; if(Object.is(lv,rv)) continue; touched++;
      if(item.baseline) {
        const bv=item.baseline[field]; const lc=!Object.is(lv,bv); const rc=!Object.is(rv,bv);
        if(lc&&rc) { plan.conflicts.push({animeId:item.anime.id,field,localValue:lv,remoteValue:rv,baselineValue:bv}); continue; }
        if(rc) { (desired as unknown as Record<string,unknown>)[field]=rv; toLocal.push(field); } else if(lc) toRemote.push(field);
      } else {
        const lt=Date.parse(item.entry.updatedAt); const rt=Date.parse(other.entry.updatedAt);
        if(!Number.isFinite(lt)||!Number.isFinite(rt)||Math.abs(lt-rt)<=1000) plan.conflicts.push({animeId:item.anime.id,field,localValue:lv,remoteValue:rv,baselineValue:undefined});
        else if(rt>lt) { (desired as unknown as Record<string,unknown>)[field]=rv; toLocal.push(field); } else toRemote.push(field);
      }
    }
    if(plan.conflicts.some(conflict=>conflict.animeId===item.anime.id)) continue;
    if(!touched) { plan.unchanged++; continue; }
    if(toLocal.length) plan.localUpdates.push({animeId:item.anime.id,externalId,fields:toLocal,entry:{...desired,animeId:item.anime.id,source:provider}});
    if(toRemote.length) plan.remoteUpdates.push({animeId:item.anime.id,externalId,fields:toRemote,entry:{...desired,animeId:item.anime.id,source:provider}});
  }
  for(const [externalId,item] of remoteById) if(!localById.has(externalId)) plan.unmatchedRemote.push(item.anime);
  return plan;
}
export const STREAMING_TRACKER_STATUS_VALUES: readonly AnimeStatus[] = ["PLANNING","WATCHING","COMPLETED","ON_HOLD","DROPPED","REWATCHING"];
