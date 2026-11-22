import type { AnimeIdentity, AnimeListEntry, AnimeStatus } from "../core/types.js";
export interface YummyAccountStatus { configured:boolean; connected:boolean; username:string|null; userId:number|null; }
export interface YummyRawLists { profile:Record<string,unknown>; lists:Array<Record<string,unknown>>; entries:Array<Record<string,unknown>>; count:number; }
async function requestJson<T>(url:string,init?:RequestInit):Promise<T>{
 const response=await fetch(url,{credentials:"same-origin",cache:"no-store",...init,headers:{Accept:"application/json",...(init?.headers||{})}});
 const payload=await response.json().catch(()=>({})) as {error?:string};
 if(!response.ok) throw new Error(payload.error||"Локальный API вернул HTTP "+response.status);
 return payload as T;
}
export const yummyTrackerApi={
 status:()=>requestJson<YummyAccountStatus>("/api/yummyanime/status"),
 login:(login:string,password:string,captcha?:string)=>requestJson<{ok:true;username:string}>("/api/yummyanime/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({login,password,...(captcha?{captcha}:{})})}),
 logout:()=>requestJson<{ok:true}>("/api/yummyanime/logout",{method:"POST"}),
 lists:()=>requestJson<YummyRawLists>("/api/yummyanime/lists"),
 /** Requires an explicit target list ID. Status-to-list mapping is never guessed. */
 setList:(animeId:string,listId:number)=>requestJson<{ok:true}>("/api/yummyanime/list",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({animeId,listId})}),
 setFavorite:(animeId:string,favorite:boolean)=>requestJson<{ok:true}>("/api/yummyanime/favorite",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({animeId,favorite})}),
};
const STATUS_ALIASES:Array<[RegExp,AnimeStatus]>=[
 [/watch|смотр|просмотр/i,"WATCHING"],[/complete|заверш|просмотрено/i,"COMPLETED"],
 [/plan|later|отлож|заплан|буду смотреть/i,"PLANNING"],[/hold|pause|postpon|отлож|пауз|приостанов/i,"ON_HOLD"],
 [/drop|брос|заброш/i,"DROPPED"],[/rewatch|пересмотр/i,"REWATCHING"],
];
const textValue=(...values:unknown[])=>{const value=values.find(v=>typeof v==="string"&&v.trim());return typeof value==="string"?value.trim():"";};
const numberValue=(...values:unknown[])=>{for(const value of values){const n=Number(value);if(value!==null&&value!==undefined&&value!==""&&Number.isFinite(n))return n;}return null;};
function statusFor(list:Record<string,unknown>,row:Record<string,unknown>):AnimeStatus|null{
 const label=textValue(list.name,list.title,list.label,list.slug,row.list_name,row.status_name);
 for(const [pattern,status] of STATUS_ALIASES) if(pattern.test(label)) return status;
 return null;
}
/** Skips malformed rows and unknown list semantics instead of inventing metadata. */
export function normalizeYummyLists(payload:YummyRawLists):Array<{anime:AnimeIdentity;entry:AnimeListEntry}>{
 const definitions=new Map<string,Record<string,unknown>>();
 for(const list of payload.lists){const id=String(list.id??"");if(id)definitions.set(id,list);}
 const result:Array<{anime:AnimeIdentity;entry:AnimeListEntry}>=[];
 for(const row of payload.entries){
  const nested=row.anime&&typeof row.anime==="object"?row.anime as Record<string,unknown>:{};
  const id=textValue(row.anime_id,row.id,nested.id); const title=textValue(nested.title,nested.name,row.title,row.name);
  const listId=String(row.list_id??row.list??nested.list_id??""); const status=statusFor(definitions.get(listId)||row,row);
  if(!/^\d+$/.test(id)||!title||!status)continue;
  const year=numberValue(nested.year,row.year); const episodes=numberValue(nested.episodes,nested.episode_count,row.episodes);
  const progress=Math.max(0,numberValue(row.progress,row.episodes_watched,row.watched_episodes)??0);
  const rawScore=numberValue(row.score,row.rating); const score=rawScore===null?null:Math.max(0,Math.min(100,rawScore<=10?rawScore*10:rawScore));
  const anime:AnimeIdentity={id:"yummyanime:"+id,titles:{romaji:title,synonyms:[textValue(nested.original_title,row.original_title)].filter(Boolean)},externalIds:{yummyanime:id},year,episodes,posterUrl:textValue(nested.poster,nested.poster_url,row.poster,row.poster_url)||null};
  const entry:AnimeListEntry={animeId:anime.id,status,progress,score,favorite:Boolean(row.favorite??nested.favorite),updatedAt:textValue(row.updated_at,row.updatedAt)||new Date(0).toISOString(),source:"yummyanime"};
  result.push({anime,entry});
 }
 return result;
}
