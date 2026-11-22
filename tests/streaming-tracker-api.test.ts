import {describe,expect,it} from "vitest";
import {normalizeYummyLists} from "../src/services/streaming-tracker-api.js";
describe("YummyAnime tracker normalization",()=>{
 it("normalizes only rows with a recognized list label",()=>{const result=normalizeYummyLists({profile:{},lists:[{id:1,name:"Watching"},{id:2,name:"Completed"},{id:3,name:"Custom shelf"}],entries:[{anime_id:10,list_id:1,title:"One",episodes_watched:4},{anime_id:11,list_id:2,title:"Two",score:8},{anime_id:12,list_id:3,title:"Three"}],count:3});expect(result).toHaveLength(2);expect(result[0]?.entry.status).toBe("WATCHING");expect(result[0]?.entry.progress).toBe(4);expect(result[1]?.entry.status).toBe("COMPLETED");expect(result[1]?.entry.score).toBe(80);});
 it("recognizes flattened server rows with nested anime and user metadata",()=>{
  const result=normalizeYummyLists({profile:{},lists:[{id:0,name:"Смотрю"}],entries:[{
   list_id:0,
   anime:{anime_id:77,title:"Nested title",year:2025,poster:{huge:"https://img.example/poster.jpg"}},
   user:{rate:8,list:{progress:6,is_fav:true}},
  }],count:1});
  expect(result).toHaveLength(1);
  expect(result[0]?.anime).toMatchObject({id:"yummyanime:77",titles:{romaji:"Nested title"},year:2025,posterUrl:"https://img.example/poster.jpg"});
  expect(result[0]?.entry).toMatchObject({status:"WATCHING",progress:6,score:80,favorite:true});
 });
 it("maps known YummyAnime system list IDs when the list label is localized or missing",()=>{
  const result=normalizeYummyLists({profile:{},lists:[{id:0,name:"Список 0"},{id:2,name:""}],entries:[
   {anime_id:21,list_id:0,title:"Watching by ID"},
   {anime_id:22,list_id:2,title:"Completed by ID"},
  ],count:2});
  expect(result.map(row=>row.entry.status)).toEqual(["WATCHING","COMPLETED"]);
 });
 it("marks omitted source fields as unknown so imports can preserve prior values",()=>{const result=normalizeYummyLists({profile:{},lists:[{id:1,name:"Watching"}],entries:[{anime_id:9,list_id:1,title:"Unknown fields"}],count:1});expect(result[0]?.entry.sourceMetadata).toEqual({progressKnown:false,scoreKnown:false,favoriteKnown:false});});
 it("skips malformed rows instead of inventing IDs or titles",()=>{expect(normalizeYummyLists({profile:{},lists:[{id:1,name:"Watching"}],entries:[{list_id:1,title:"No ID"},{anime_id:2,list_id:1}],count:2})).toEqual([]);});
});
