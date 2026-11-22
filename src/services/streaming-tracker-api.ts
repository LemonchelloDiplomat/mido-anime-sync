import type { AnimeAgeRating, AnimeFormat, AnimeIdentity, AnimeListEntry, AnimeReleaseStatus, AnimeStatus } from "../core/types.js";
export interface YummyAccountStatus { configured:boolean; connected:boolean; username:string|null; userId:number|null; }
export interface YummyRawLists { profile:Record<string,unknown>; lists:Array<Record<string,unknown>>; entries:Array<Record<string,unknown>>; count:number; diagnostics?:{definitionsCount:number;fetchedRows:number;lists:Array<{listId:number|null;label:string;rowCount:number;skipped?:string;firstRowKeys?:string[];firstAnimeKeys?:string[];firstUserKeys?:string[];firstListKeys?:string[];definitionKeys?:string[];responseKeys?:string[]}>;definitionsKeys:string[];definitionsPayloadKeys:string[]}; }
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
 [/complete|заверш|просмотрен|completed/i,"COMPLETED"],
 [/watch|смотрю|смотрит|смотрим|watching/i,"WATCHING"],
 [/plan|later|заплан|буду смотреть|в планах/i,"PLANNING"],[/hold|pause|postpon|отлож|пауз|приостанов/i,"ON_HOLD"],
 [/drop|брос|заброш/i,"DROPPED"],[/rewatch|пересматриваю|пересмотр/i,"REWATCHING"],
];
const textValue=(...values:unknown[])=>{const value=values.find(v=>typeof v==="string"&&v.trim());return typeof value==="string"?value.trim():"";};
const numberValue=(...values:unknown[])=>{for(const value of values){const n=Number(value);if(value!==null&&value!==undefined&&value!==""&&Number.isFinite(n))return n;}return null;};
const objectValue=(value:unknown):Record<string,unknown>=>value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};
function statusFor(list:Record<string,unknown>,row:Record<string,unknown>,userList:Record<string,unknown>,listId:string):AnimeStatus|null{
 const rowStatus=objectValue(row.status);
 const listValue=objectValue(row.list);
 const label=textValue(
  list.name,list.title,list.label,list.status_name,list.slug,
  row.list_name,row.status_name,row.status,
  rowStatus.name,rowStatus.title,rowStatus.label,
  listValue.name,listValue.title,listValue.label,
  userList.list_name,
  objectValue(userList.list).title,
  objectValue(userList.list).name,
 );
 for(const [pattern,status] of STATUS_ALIASES) if(pattern.test(label)) return status;
 // Numeric IDs alone are not sufficient: custom lists can use the same IDs.
 return null;
}
function mapFormat(value:unknown):AnimeFormat|undefined{
 const normalized=String(value??"").trim().toLowerCase().replace(/[ _-]+/g,"");
 if(["tv","tvshort","series","сериал","тв","телесериал"].includes(normalized))return "TV";
 if(["movie","film","фильм","полнометражный фильм"].includes(normalized))return "MOVIE";
 if(["ova","ова"].includes(normalized))return "OVA";
 if(["ona","она"].includes(normalized))return "ONA";
 if(["special","спешл"].includes(normalized))return "SPECIAL";
 if(["music","музыкальное"].includes(normalized))return "MUSIC";
 return undefined;
}
function mapAgeRating(value:unknown,title?:unknown):AnimeAgeRating|null{
 const label=String(title??"").toLowerCase();
 const numeric=numberValue(value);
 if(/18|r\+|rx|adult|для взрослых/.test(label)||numeric!==null&&numeric>=18)return "R+";
 if(/17|r-?17|r$/.test(label)||numeric!==null&&numeric>=16)return "R17";
 if(/13|pg-?13/.test(label)||numeric!==null&&numeric>=12)return "PG13";
 if(/pg/.test(label)||numeric!==null&&numeric>=6)return "PG";
 if(/g|без ограничений/.test(label)||numeric===0)return "G";
 return null;
}
function mapReleaseStatus(value:unknown):AnimeReleaseStatus|undefined{
 const label=String(value??"").toLowerCase();
 if(/ongoing|airing|выходит/.test(label))return "ONGOING";
 if(/announc|not.?yet|анонс/.test(label))return "ANNOUNCED";
 if(/released|finished|заверш|вышел/.test(label))return "RELEASED";
 return undefined;
}
function safeDate(...values:unknown[]):string|null{
 for(const value of values){
  if(typeof value!=="string")continue;
  const match=value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(!match)continue;
  const date=new Date(value);
  if(!Number.isNaN(date.getTime()))return match[0];
 }
 return null;
}
function posterUrl(...values:unknown[]):string|null{
 const fields=["huge","fullsize","big","large","medium","original","url"];
 for(const value of values){
  const candidates=[typeof value==="string"?value:"",...fields.map(field=>objectValue(value)[field])];
  for(const candidate of candidates){
   if(typeof candidate!=="string"||!candidate.trim())continue;
   const raw=candidate.trim();
   try{const url=new URL(raw.startsWith("//")?"https:"+raw:raw);if(url.protocol==="https:"||url.protocol==="http:")return url.href;}catch{}
  }
 }
 return null;
}
/** Normalizes account rows enriched with the official /anime/{id} detail response. */
export function normalizeYummyLists(payload:YummyRawLists):Array<{anime:AnimeIdentity;entry:AnimeListEntry}>{
 const definitions=new Map<string,Record<string,unknown>>();
 for(const list of payload.lists){const id=String(list.id??list.list_id??list.listId??"");if(id)definitions.set(id,list);}
 const result:Array<{anime:AnimeIdentity;entry:AnimeListEntry}>=[];
 for(const row of payload.entries){
  const nested=objectValue(row.anime);
  const user=objectValue(row.user);
  const userList=objectValue(user.list);
  const nestedList=objectValue(userList.list);
  const listValue=objectValue(row.list);
  const id=String(row.anime_id??row.animeId??nested.anime_id??nested.id??row.id??"").trim();
  const title=textValue(nested.title,nested.name,nested.anime_title,row.title,row.name,row.anime_title);
  const listId=String(row.list_id??row.listId??listValue.id??nested.list_id??nestedList.id??"");
  const status=statusFor(definitions.get(listId)||{},row,userList,listId);
  if(!/^\d+$/.test(id)||!title||!status)continue;
  const episodeInfo=objectValue(nested.episodes);
  const year=numberValue(nested.year,row.year);
  const episodes=numberValue(episodeInfo.count,nested.episode_count,nested.episodes,row.episode_count,row.episodes);
  const rawProgress=numberValue(row.progress,row.episodes_watched,row.watched_episodes,userList.progress,userList.watched_episodes,nested.progress);
  const progress=Math.max(0,rawProgress??0);
  const rawScore=numberValue(row.score,row.rating,user.rating,user.rate,nested.user&&objectValue(nested.user).rating);
  const score=rawScore===null?null:Math.max(0,Math.min(100,rawScore<=10?rawScore*10:rawScore));
  const favoriteValue=row.favorite??nested.favorite??userList.is_fav;
  const favoriteKnown=typeof favoriteValue==="boolean";
  const poster=posterUrl(nested.poster,nested.poster_url,row.poster,row.poster_url);
  const genresRaw=Array.isArray(nested.genres)?nested.genres:Array.isArray(row.genres)?row.genres:[];
  const genres=genresRaw.map(value=>typeof value==="string"?value:textValue(objectValue(value).title,objectValue(value).name)).filter(Boolean);
  const type=objectValue(nested.type);
  const minAge=objectValue(nested.min_age);
  const animeStatus=objectValue(nested.anime_status);
  const rating=objectValue(nested.rating);
  const originalTitle=textValue(nested.original,nested.original_title,row.original_title);
  const otherTitles=Array.isArray(nested.other_titles)?nested.other_titles.filter((value):value is string=>typeof value==="string"&&Boolean(value.trim())):[];
  const startDate=safeDate(nested.start_date,nested.startDate,nested.premiere_date,nested.aired_from,row.start_date);
  const format=mapFormat(type.shortname??type.name??nested.format??row.format);
  const ageRating=mapAgeRating(minAge.value,minAge.title??minAge.titleLong);
  const releaseStatus=mapReleaseStatus(animeStatus.alias??animeStatus.title??nested.release_status);
  const averageScore=numberValue(rating.average,nested.average_score,nested.mean);
  const anime:AnimeIdentity={
   id:"yummyanime:"+id,
   titles:{romaji:title,synonyms:[originalTitle,...otherTitles].filter(Boolean)},
   externalIds:{
    yummyanime:id,
    ...(numberValue(objectValue(nested.remote_ids).myanimelist_id)!==null?{myanimelist:String(numberValue(objectValue(nested.remote_ids).myanimelist_id))}:{}),
    ...(numberValue(objectValue(nested.remote_ids).shikimori_id)!==null?{shikimori:String(numberValue(objectValue(nested.remote_ids).shikimori_id))}:{}),
   },
   year,episodes,posterUrl:poster,
   ...(format?{format}:{}),
   ...(genres.length?{genres}:{}),
   ...(ageRating?{ageRating}:{}),
   ...(averageScore!==null?{averageScore}:{}),
   ...(startDate?{startDate}:{}),
   ...(releaseStatus?{releaseStatus}:{}),
  };
  const entry:AnimeListEntry={animeId:anime.id,status,progress,score,favorite:Boolean(favoriteValue),updatedAt:textValue(row.updated_at,row.updatedAt,row.date)||new Date(0).toISOString(),source:"yummyanime",sourceMetadata:{progressKnown:rawProgress!==null,scoreKnown:rawScore!==null,favoriteKnown}};
  result.push({anime,entry});
 }
 return result;
}
